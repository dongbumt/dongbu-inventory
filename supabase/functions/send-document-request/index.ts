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
  action?:
    | "capabilities"
    | "send"
    | "cold_storage_fax"
    | "cold_storage_fax_status"
    | "cold_storage_public_load"
    | "cold_storage_public_save"
    | "cold_storage_public_delete"
    | "cold_storage_public_capabilities"
    | "cold_storage_public_fax"
    | "cold_storage_public_fax_status";
  appPassword?: string;
  channel?: DeliveryChannel;
  trader?: string;
  recipient?: string;
  recipientName?: string;
  documents?: DocumentRow[];
  requestId?: string;
  requestType?: string;
  warehouse?: string;
  itemCount?: number;
  imageDataUrl?: string;
  messageId?: string;
  record?: Record<string, unknown>;
  recordId?: string;
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

function isAllowedPublicOrigin(req: Request) {
  const origin = req.headers.get("origin") || "";
  return ALLOWED_ORIGINS.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
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

function safeNumber(value: unknown, minimum = 0, maximum = 1_000_000_000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(maximum, Math.max(minimum, number));
}

function sanitizeColdStorageRecord(value: unknown) {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const id = clean(source.id, 100);
  const requestDate = clean(source.requestDate, 10);
  const warehouse = clean(source.warehouse, 100);
  const fax = clean(source.fax, 30);
  if (!/^csr_[A-Za-z0-9_]+$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(requestDate) || !warehouse) {
    throw new Error("냉동창고 요청 정보가 올바르지 않습니다.");
  }
  const rawItems = Array.isArray(source.items) ? source.items.slice(0, 10) : [];
  const items = rawItems.map((item, index) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      id: clean(row.id, 100) || `${id}_item_${index + 1}`,
      destination: clean(row.destination, 100),
      product: clean(row.product, 100),
      unit: clean(row.unit, 20) || "BOX",
      quantity: safeNumber(row.quantity),
      lot: clean(row.lot, 100),
      note: clean(row.note || row.spec, 200),
    };
  }).filter((item) => item.destination && item.product && item.quantity > 0);
  if (!items.length) throw new Error("요청 품목을 한 개 이상 입력해주세요.");
  const statusValues = new Set(["draft", "saved", "accepted", "completed", "partial", "canceled", "failed"]);
  const status = clean(source.status, 20);
  return {
    id,
    requestDate,
    requestType: source.requestType === "이체" ? "이체" : "출고",
    requesterId: source.requesterId === "dongbu_distribution" ? "dongbu_distribution" : "dongbumt",
    warehouse,
    fax,
    managerName: source.managerName === "김상영 본부장" ? "김상영 본부장" : "배은정 실장",
    managerPhone: clean(source.managerPhone, 30),
    note: clean(source.note, 500),
    items,
    status: statusValues.has(status) ? status : "saved",
    createdAt: clean(source.createdAt, 40),
    updatedAt: clean(source.updatedAt, 40),
    sentAt: clean(source.sentAt, 40),
    providerMessageId: clean(source.providerMessageId, 30),
    providerStatus: clean(source.providerStatus, 100),
    errorMessage: clean(source.errorMessage, 1000),
    faxSendState: source.faxSendState === null || source.faxSendState === undefined
      ? null
      : Math.trunc(safeNumber(source.faxSendState, 0, 8)),
    faxResult: clean(source.faxResult, 100),
    faxSendPageCount: Math.trunc(safeNumber(source.faxSendPageCount, 0, 100)),
    faxSuccessPageCount: Math.trunc(safeNumber(source.faxSuccessPageCount, 0, 100)),
    faxSendDateTime: clean(source.faxSendDateTime, 30),
    faxEndDateTime: clean(source.faxEndDateTime, 30),
    faxStatusCheckedAt: clean(source.faxStatusCheckedAt, 40),
  };
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

function xmlValue(xml: string, tag: string) {
  const pattern = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "i");
  const match = String(xml || "").match(pattern);
  return clean(match ? decodeXml(match[1]) : "", 1000);
}

