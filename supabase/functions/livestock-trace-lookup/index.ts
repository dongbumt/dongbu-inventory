import { createClient } from "@supabase/supabase-js";

interface LookupRequest {
  sessionToken?: string;
  traceNo?: string;
  speciesHint?: "cattle" | "pig";
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

type TraceRow = Record<string, string> & { _optionNo?: string };

interface OptionResult {
  ok: boolean;
  optionNo: number;
  code: string;
  message: string;
  rows: TraceRow[];
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

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function tagText(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_.-]+:)?${tag}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function itemRows(xml: string, optionNo: number) {
  const rows: TraceRow[] = [];
  const pattern = /<(?:[A-Za-z0-9_.-]+:)?item(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?item>/gi;
  for (const match of xml.matchAll(pattern)) {
    const row: TraceRow = { _optionNo: String(optionNo) };
    const fieldPattern = /<([A-Za-z0-9_.:-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
    for (const field of match[1].matchAll(fieldPattern)) {
      const name = field[1].includes(":") ? field[1].split(":").at(-1) || field[1] : field[1];
      row[name] = decodeXml(field[2]);
    }
    rows.push(row);
  }
  return rows;
}

function serviceKeyValue(value: string) {
  const key = value.trim();
  if (!key.includes("%")) return key;
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

async function fetchOption(serviceKey: string, traceNo: string, optionNo: number, signal: AbortSignal): Promise<OptionResult> {
  const endpoint = new URL("http://data.ekape.or.kr/openapi-data/service/user/animalTrace/traceNoSearch");
  endpoint.searchParams.set("serviceKey", serviceKeyValue(serviceKey));
  endpoint.searchParams.set("traceNo", traceNo);
  endpoint.searchParams.set("optionNo", String(optionNo));

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/xml, text/xml" },
      redirect: "follow",
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, optionNo, code: "HTTP", message: "축산물이력제 서버에 연결하지 못했습니다.", rows: [] };
  }
  const xml = await response.text();
  if (!response.ok) {
    return { ok: false, optionNo, code: String(response.status), message: `축산물이력제 조회 오류 (${response.status})`, rows: [] };
  }
  const code = tagText(xml, "resultCode");
  const message = tagText(xml, "resultMsg") || "조회 결과가 없습니다.";
  const rows = code === "00" ? itemRows(xml, optionNo) : [];
  return { ok: code === "00" && rows.length > 0, optionNo, code, message, rows };
}

async function fetchOptions(serviceKey: string, traceNo: string, optionNos: number[]) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    return await Promise.all(optionNos.map((optionNo) => fetchOption(serviceKey, traceNo, optionNo, controller.signal)));
  } finally {
    clearTimeout(timeout);
  }
}

function permissionGranted(session: ErpSession, action: "create" | "update") {
  const row = (session.permissions || []).find((item) => item?.menuCode === "transactions");
  return action === "update" ? row?.canUpdate === true : row?.canCreate === true;
}

function isoDate(value: unknown) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 8) return "";
  const normalized = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  const date = new Date(`${normalized}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === normalized ? normalized : "";
}

function distinct(rows: TraceRow[], fields: string[]) {
  const values = new Set<string>();
  for (const row of rows) {
    for (const field of fields) {
      const value = String(row[field] || "").trim();
      if (value) values.add(value);
    }
  }
  return [...values];
}

function distinctDates(rows: TraceRow[], fields: string[]) {
  return [...new Set(distinct(rows, fields).map(isoDate).filter(Boolean))].sort();
}

function inferSpecies(rows: TraceRow[]) {
  const types = distinct(rows, ["traceNoType"]).map((value) => value.toUpperCase());
  if (types.some((value) => value.startsWith("CATTLE/"))) return "cattle";
  if (types.some((value) => value.startsWith("PIG/"))) return "pig";
  if (distinct(rows, ["cattleNo"]).length) return "cattle";
  if (distinct(rows, ["pigNo", "pigLotNo", "lotPigNo"]).length) return "pig";
  return "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
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
  const speciesHint = payload.speciesHint === "cattle" ? "cattle" : payload.speciesHint === "pig" ? "pig" : "";
  const permissionAction = payload.permissionAction === "update" ? "update" : "create";
  if (!sessionToken) return json(req, 401, { error: "개인 사용자 로그인이 필요합니다." });
  if (!/^[0-9A-Z]{12,30}$/.test(traceNo)) {
    return json(req, 400, { error: "국내산 소·돼지 이력번호 또는 묶음번호를 확인해주세요." });
  }
  if (!speciesHint) return json(req, 400, { error: "품목의 육종 정보를 확인해주세요." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const traceServiceKey = String(Deno.env.get("EKAPE_TRACE_SERVICE_KEY") || "").trim();
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json(req, 503, { error: "ERP 서버 설정을 확인해주세요." });
  if (!traceServiceKey) {
    return json(req, 503, { error: "축산물이력제 공공데이터 서비스키가 설정되지 않았습니다." });
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

  let optionResults: OptionResult[];
  try {
    optionResults = await fetchOptions(traceServiceKey, traceNo, [1, 3, 4]);
    if (!optionResults.some((result) => result.ok)) {
      optionResults = optionResults.concat(await fetchOptions(traceServiceKey, traceNo, [8, 9]));
    }
  } catch (error) {
    const message = error instanceof DOMException && error.name === "AbortError"
      ? "축산물이력제 조회 시간이 초과되었습니다."
      : "축산물이력제 서버에 연결하지 못했습니다.";
    return json(req, 502, { error: message });
  }

  const rows = optionResults.flatMap((result) => result.rows);
  if (!rows.length) {
    const keyError = optionResults.find((result) => ["20", "30", "31", "99"].includes(result.code));
    const message = keyError?.message || optionResults.find((result) => result.message)?.message || "조회 결과가 없습니다.";
    return json(req, keyError ? 503 : 404, { error: message });
  }

  const species = inferSpecies(rows) || speciesHint;
  if (species !== speciesHint) {
    return json(req, 409, { error: species === "cattle" ? "소 이력번호입니다. 소고기 품목을 선택해주세요." : "돼지 이력번호입니다. 돼지고기 품목을 선택해주세요." });
  }

  const slaughterDates = distinctDates(rows, ["butcheryYmd", "butchYmd"]);
  const processDates = distinctDates(rows, ["processYmd", "packYmd"]);
  const slaughterHouses = distinct(rows, ["butcheryPlaceNm", "butchPlaceNm"]);
  const processCompanies = distinct(rows, ["processPlaceNm", "packPlaceNm"]);
  const grades = distinct(rows, ["gradeNm", "qgrade", "gradeCd"]);
  const inspectionResults = distinct(rows, ["inspectPassYn", "butchPassYn"]);
  const traceTypes = distinct(rows, ["traceNoType"]);
  const isBundle = traceNo.startsWith("L") || traceTypes.some((value) => /LOT_NO/i.test(value)) || optionResults.some((result) => result.ok && result.optionNo >= 8);
  const queriedAt = new Date().toISOString();

  const result = {
    ok: true,
    traceNo,
    species,
    animalType: species === "cattle" ? "소" : "돼지",
    isBundle,
    traceType: traceTypes[0] || "",
    slaughterDate: slaughterDates[0] || "",
    slaughterEndDate: slaughterDates.at(-1) || "",
    slaughterHouses,
    grades,
    inspectionResults,
    processDate: processDates[0] || "",
    processEndDate: processDates.at(-1) || "",
    processCompanies,
    breed: distinct(rows, ["lsTypeNm", "pigBreedNm"])[0] || "",
    queriedAt,
  };

  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const user = session.user || {};
  const { error: auditError } = await serviceClient.from("change_logs").insert({
    entity: "축산물이력제",
    action: "조회",
    entity_id: traceNo,
    summary: `${result.animalType} 이력조회: ${traceNo}${result.slaughterDate ? ` / 도축 ${result.slaughterDate}` : ""}`,
    payload: {
      traceNo,
      species,
      isBundle,
      slaughterDate: result.slaughterDate,
      slaughterEndDate: result.slaughterEndDate,
      processDate: result.processDate,
      processEndDate: result.processEndDate,
      queriedAt,
      authMode: "personal_session",
      userId: user.id || "",
      loginId: user.loginId || "",
      displayName: user.displayName || "",
      roleCode: user.roleCode || "",
    },
  });
  if (auditError) console.error("Livestock trace lookup audit failed", auditError.message);

  return json(req, 200, result);
});
