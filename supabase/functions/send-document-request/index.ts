import { createClient } from "@supabase/supabase-js";
import { Client as FtpClient } from "basic-ftp";
import nodemailer from "nodemailer";
import { Readable } from "node:stream";

type DeliveryChannel = "email" | "fax";

interface DocumentRow {
  date: string;
  product: string;
  origin: string;
  lot: string;
  requiredDoc: string;
}

interface DeliveryRequest {
  action?: "capabilities" | "send";
  appPassword?: string;
  channel?: DeliveryChannel;
  trader?: string;
  recipient?: string;
  recipientName?: string;
  documents?: DocumentRow[];
}

const REQUEST_SENDER_NAME = "주식회사 동부엠티 & (주)동부축산유통";
const REQUEST_REPLY_EMAIL = "dongbumt1812@hanmail.net";
const REQUEST_REPLY_FAX = "032-232-1812";

const ALLOWED_ORIGINS = new Set([
  "https://dongbumt.github.io",
  "http://localhost",
  "http://127.0.0.1",
]);

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const localOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) || localOrigin ? origin : "https://dongbumt.github.io";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  };
}

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(req) });
}

function env(name: string) {
  return (Deno.env.get(name) || "").trim();
}

function clean(value: unknown, maxLength = 200) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] || char);
}

function escapeXml(value: unknown) {
  return escapeHtml(value);
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeDocuments(rows: unknown): DocumentRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 100).map((row) => ({
    date: clean(row?.date, 20),
    product: clean(row?.product, 100),
    origin: clean(row?.origin, 100),
    lot: clean(row?.lot, 500),
    requiredDoc: clean(row?.requiredDoc, 100),
  })).filter((row) => row.product || row.lot);
}

function requestSubject(trader: string, documents: DocumentRow[]) {
  return `[동부엠티] 입고 필요서류 요청 - ${trader} (${documents.length}건)`;
}