function faxStatusLabel(sendState: number) {
  return ({
    0: "파일 변환 대기",
    1: "파일 변환 중",
    2: "전송 중",
    3: "전송 완료",
    4: "예약 취소",
    5: "파일 변환 실패",
    6: "전송 실패",
    7: "부분 성공",
    8: "파일 용량 초과",
  } as Record<number, string>)[sendState] || `상태 ${sendState}`;
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

function documentEmailTableRows(documents: DocumentRow[]) {
  return documents.map((row, index) => `
    <tr>
      <td style="border:1px solid #777;padding:9px 7px;text-align:center;vertical-align:middle;">${index + 1}</td>
      <td style="border:1px solid #777;padding:9px 7px;text-align:left;vertical-align:middle;">${escapeHtml(row.product || "-")}</td>
      <td style="border:1px solid #777;padding:9px 7px;text-align:center;vertical-align:middle;">${escapeHtml(row.origin || "-")}</td>
      <td style="border:1px solid #777;padding:9px 7px;text-align:left;vertical-align:middle;overflow-wrap:anywhere;word-break:break-all;white-space:normal;">${escapeHtml(row.lot || "-")}</td>
      <td style="border:1px solid #777;padding:9px 7px;text-align:center;vertical-align:middle;"><strong>${escapeHtml(row.requiredDoc || "-")}</strong></td>
    </tr>`).join("");
}

function documentFaxTableRows(documents: DocumentRow[]) {
  return documents.map((row, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(row.product || "-")}</td>
      <td>${escapeHtml(row.origin || "-")}</td>
      <td class="lot">${escapeHtml(row.lot || "-")}</td>
      <td><strong>${escapeHtml(row.requiredDoc || "-")}</strong></td>
    </tr>`).join("");
}

function requestEmailHtml(trader: string, documents: DocumentRow[]) {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#fff;font-family:Arial,'Malgun Gothic',sans-serif;color:#222;line-height:1.55;">
<div style="max-width:820px;margin:0 auto;padding:28px 24px;">
<div style="font-size:22px;font-weight:700;border-bottom:2px solid #444;padding-bottom:12px;margin-bottom:20px;">입고 필요서류 요청서</div>
<div style="font-size:14px;line-height:1.9;margin-bottom:18px;">
  <div><strong style="display:inline-block;min-width:72px;">수신 :</strong> ${escapeHtml(trader)} 귀중</div>
  <div><strong style="display:inline-block;min-width:72px;">발신 :</strong> ${escapeHtml(REQUEST_SENDER_NAME)}</div>
  <div><strong style="display:inline-block;min-width:72px;">요청일 :</strong> ${new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}</div>
</div>
<p style="font-size:14px;margin:0 0 18px;">안녕하세요. 아래 입고 건에 대한 필요서류를 회신 부탁드립니다.</p>
<table style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:13px;margin:0 0 24px;">
<thead><tr>
  <th style="width:6%;border:1px solid #777;background:#eee;padding:9px 7px;text-align:center;">No.</th>
  <th style="width:27%;border:1px solid #777;background:#eee;padding:9px 7px;text-align:center;">품목명</th>
  <th style="width:13%;border:1px solid #777;background:#eee;padding:9px 7px;text-align:center;">원산지</th>
  <th style="width:36%;border:1px solid #777;background:#eee;padding:9px 7px;text-align:center;">이력번호</th>
  <th style="width:18%;border:1px solid #777;background:#eee;padding:9px 7px;text-align:center;">필요서류</th>
</tr></thead>
<tbody>${documentEmailTableRows(documents)}</tbody></table>
<div style="border-top:1px solid #aaa;padding-top:14px;font-size:13px;line-height:1.7;">
  <strong style="font-size:14px;">${escapeHtml(REQUEST_SENDER_NAME)}</strong><br>
  <span>회신 방법 : 이메일(${REQUEST_REPLY_EMAIL}) or 팩스(${REQUEST_REPLY_FAX})</span>
</div></div></body></html>`;
}

function requestFaxHtml(trader: string, documents: DocumentRow[]) {
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
<p>안녕하세요. 아래 입고 건에 대한 필요서류를 회신 부탁드립니다.</p>
<table><thead><tr><th>No.</th><th>품목명</th><th>원산지</th><th class="lot">이력번호</th><th>필요서류</th></tr></thead>
<tbody>${documentFaxTableRows(documents)}</tbody></table>
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
    "아래 입고 건에 대한 필요서류를 회신 부탁드립니다.",
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
    html: requestEmailHtml(trader, documents),
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

async function uploadBarobillBytes(fileName: string, bytes: Uint8Array) {
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
    await ftp.uploadFrom(Readable.from([bytes]), fileName);
  } finally {
    ftp.close();
  }
}

async function uploadBarobillFile(fileName: string, content: string) {
  await uploadBarobillBytes(fileName, new TextEncoder().encode(content));
}

function decodeJpegDataUrl(value: unknown) {
  const dataUrl = String(value ?? "");
  const match = dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("팩스 요청서 이미지 형식이 올바르지 않습니다.");
  if (match[1].length > 8_000_000) throw new Error("팩스 요청서 이미지가 너무 큽니다.");
  const binary = atob(match[1]);
  if (!binary.length || binary.length > 6_000_000) throw new Error("팩스 요청서 이미지 크기를 확인해주세요.");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
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
  await uploadBarobillFile(fileName, requestFaxHtml(trader, documents));
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

async function sendColdStorageFax(
  warehouse: string,
  recipient: string,
  requestType: string,
  itemCount: number,
  imageDataUrl: string,
) {
  const config = barobillConfig();
  if (!config.certKey || !config.corpNum || !config.senderId || !config.memberPassword || !config.fromNumber) {
    throw new Error("바로빌 연동정보가 아직 설정되지 않았습니다.");
  }
  const bytes = decodeJpegDataUrl(imageDataUrl);
  const fileName = `dbmt_cold_storage_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.jpg`;
  await uploadBarobillBytes(fileName, bytes);
  const sendKey = await barobillSoap("SendFaxFromFTP", {
    CERTKEY: config.certKey,
    CorpNum: config.corpNum,
    SenderID: config.senderId,
    FileName: fileName,
    FromNumber: config.fromNumber,
    ToNumber: recipient,
    ReceiveCorp: warehouse,
    ReceiveName: "냉동창고 담당자",
    SendDT: "",
    RefKey: "",
  });
  if (/^-\d{5}$/.test(sendKey)) {
    const detail = await barobillErrorMessage(sendKey);
    throw new Error(`바로빌 오류 ${sendKey}${detail ? `: ${detail}` : ""}`);
  }
  return {
    subject: `[동부엠티] 냉동창고 ${requestType} 요청 - ${warehouse} (${itemCount}건)`,
    messageId: sendKey,
    providerStatus: config.isTest ? "테스트 접수" : "전송 접수",
  };
}

async function getColdStorageFaxStatus(messageId: string) {
  const config = barobillConfig();
  if (!config.certKey || !config.corpNum) throw new Error("바로빌 연동정보가 아직 설정되지 않았습니다.");
  const detailXml = await barobillSoap("GetFaxMessageEx2", {
    CERTKEY: config.certKey,
    CorpNum: config.corpNum,
    SendKey: messageId,
  });
  const sendStateValue = xmlValue(detailXml, "SendState");
  if (sendStateValue === "") throw new Error("바로빌 팩스 상태를 확인할 수 없습니다.");
  const sendState = Number(sendStateValue);
  if (!Number.isInteger(sendState)) throw new Error("바로빌 팩스 상태를 확인할 수 없습니다.");
  if (sendState < 0) {
    const detail = await barobillErrorMessage(String(sendState));
    throw new Error(`바로빌 오류 ${sendState}${detail ? `: ${detail}` : ""}`);
  }
  return {
    messageId,
    sendState,
    status: faxStatusLabel(sendState),
    terminal: [3, 4, 5, 6, 7, 8].includes(sendState),
    success: sendState === 3,
    partial: sendState === 7,
    sendResult: xmlValue(detailXml, "SendResult"),
    sendPageCount: Number(xmlValue(detailXml, "SendPageCount")) || 0,
    successPageCount: Number(xmlValue(detailXml, "SuccessPageCount")) || 0,
    sendDateTime: xmlValue(detailXml, "SendDT"),
    endDateTime: xmlValue(detailXml, "EndDT"),
  };
}

async function getPublicColdStorageData(supabase: any) {
  const { data, error } = await supabase.from("app_data")
    .select("key,payload")
    .in("key", ["coldStorageRequests", "traderInfoMap"]);
  if (error) throw new Error(`냉동창고 요청 데이터를 불러오지 못했습니다: ${error.message}`);
  const values = Object.fromEntries((data || []).map((row: any) => [row.key, row.payload]));
  const traderInfo = values.traderInfoMap && typeof values.traderInfoMap === "object" ? values.traderInfoMap : {};
  return {
    requests: Array.isArray(values.coldStorageRequests) ? values.coldStorageRequests : [],
    traderInfoMap: Object.fromEntries(Object.entries(traderInfo).filter(([, raw]) => {
      const info = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      return clean(info.tradeType, 30) === "보관(냉동창고)";
    }).map(([name, raw]) => {
      const info = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      return [clean(name, 100), {
        tradeType: "보관(냉동창고)",
        fullname: clean(info.fullname, 150),
        fax: clean(info.fax, 30),
        faxAlt: clean(info.faxAlt, 30),
      }];
    }).filter(([name]) => Boolean(name))),
  };
}

async function savePublicColdStorageRecord(supabase: any, rawRecord: unknown) {
  const record = sanitizeColdStorageRecord(rawRecord);
  const { error } = await supabase.rpc("dbmt_cold_storage_public_write", {
    p_action: "save",
    p_record: record,
    p_record_id: record.id,
  });
  if (error) throw new Error(`냉동창고 요청을 저장하지 못했습니다: ${error.message}`);
  return record;
}

async function deletePublicColdStorageRecord(supabase: any, recordId: string) {
  const id = clean(recordId, 100);
  if (!/^csr_[A-Za-z0-9_]+$/.test(id)) throw new Error("삭제할 요청을 확인해주세요.");
  const { data, error } = await supabase.rpc("dbmt_cold_storage_public_write", {
    p_action: "delete",
    p_record: null,
    p_record_id: id,
  });
  if (error) throw new Error(`냉동창고 요청을 삭제하지 못했습니다: ${error.message}`);
  return { id, deleted: Boolean(data?.deleted) };
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

  const capabilities = {
    email: Boolean(env("DAUM_SMTP_USER") && env("DAUM_SMTP_APP_PASSWORD") && env("DAUM_SMTP_FROM")),
    fax: Boolean(
      env("BAROBILL_CERT_KEY") && env("BAROBILL_CORP_NUM") && env("BAROBILL_SENDER_ID") &&
        env("BAROBILL_MEMBER_PASSWORD") && env("BAROBILL_FROM_NUMBER")
    ),
    faxProvider: "바로빌",
    faxMode: env("BAROBILL_ENV").toLowerCase() === "production" ? "운영" : "테스트",
  };

  const publicActionMap: Record<string, string> = {
    cold_storage_public_capabilities: "capabilities",
    cold_storage_public_fax: "cold_storage_fax",
    cold_storage_public_fax_status: "cold_storage_fax_status",
  };
  const requestedAction = clean(payload.action, 60);
  const isPublicColdStorageAction = requestedAction.startsWith("cold_storage_public_");
  const allowedPublicActions = new Set([
    "cold_storage_public_load",
    "cold_storage_public_save",
    "cold_storage_public_delete",
    "cold_storage_public_capabilities",
    "cold_storage_public_fax",
    "cold_storage_public_fax_status",
  ]);
  if (isPublicColdStorageAction && !allowedPublicActions.has(requestedAction)) {
    return jsonResponse(req, { error: "지원하지 않는 공용 요청입니다." }, 400);
  }
  if (isPublicColdStorageAction && !isAllowedPublicOrigin(req)) {
    return jsonResponse(req, { error: "허용되지 않은 접속 경로입니다." }, 403);
  }

  if (requestedAction === "cold_storage_public_load") {
    try {
      return jsonResponse(req, { ok: true, ...(await getPublicColdStorageData(supabase)), capabilities });
    } catch (error) {
      return jsonResponse(req, { error: clean(error instanceof Error ? error.message : error, 1000) }, 502);
    }
  }
  if (requestedAction === "cold_storage_public_save") {
    try {
      return jsonResponse(req, { ok: true, record: await savePublicColdStorageRecord(supabase, payload.record) });
    } catch (error) {
      return jsonResponse(req, { error: clean(error instanceof Error ? error.message : error, 1000) }, 400);
    }
  }
  if (requestedAction === "cold_storage_public_delete") {
    try {
      return jsonResponse(req, { ok: true, ...(await deletePublicColdStorageRecord(supabase, clean(payload.recordId, 100))) });
    } catch (error) {
      return jsonResponse(req, { error: clean(error instanceof Error ? error.message : error, 1000) }, 400);
    }
  }

  if (!isPublicColdStorageAction) {
    const appPassword = clean(payload.appPassword, 200);
    const { data: passwordOk, error: passwordError } = await supabase.rpc("dbmt_check_password", {
      p_password: appPassword,
    });
    if (passwordError || passwordOk !== true) {
      return jsonResponse(req, { error: "ERP 연동 비밀번호가 올바르지 않습니다." }, 401);
    }
  }

  payload.action = (publicActionMap[requestedAction] || requestedAction) as DeliveryRequest["action"];
  if (payload.action === "capabilities") return jsonResponse(req, capabilities);

  if (payload.action === "cold_storage_fax_status") {
    const messageId = clean(payload.messageId, 30);
    if (!messageId || !/^[A-Za-z0-9_-]+$/.test(messageId)) {
      return jsonResponse(req, { error: "팩스 접수번호를 확인해주세요." }, 400);
    }
    if (!capabilities.fax) {
      return jsonResponse(req, { error: "바로빌 팩스 연동정보가 아직 설정되지 않았습니다." }, 503);
    }
    try {
      return jsonResponse(req, { ok: true, ...(await getColdStorageFaxStatus(messageId)) });
    } catch (error) {
      const message = clean(error instanceof Error ? error.message : error, 1000);
      return jsonResponse(req, { error: message || "팩스 상태 조회에 실패했습니다." }, 502);
    }
  }

  if (payload.action === "cold_storage_fax") {
    const warehouse = clean(payload.warehouse, 100);
    const recipient = clean(payload.recipient, 30).replace(/\D/g, "");
    const requestType = payload.requestType === "이체" ? "이체" : "출고";
    const itemCount = Math.trunc(Number(payload.itemCount) || 0);
    const requestId = clean(payload.requestId, 100);
    const imageDataUrl = String(payload.imageDataUrl ?? "");
    if (!warehouse || !/^\d{8,15}$/.test(recipient) || itemCount < 1 || itemCount > 10 || !imageDataUrl) {
      return jsonResponse(req, { error: "냉동창고, 팩스번호, 요청 품목을 확인해주세요." }, 400);
    }
    if (!capabilities.fax) {
      return jsonResponse(req, { error: "바로빌 팩스 연동정보가 아직 설정되지 않았습니다." }, 503);
    }
    try {
      const result = await sendColdStorageFax(warehouse, recipient, requestType, itemCount, imageDataUrl);
      console.info("Cold storage fax accepted", { requestId, warehouse, requestType, itemCount, messageId: result.messageId });
      return jsonResponse(req, {
        ok: true,
        channel: "fax",
        provider: "Barobill",
        messageId: result.messageId,
        status: result.providerStatus,
      });
    } catch (error) {
      const message = clean(error instanceof Error ? error.message : error, 1000);
      console.error("Cold storage fax failed", { requestId, warehouse, requestType, itemCount, message });
      return jsonResponse(req, { error: message || "발송에 실패했습니다." }, 502);
    }
  }

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
