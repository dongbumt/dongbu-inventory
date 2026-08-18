import { createClient } from "@supabase/supabase-js";

interface LookupRequest {
  sessionToken?: string;
  traceNo?: string;
  permissionAction?: "create" | "update";
}

interface ErpSession {
  ok?: boolean;
  user?: {
    id?: string;
    loginId?: string;
    displayName?: string;
    roleCode?: string;
  };
  permissions?: Array<{
    menuCode?: string;
    canCreate?: boolean;
    canUpdate?: boolean;
  }>;
}

const ALLOWED_ORIGINS = new Set([
  "https://dongbumt.github.io",
  "http://localhost",
  "http://127.0.0.1",
]);

function allowedOrigin(req: Request) {
  const origin = req.headers.get("origin") || "";
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return !origin || ALLOWED_ORIGINS.has(origin) || local;
}

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) || local
      ? origin
      : "https://dongbumt.github.io",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function json(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(req) });
}

function cleanTraceNo(value: unknown) {
  return String(value || "").trim().replace(/[\s-]+/g, "").toUpperCase();
}

function isoDate(value: unknown) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})[-./]?(\d{2})[-./]?(\d{2})$/);
  if (!match) return "";
  const normalized = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${normalized}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized
    ? ""
    : normalized;
}

function permissionGranted(session: ErpSession, action: "create" | "update") {
  const row = (session.permissions || []).find((item) => item?.menuCode === "transactions");
  return action === "update" ? row?.canUpdate === true : row?.canCreate === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }
  if (req.method !== "POST") return json(req, 405, { error: "POST 요청만 지원합니다." });
  if (!allowedOrigin(req)) return json(req, 403, { error: "허용되지 않은 호출 출처입니다." });

  let payload: LookupRequest;
  try {
    payload = await req.json();
  } catch {
    return json(req, 400, { error: "요청 형식이 올바르지 않습니다." });
  }

  const sessionToken = String(payload.sessionToken || "").trim();
  const traceNo = cleanTraceNo(payload.traceNo);
  const permissionAction = payload.permissionAction === "update" ? "update" : "create";
  if (!sessionToken) return json(req, 401, { error: "개인 사용자 로그인이 필요합니다." });
  if (!/^[0-9A-Z]{10,30}$/.test(traceNo)) {
    return json(req, 400, { error: "수입육 이력번호를 확인해주세요." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const systemId = String(Deno.env.get("MEATWATCH_SYS_ID") || "").trim();
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json(req, 503, { error: "ERP 서버 설정을 확인해주세요." });
  }
  if (!systemId) {
    return json(req, 503, { error: "MeatWatch 조회 시스템 식별자가 설정되지 않았습니다." });
  }

  const publicClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: sessionData, error: sessionError } = await publicClient.rpc("dbmt_erp_session", {
    p_token: sessionToken,
  });
  const session = (sessionData || {}) as ErpSession;
  if (sessionError || session.ok !== true) {
    return json(req, 401, { error: "개인 사용자 로그인이 만료되었습니다. 다시 로그인해주세요." });
  }
  if (!permissionGranted(session, permissionAction)) {
    return json(req, 403, { error: "거래내역을 입력하거나 수정할 권한이 없습니다." });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response: Response;
  try {
    const endpoint = `https://www.meatwatch.go.kr/rest/selectDistbHistInfoWsrvDetail/${encodeURIComponent(systemId)}/${encodeURIComponent(traceNo)}/list.do`;
    response = await fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof DOMException && error.name === "AbortError"
      ? "MeatWatch 조회 시간이 초과되었습니다."
      : "MeatWatch 서버에 연결하지 못했습니다.";
    return json(req, 502, { error: message });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    return json(req, 502, { error: `MeatWatch 조회 오류 (${response.status})` });
  }

  let source: Record<string, unknown>;
  try {
    source = await response.json();
  } catch {
    return json(req, 502, { error: "MeatWatch 응답 형식을 확인할 수 없습니다." });
  }
  if (String(source.returnCode ?? "") !== "0") {
    return json(req, 404, { error: String(source.returnMsg || "조회 결과가 없습니다.") });
  }
  const sourceBeginDate = isoDate(source.prcssBeginDe);
  const sourceEndDate = isoDate(source.prcssEndDe);
  const validProcessDates = [sourceBeginDate, sourceEndDate].filter(Boolean).sort();
  const processBeginDate = validProcessDates[0] || "";
  const processEndDate = validProcessDates.at(-1) || "";
  if (!processBeginDate) {
    return json(req, 404, { error: "조회 결과에 수출국 가공 시작일이 없습니다." });
  }

  const queriedAt = new Date().toISOString();
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const user = session.user || {};
  const { error: auditError } = await serviceClient.from("change_logs").insert({
    entity: "MeatWatch",
    action: "조회",
    entity_id: traceNo,
    summary: `수입육 가공일 조회: ${traceNo} / ${processBeginDate}`,
    payload: {
      traceNo,
      processBeginDate,
      processEndDate,
      queriedAt,
      authMode: "personal_session",
      userId: user.id || "",
      loginId: user.loginId || "",
      displayName: user.displayName || "",
      roleCode: user.roleCode || "",
    },
  });
  if (auditError) console.error("MeatWatch lookup audit failed", auditError.message);

  return json(req, 200, {
    ok: true,
    traceNo,
    processBeginDate,
    processEndDate,
    queriedAt,
  });
});