function documentTableRows(documents: DocumentRow[]) {
  return documents.map((row, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(row.product || "-")}</td>
      <td>${escapeHtml(row.origin || "-")}</td>
      <td class="lot">${escapeHtml(row.lot || "-")}</td>
      <td><strong>${escapeHtml(row.requiredDoc || "-")}</strong></td>
    </tr>`).join("");
}

function requestHtml(trader: string, documents: DocumentRow[]) {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<style>
body{font-family:Arial,"Malgun Gothic",sans-serif;color:#222;line-height:1.55;margin:0;padding:24px}
.page{max-width:760px;margin:0 auto}.title{font-size:22px;font-weight:700;border-bottom:2px solid #444;padding-bottom:12px}
.meta{margin:18px 0;font-size:14px}.meta strong{display:inline-block;min-width:90px}
table{width:100%;border-collapse:collapse;font-size:12px;margin:16px 0}
th,td{border:1px solid #777;padding:7px 6px;text-align:left}th{background:#eee}
td:first-child,th:first-child{text-align:center;width:36px}.lot{overflow-wrap:anywhere;word-break:break-all;white-space:normal}
.footer{margin-top:24px;border-top:1px solid #aaa;padding-top:14px;font-size:13px}
</style></head><body><div class="page">
<div class="title">입고 필요서류 요청서</div>
<div class="meta">
  <div><strong>수신</strong>${escapeHtml(trader)} 귀중</div>
  <div><strong>발신</strong>${escapeHtml(REQUEST_SENDER_NAME)}</div>
  <div><strong>요청일</strong>${new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}</div>
</div>
<p>안녕하세요. 아래 입고 건에 대한 필요서류를 회신하여 주시기 바랍니다.</p>
<table><thead><tr><th>No.</th><th>품목명</th><th>원산지</th><th class="lot">이력번호</th><th>필요서류</th></tr></thead>
<tbody>${documentTableRows(documents)}</tbody></table>
<div class="footer">
  <strong>${escapeHtml(REQUEST_SENDER_NAME)}</strong><br>
  회신 방법 : 이메일(${REQUEST_REPLY_EMAIL}) or 팩스(${REQUEST_REPLY_FAX})
</div></div></body></html>`;
}

function requestText(trader: string, documents: DocumentRow[]) {
  const lines = documents.map((row, index) =>
    `${index + 1}. 품목명: ${row.product || "-"} / 원산지: ${row.origin || "-"} / 이력번호: ${row.lot || "-"} / 필요서류: ${row.requiredDoc || "-"}`
  );
  return [
    `${trader} 담당자님께`,
    "",
    `안녕하세요. ${REQUEST_SENDER_NAME}입니다.`,
    "아래 입고 건에 대한 필요서류를 회신하여 주시기 바랍니다.",
    "",
    ...lines,
    "",
    `회신 방법 : 이메일(${REQUEST_REPLY_EMAIL}) or 팩스(${REQUEST_REPLY_FAX})`,
  ].join("\n");
}

async function sendEmail(trader: string, recipient: string, documents: DocumentRow[]) {
  const user = env("DAUM_SMTP_USER");
  const password = env("DAUM_SMTP_APP_PASSWORD");
  const from = env("DAUM_SMTP_FROM");
  if (!user || !password || !from) throw new Error("다음메일 서버 비밀정보가 설정되지 않았습니다.");

  const transporter = nodemailer.createTransport({
    host: "smtp.daum.net",
    port: 465,
    secure: true,
    auth: { user, pass: password },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  const subject = requestSubject(trader, documents);
  const result = await transporter.sendMail({
    from: `"${REQUEST_SENDER_NAME}" <${from}>`,
    to: recipient,
    replyTo: from,
    subject,
    text: requestText(trader, documents),
    html: requestHtml(trader, documents),
  });
  return { subject, messageId: clean(result.messageId, 500), providerStatus: "발송완료" };
}

function barobillConfig() {
  const isTest = env("BAROBILL_ENV").toLowerCase() !== "production";
  return {
    isTest,
    certKey: env("BAROBILL_CERT_KEY"),
    corpNum: env("BAROBILL_CORP_NUM").replace(/\D/g, ""),
    senderId: env("BAROBILL_SENDER_ID"),
    memberPassword: env("BAROBILL_MEMBER_PASSWORD"),
    fromNumber: env("BAROBILL_FROM_NUMBER").replace(/\D/g, ""),
    ftpHost: isTest ? "testftp.barobill.co.kr" : "ftp.barobill.co.kr",
    ftpPort: isTest ? 9031 : 9030,
    apiUrl: isTest ? "https://testws.baroservice.com/FAX.asmx" : "https://ws.baroservice.com/FAX.asmx",
  };
}

async function uploadBarobillFile(fileName: string, content: string) {
  const config = barobillConfig();
  const ftp = new FtpClient(30000);
  try {
    ftp.ftp.verbose = false;
    await ftp.access({
      host: config.ftpHost,
      port: config.ftpPort,
      user: config.senderId,
      password: config.memberPassword,
      secure: false,
    });
    const bytes = new TextEncoder().encode(content);
    await ftp.uploadFrom(Readable.from([bytes]), fileName);
  } finally {
    ftp.close();
  }
}

async function barobillSoap(operation: string, params: Record<string, string>) {
  const config = barobillConfig();
  const body = Object.entries(params)
    .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
    .join("");
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
 xmlns:xsd="http://www.w3.org/2001/XMLSchema"
 xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Body><${operation} xmlns="http://ws.baroservice.com/">${body}</${operation}></soap:Body>
</soap:Envelope>`;
  const response = await fetch(config.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": `"http://ws.baroservice.com/${operation}"`,
    },
    body: xml,
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`바로빌 API 통신 실패 (${response.status})`);
  const pattern = new RegExp(`<${operation}Result>([\\s\\S]*?)<\\/${operation}Result>`);
  const match = responseText.match(pattern);
  if (!match) throw new Error("바로빌 API 응답을 확인할 수 없습니다.");
  return decodeXml(match[1].trim());
}

async function barobillErrorMessage(errorCode: string) {
  const config = barobillConfig();
  try {
    return await barobillSoap("GetErrString", {
      CERTKEY: config.certKey,
      ErrCode: errorCode,
    });
  } catch {
    return "";
  }
}

async function sendFax(trader: string, recipient: string, recipientName: string, documents: DocumentRow[]) {
  const config = barobillConfig();
  if (!config.certKey || !config.corpNum || !config.senderId || !config.memberPassword || !config.fromNumber) {
    throw new Error("바로빌 연동정보가 아직 설정되지 않았습니다.");
  }
  const fileName = `dbmt_doc_request_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.html`;
  await uploadBarobillFile(fileName, requestHtml(trader, documents));
  const sendKey = await barobillSoap("SendFaxFromFTP", {
    CERTKEY: config.certKey,
    CorpNum: config.corpNum,
    SenderID: config.senderId,
    FileName: fileName,
    FromNumber: config.fromNumber,
    ToNumber: recipient.replace(/\D/g, ""),
    ReceiveCorp: trader,
    ReceiveName: recipientName,
    SendDT: "",
    RefKey: "",
  });
  if (/^-\d{5}$/.test(sendKey)) {
    const detail = await barobillErrorMessage(sendKey);
    throw new Error(`바로빌 오류 ${sendKey}${detail ? `: ${detail}` : ""}`);
  }
  return {
    subject: requestSubject(trader, documents),
    messageId: sendKey,
    providerStatus: config.isTest ? "테스트 접수" : "전송 접수",
  };
}

async function insertLog(
  // This project does not generate database types for Edge Functions.
  supabase: any,
  values: Record<string, unknown>,
) {
  const { error } = await supabase.from("document_request_logs").insert(values);
  if (error) console.error("Document request log insert failed:", error.message);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return jsonResponse(req, { error: "POST 요청만 지원합니다." }, 405);

  const supabaseUrl = env("SUPABASE_URL");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(req, { error: "Supabase 서버 설정을 확인해주세요." }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let payload: DeliveryRequest;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(req, { error: "요청 형식이 올바르지 않습니다." }, 400);
  }

  const appPassword = clean(payload.appPassword, 200);
  const { data: passwordOk, error: passwordError } = await supabase.rpc("dbmt_check_password", {
    p_password: appPassword,
  });
  if (passwordError || passwordOk !== true) {
    return jsonResponse(req, { error: "ERP 연동 비밀번호가 올바르지 않습니다." }, 401);
  }

  const capabilities = {
    email: Boolean(env("DAUM_SMTP_USER") && env("DAUM_SMTP_APP_PASSWORD") && env("DAUM_SMTP_FROM")),
    fax: Boolean(
      env("BAROBILL_CERT_KEY") && env("BAROBILL_CORP_NUM") && env("BAROBILL_SENDER_ID") &&
        env("BAROBILL_MEMBER_PASSWORD") && env("BAROBILL_FROM_NUMBER")
    ),
    faxProvider: "바로빌",
    faxMode: env("BAROBILL_ENV").toLowerCase() === "production" ? "운영" : "테스트",
  };
  if (payload.action === "capabilities") return jsonResponse(req, capabilities);

  const channel = payload.channel === "fax" ? "fax" : "email";
  const trader = clean(payload.trader, 100);
  const recipientName = clean(payload.recipientName, 100);
  const documents = normalizeDocuments(payload.documents);
  let recipient = clean(payload.recipient, 200);
  if (channel === "fax") recipient = recipient.replace(/\D/g, "");

  if (!trader || !recipient || !documents.length) {
    return jsonResponse(req, { error: "거래처, 수신처, 요청서류를 확인해주세요." }, 400);
  }
  if (channel === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return jsonResponse(req, { error: "수신 이메일 주소를 확인해주세요." }, 400);
  }
  if (channel === "fax" && !/^\d{8,15}$/.test(recipient)) {
    return jsonResponse(req, { error: "수신 팩스번호를 확인해주세요." }, 400);
  }
  if (!capabilities[channel]) {
    return jsonResponse(req, {
      error: channel === "email"
        ? "다음메일 서버 설정이 아직 완료되지 않았습니다."
        : "바로빌 팩스 연동정보가 아직 설정되지 않았습니다.",
    }, 503);
  }

  const provider = channel === "email" ? "Daum SMTP" : "Barobill";
  const subject = requestSubject(trader, documents);
  try {
    const result = channel === "email"
      ? await sendEmail(trader, recipient, documents)
      : await sendFax(trader, recipient, recipientName, documents);
    await insertLog(supabase, {
      channel,
      trader,
      recipient,
      recipient_name: recipientName,
      subject: result.subject,
      document_count: documents.length,
      documents,
      status: channel === "email" ? "sent" : "accepted",
      provider,
      provider_message_id: result.messageId,
      provider_status: result.providerStatus,
    });
    return jsonResponse(req, {
      ok: true,
      channel,
      provider,
      messageId: result.messageId,
      status: result.providerStatus,
    });
  } catch (error) {
    const message = clean(error instanceof Error ? error.message : error, 1000);
    await insertLog(supabase, {
      channel,
      trader,
      recipient,
      recipient_name: recipientName,
      subject,
      document_count: documents.length,
      documents,
      status: "failed",
      provider,
      provider_status: "실패",
      error_message: message,
    });
    return jsonResponse(req, { error: message || "발송에 실패했습니다." }, 502);
  }
});
