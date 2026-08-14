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
  publicAccessKey?: string;
  senderProfileId?: string;
  // Legacy aliases retained while deployed clients migrate to senderProfileId.
  companyCode?: string;
  channel?: DeliveryChannel;
  trader?: string;
  recipient?: string;
  recipientName?: string;
  documents?: DocumentRow[];
  requestId?: string;
  requesterId?: string;
  requestType?: string;
  warehouse?: string;
  itemCount?: number;
  imageDataUrl?: string;
  messageId?: string;
  record?: Record<string, unknown>;
  recordId?: string;
}

interface RequestSenderProfile {
  profileId: string;
  secretAlias: string;
  isDefault: boolean;
  name: string;
  displayName: string;
  email: string;
  fax: string;
  phone: string;
  representativeName: string;
  address: string;
  sealAssetKey: string;
  businessRegistrationNo: string;
}

interface SenderProfileDefinition {
  id: string;
  businessSiteId: string;
  secretAlias: string;
  displayName: string;
  replyEmail: string;
  replyFax: string;
  phone: string;
  documentName: string;
  documentRepresentativeName: string;
  documentRegistrationNo: string;
  documentAddress: string;
  documentPhone: string;
  sealAssetKey: string;
  isDefault: boolean;
}

const SENDER_PROFILE_DEFAULTS: SenderProfileDefinition[] = [
  {
    id: "dongbumt",
    businessSiteId: "",
    secretAlias: "dongbumt",
    displayName: "동부엠티",
    replyEmail: "dongbumt1812@hanmail.net",
    replyFax: "032-232-1812",
    phone: "032-766-1812",
    documentName: "",
    documentRepresentativeName: "",
    documentRegistrationNo: "",
    documentAddress: "",
    documentPhone: "",
    sealAssetKey: "assets/company-seal.png",
    isDefault: true,
  },
  {
    id: "dongbu_distribution",
    businessSiteId: "",
    secretAlias: "dongbu_distribution",
    displayName: "동부축산유통",
    replyEmail: "",
    replyFax: "032-578-0108",
    phone: "032-579-3920",
    documentName: "(주)동부축산유통",
    documentRepresentativeName: "이동대",
    documentRegistrationNo: "1378138748",
    documentAddress: "인천광역시 서해구 가좌로96번길 11",
    documentPhone: "032-579-3920",
    sealAssetKey: "assets/company-seal-trading.png",
    isDefault: false,
  },
];

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

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyPublicAccessKey(value: unknown) {
  const expected = env("COLD_STORAGE_PUBLIC_ACCESS_SHA256").toLowerCase();
  // The operator may deliberately leave this secret unset to preserve the
  // existing no-login public workflow. Setting a valid hash enables the gate.
  if (!expected) return true;
  if (!/^[a-f0-9]{64}$/.test(expected)) return false;
  const provided = clean(value, 200);
  if (!provided) return false;
  const actual = await sha256Hex(provided);
  let difference = actual.length ^ expected.length;
  for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
    difference |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function senderProfileDefinitions(): SenderProfileDefinition[] {
  return SENDER_PROFILE_DEFAULTS.map((fallback) => {
    const prefix = `DOCUMENT_SENDER_${fallback.id.toUpperCase()}`;
    const sealAssetKey = clean(env(`${prefix}_SEAL_ASSET_KEY`) || fallback.sealAssetKey, 250);
    return {
      ...fallback,
      displayName: clean(env(`${prefix}_DISPLAY_NAME`) || fallback.displayName, 100),
      replyEmail: clean(env(`${prefix}_REPLY_EMAIL`) || fallback.replyEmail, 200),
      replyFax: clean(env(`${prefix}_REPLY_FAX`) || fallback.replyFax, 40),
      phone: clean(env(`${prefix}_PHONE`) || fallback.phone, 40),
      sealAssetKey: /^assets\/[A-Za-z0-9._/-]+$/.test(sealAssetKey) ? sealAssetKey : fallback.sealAssetKey,
    };
  });
}

function normalizedSecretAlias(value: unknown) {
  const alias = clean(value, 50).toLowerCase();
  return /^[a-z][a-z0-9_]{1,49}$/.test(alias) ? alias : "";
}

function resolveSenderProfileDefinition(profiles: SenderProfileDefinition[], value: unknown): SenderProfileDefinition {
  const id = clean(value, 50);
  const profile = id ? profiles.find((row) => row.id === id) :
    (profiles.find((row) => row.isDefault) || profiles[0]);
  if (!profile) throw new Error("발신 프로필이 없거나 사용할 수 없습니다.");
  return profile;
}

function requestedSenderProfileId(payload: DeliveryRequest) {
  return clean(payload.senderProfileId || payload.requesterId || payload.companyCode, 50);
}

async function getCompanyMasterProjection(supabase: any, includeEmail = false) {
  const { data: companies, error: companyError } = await supabase.from("companies")
    .select("id,code,legal_name,display_name,representative_name,seal_asset_key,is_primary,active,revision")
    .eq("active", true)
    .order("is_primary", { ascending: false })
    .order("code", { ascending: true });
  if (companyError) {
    console.warn("Company master projection unavailable:", companyError.message);
    return null;
  }
  const companyIds = (companies || []).map((row: any) => row.id);
  let sites: any[] = [];
  if (companyIds.length) {
    const baseSiteFields = [
      "id", "company_id", "code", "name", "site_type", "business_registration_no", "postal_code",
      "road_address", "detail_address", ...(includeEmail ? ["email"] : []), "phone", "fax",
      "is_head_office", "is_default_document_site", "active", "revision",
    ];
    const extendedSiteFields = [...baseSiteFields, "inventory_location", "ownership_type", "operator_name"];
    let { data: siteRows, error: siteError } = await supabase.from("business_sites")
      .select(extendedSiteFields.join(","))
      .in("company_id", companyIds)
      .eq("active", true)
      .order("is_default_document_site", { ascending: false })
      .order("code", { ascending: true });
    // Keep the Edge Function deployable before the inventory-location columns
    // reach production. The public projection simply has no locations then.
    if (siteError && /inventory_location|ownership_type|operator_name|column/i.test(siteError.message || "")) {
      ({ data: siteRows, error: siteError } = await supabase.from("business_sites")
        .select(baseSiteFields.join(","))
        .in("company_id", companyIds)
        .eq("active", true)
        .order("is_default_document_site", { ascending: false })
        .order("code", { ascending: true }));
    }
    if (siteError) {
      console.warn("Business-site projection unavailable:", siteError.message);
      return null;
    }
    sites = siteRows || [];
  }
  const { data: senderRows, error: senderError } = await supabase.from("document_sender_profiles")
    .select("code,label,business_site_id,document_name,document_representative_name,document_registration_no,document_address,document_phone,reply_email,reply_fax,seal_asset_key,secret_alias,is_default,active")
    .order("is_default", { ascending: false })
    .order("code", { ascending: true });
  if (senderError) console.warn("Document-sender projection unavailable:", senderError.message);
  return {
    companies: (companies || []).map((company: any) => ({
      id: company.id,
      code: clean(company.code, 50),
      legalName: clean(company.legal_name, 150),
      displayName: clean(company.display_name, 100),
      representativeName: clean(company.representative_name, 100),
      sealAssetKey: clean(company.seal_asset_key, 250),
      isPrimary: Boolean(company.is_primary),
      active: Boolean(company.active),
      revision: Number(company.revision) || 1,
      sites: sites.filter((site: any) => site.company_id === company.id).map((site: any) => ({
        id: site.id,
        companyId: site.company_id,
        code: clean(site.code, 50),
        name: clean(site.name, 150),
        siteType: clean(site.site_type, 30),
        businessRegistrationNo: clean(site.business_registration_no, 10),
        postalCode: clean(site.postal_code, 12),
        roadAddress: clean(site.road_address, 250),
        detailAddress: clean(site.detail_address, 200),
        ...(includeEmail ? { email: clean(site.email, 200) } : {}),
        phone: clean(site.phone, 40),
        fax: clean(site.fax, 40),
        isHeadOffice: Boolean(site.is_head_office),
        isDefaultDocumentSite: Boolean(site.is_default_document_site),
        inventoryLocation: Boolean(site.inventory_location),
        ownershipType: clean(site.ownership_type, 30),
        operatorName: clean(site.operator_name, 150),
        active: Boolean(site.active),
        revision: Number(site.revision) || 1,
        identifiers: [],
      })),
    })),
    documentSenderProfiles: (senderError ? [] : senderRows || []).map((profile: any) => ({
      code: clean(profile.code, 50),
      label: clean(profile.label, 100),
      businessSiteId: clean(profile.business_site_id, 100),
      documentName: clean(profile.document_name, 200),
      documentRepresentativeName: clean(profile.document_representative_name, 100),
      documentRegistrationNo: clean(profile.document_registration_no, 10),
      documentAddress: clean(profile.document_address, 500),
      documentPhone: clean(profile.document_phone, 40),
      replyEmail: clean(profile.reply_email, 200),
      replyFax: clean(profile.reply_fax, 40),
      sealAssetKey: clean(profile.seal_asset_key, 250),
      secretAlias: normalizedSecretAlias(profile.secret_alias),
      isDefault: Boolean(profile.is_default),
      active: Boolean(profile.active),
    })),
    senderProfilesSource: senderError ? "unavailable" : ((senderRows || []).length ? "database" : "empty"),
  };
}

function primaryCompany(master: any) {
  const companies = Array.isArray(master?.companies) ? master.companies : [];
  return companies.find((row: any) => row.isPrimary) || companies[0] || null;
}

function senderDefinitionsFromMaster(master: any): SenderProfileDefinition[] {
  const rows = Array.isArray(master?.documentSenderProfiles) ? master.documentSenderProfiles : [];
  if (!rows.length) return master?.senderProfilesSource === "empty" ? senderProfileDefinitions() : [];
  return rows.filter((row: any) => row.active !== false).map((row: any) => ({
    id: clean(row.code, 50),
    businessSiteId: clean(row.businessSiteId, 100),
    secretAlias: normalizedSecretAlias(row.secretAlias),
    displayName: clean(row.label, 100),
    replyEmail: clean(row.replyEmail, 200),
    replyFax: clean(row.replyFax, 40),
    phone: "",
    documentName: clean(row.documentName, 200),
    documentRepresentativeName: clean(row.documentRepresentativeName, 100),
    documentRegistrationNo: clean(row.documentRegistrationNo, 10),
    documentAddress: clean(row.documentAddress, 500),
    documentPhone: clean(row.documentPhone, 40),
    sealAssetKey: clean(row.sealAssetKey, 250),
    isDefault: Boolean(row.isDefault),
  })).filter((row: SenderProfileDefinition) =>
    /^[a-z][a-z0-9_-]{1,49}$/.test(row.id) && row.displayName && row.secretAlias
  );
}

function allSenderDefinitionsFromMaster(master: any): SenderProfileDefinition[] {
  const rows = Array.isArray(master?.documentSenderProfiles) ? master.documentSenderProfiles : [];
  if (!rows.length) return master?.senderProfilesSource === "empty" ? senderProfileDefinitions() : [];
  return rows.map((row: any) => ({
    id: clean(row.code, 50), businessSiteId: clean(row.businessSiteId, 100),
    secretAlias: normalizedSecretAlias(row.secretAlias), displayName: clean(row.label, 100),
    replyEmail: clean(row.replyEmail, 200), replyFax: clean(row.replyFax, 40), phone: "",
    documentName: clean(row.documentName, 200),
    documentRepresentativeName: clean(row.documentRepresentativeName, 100),
    documentRegistrationNo: clean(row.documentRegistrationNo, 10),
    documentAddress: clean(row.documentAddress, 500),
    documentPhone: clean(row.documentPhone, 40),
    sealAssetKey: clean(row.sealAssetKey, 250), isDefault: Boolean(row.isDefault),
  })).filter((row: SenderProfileDefinition) =>
    /^[a-z][a-z0-9_-]{1,49}$/.test(row.id) && row.displayName && row.secretAlias
  );
}

async function getRequestSenderProfile(supabase: any, senderProfileId = "", includeInactive = false) {
  const master = await getCompanyMasterProjection(supabase, true);
  if (!master) throw new Error("법인·발신 프로필 기준정보를 불러오지 못했습니다.");
  const definitions = includeInactive ? allSenderDefinitionsFromMaster(master) : senderDefinitionsFromMaster(master);
  const senderDefinition = resolveSenderProfileDefinition(definitions, senderProfileId);
  if (!Array.isArray(master.companies) || !master.companies.length) {
    throw new Error("기본 법인 기준정보를 먼저 등록해주세요.");
  }
  const company = primaryCompany(master);
  if (!company) throw new Error("기본 법인 기준정보가 없습니다.");
  const sites = Array.isArray(company.sites) ? company.sites : [];
  const isRegisteredInternalSite = (row: any) =>
    row?.siteType !== "external_warehouse" && row?.ownershipType !== "third_party" &&
    /^\d{10}$/.test(clean(row?.businessRegistrationNo, 10));
  const legalSite = sites.find((row: any) => row.isDefaultDocumentSite && isRegisteredInternalSite(row)) ||
    sites.find((row: any) => row.isHeadOffice && isRegisteredInternalSite(row)) ||
    sites.find(isRegisteredInternalSite) || sites.find((row: any) => row.isDefaultDocumentSite) ||
    sites.find((row: any) => row.isHeadOffice) || sites[0];
  if (!legalSite) throw new Error("기본 법인에 활성 사업장이 없습니다.");
  const hasBusinessNumber = (site: any) => /^\d{10}$/.test(clean(site?.businessRegistrationNo, 10));
  const legalIdentitySite = isRegisteredInternalSite(legalSite) ? legalSite : (sites.find(isRegisteredInternalSite) || legalSite);
  const linkedSenderSite = sites.find((row: any) => row.id === senderDefinition.businessSiteId);
  if (!includeInactive && senderDefinition.businessSiteId && (!linkedSenderSite || linkedSenderSite.siteType === "external_warehouse" || linkedSenderSite.ownershipType === "third_party")) {
    throw new Error("발신 프로필에는 활성 내부 사업장만 연결할 수 있습니다.");
  }
  const senderSite = linkedSenderSite || legalSite;
  const identitySite = hasBusinessNumber(senderSite) ? senderSite : legalIdentitySite;
  const name = senderDefinition.documentName || clean(company.legalName, 150);
  const businessRegistrationNo = senderDefinition.documentRegistrationNo || clean(identitySite.businessRegistrationNo, 10);
  if (!name || !/^\d{10}$/.test(businessRegistrationNo)) {
    throw new Error("기본 법인의 법인명과 사업자번호를 확인해주세요.");
  }
  return {
    profileId: senderDefinition.id,
    secretAlias: senderDefinition.secretAlias,
    isDefault: senderDefinition.isDefault,
    name,
    displayName: senderDefinition.displayName,
    email: senderDefinition.replyEmail || clean(senderSite.email, 200),
    fax: senderDefinition.replyFax || clean(senderSite.fax, 40),
    phone: senderDefinition.documentPhone || senderDefinition.phone || clean(senderSite.phone, 40),
    representativeName: senderDefinition.documentRepresentativeName || clean(company.representativeName, 100),
    address: senderDefinition.documentAddress || [clean(identitySite.roadAddress, 250), clean(identitySite.detailAddress, 200)].filter(Boolean).join(" "),
    sealAssetKey: senderDefinition.sealAssetKey || clean(company.sealAssetKey, 250),
    businessRegistrationNo,
  } satisfies RequestSenderProfile;
}

async function getRequesterSnapshot(supabase: any, senderProfileId: string) {
  const sender = await getRequestSenderProfile(supabase, senderProfileId);
  const registrationNo = sender.businessRegistrationNo;
  return {
    name: sender.name,
    displayName: sender.displayName,
    senderProfileId: sender.profileId,
    representative: sender.representativeName,
    registrationNo: `${registrationNo.slice(0, 3)}-${registrationNo.slice(3, 5)}-${registrationNo.slice(5)}`,
    address: sender.address,
    phone: sender.phone,
    fax: sender.fax,
    email: sender.email,
    seal: /^assets\/[A-Za-z0-9._/-]+$/.test(sender.sealAssetKey) ? sender.sealAssetKey : "",
    capturedAt: new Date().toISOString(),
    source: "server_verified",
  };
}

async function getSenderProfileProjection(supabase: any) {
  const master = await getCompanyMasterProjection(supabase, true);
  if (!Array.isArray(master?.companies) || !master.companies.length) return [];
  const definitions = senderDefinitionsFromMaster(master);
  return Promise.all(definitions.map(async (profile) => {
    const sender = await getRequestSenderProfile(supabase, profile.id);
    const config = barobillConfig(sender);
    return {
      id: profile.id,
      displayName: sender.displayName,
      legalName: sender.name,
      representativeName: sender.representativeName,
      registrationNo: `${sender.businessRegistrationNo.slice(0, 3)}-${sender.businessRegistrationNo.slice(3, 5)}-${sender.businessRegistrationNo.slice(5)}`,
      address: sender.address,
      replyEmail: sender.email,
      replyFax: sender.fax,
      phone: sender.phone,
      sealAssetKey: sender.sealAssetKey,
      isDefault: profile.isDefault,
      faxConfigured: isBarobillConfigured(config),
      faxMode: config.isTest ? "테스트" : "운영",
    };
  }));
}

async function getInventoryLocationProjection(supabase: any) {
  const master = await getCompanyMasterProjection(supabase, false);
  const company = primaryCompany(master);
  const sites = Array.isArray(company?.sites) ? company.sites : [];
  return sites.filter((site: any) => site.inventoryLocation === true).map((site: any) => ({
      id: site.id,
      siteCode: site.code,
      name: site.name,
      siteType: site.siteType,
      inventoryLocation: true,
      ownershipType: site.ownershipType,
      operatorName: site.operatorName,
      fax: site.fax,
    }));
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
    const rawItemId = clean(row.id, 100);
    return {
      id: /^csri_[A-Za-z0-9_]+$/.test(rawItemId) ? rawItemId : `csri_${id.slice(4)}_${index + 1}`,
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
  const requesterId = clean(source.requesterId, 50);
  if (!/^[a-z][a-z0-9_-]{1,49}$/.test(requesterId)) throw new Error("발신 프로필 코드를 확인해주세요.");
  // requesterId remains the legacy storage key. The active DB-backed sender
  // profile is resolved before the server snapshot is written.
  const warehouseLocationId = clean(source.warehouseLocationId, 100);
  const warehouseSiteCode = clean(source.warehouseSiteCode, 50);
  if (warehouseLocationId && !/^[A-Za-z0-9_-]{2,100}$/.test(warehouseLocationId)) {
    throw new Error("수신 냉동창고 위치 ID를 확인해주세요.");
  }
  if (warehouseSiteCode && !/^[a-z][a-z0-9_-]{1,49}$/.test(warehouseSiteCode)) {
    throw new Error("수신 냉동창고 사업장 코드를 확인해주세요.");
  }
  const rawSnapshot = source.requesterSnapshot && typeof source.requesterSnapshot === "object"
    ? source.requesterSnapshot as Record<string, unknown> : {};
  const seal = clean(rawSnapshot.seal, 250);
  const requesterSnapshot = {
    name: clean(rawSnapshot.name, 150),
    displayName: clean(rawSnapshot.displayName, 100),
    senderProfileId: clean(rawSnapshot.senderProfileId, 50),
    representative: clean(rawSnapshot.representative, 100),
    registrationNo: clean(rawSnapshot.registrationNo, 20),
    address: clean(rawSnapshot.address, 350),
    phone: clean(rawSnapshot.phone, 40),
    fax: clean(rawSnapshot.fax, 40),
    email: clean(rawSnapshot.email, 200),
    seal: /^assets\/[A-Za-z0-9._/-]+$/.test(seal) ? seal : "",
    capturedAt: clean(rawSnapshot.capturedAt, 40),
    source: ["server_verified", "company_master"].includes(clean(rawSnapshot.source, 30))
      ? clean(rawSnapshot.source, 30) : "client_provisional",
  };
  return {
    id,
    requestDate,
    requestType: source.requestType === "이체" ? "이체" : "출고",
    requesterId,
    requesterSnapshot,
    warehouse,
    warehouseLocationId,
    warehouseSiteCode,
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

function requestSubject(sender: RequestSenderProfile, trader: string, documents: DocumentRow[]) {
  return `[${sender.displayName}] 입고 필요서류 요청 - ${trader} (${documents.length}건)`;
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

function requestEmailHtml(sender: RequestSenderProfile, trader: string, documents: DocumentRow[]) {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#fff;font-family:Arial,'Malgun Gothic',sans-serif;color:#222;line-height:1.55;">
<div style="max-width:820px;margin:0 auto;padding:28px 24px;">
<div style="font-size:22px;font-weight:700;border-bottom:2px solid #444;padding-bottom:12px;margin-bottom:20px;">입고 필요서류 요청서</div>
<div style="font-size:14px;line-height:1.9;margin-bottom:18px;">
  <div><strong style="display:inline-block;min-width:72px;">수신 :</strong> ${escapeHtml(trader)} 귀중</div>
  <div><strong style="display:inline-block;min-width:72px;">발신 :</strong> ${escapeHtml(sender.displayName)}</div>
  <div><strong style="display:inline-block;min-width:72px;">법인 :</strong> ${escapeHtml(sender.name)}</div>
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
  <strong style="font-size:14px;">${escapeHtml(sender.displayName)}</strong><br>
  <span>${escapeHtml(sender.name)}</span><br>
  <span>회신 방법 : 이메일(${escapeHtml(sender.email)}) or 팩스(${escapeHtml(sender.fax)})</span>
</div></div></body></html>`;
}

function requestFaxHtml(sender: RequestSenderProfile, trader: string, documents: DocumentRow[]) {
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
  <div><strong>발신</strong>${escapeHtml(sender.displayName)}</div>
  <div><strong>법인</strong>${escapeHtml(sender.name)}</div>
  <div><strong>요청일</strong>${new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}</div>
</div>
<p>안녕하세요. 아래 입고 건에 대한 필요서류를 회신 부탁드립니다.</p>
<table><thead><tr><th>No.</th><th>품목명</th><th>원산지</th><th class="lot">이력번호</th><th>필요서류</th></tr></thead>
<tbody>${documentFaxTableRows(documents)}</tbody></table>
<div class="footer">
  <strong>${escapeHtml(sender.displayName)}</strong><br>
  ${escapeHtml(sender.name)}<br>
  회신 방법 : 이메일(${escapeHtml(sender.email)}) or 팩스(${escapeHtml(sender.fax)})
</div></div></body></html>`;
}

function requestText(sender: RequestSenderProfile, trader: string, documents: DocumentRow[]) {
  const lines = documents.map((row, index) =>
    `${index + 1}. 품목명: ${row.product || "-"} / 원산지: ${row.origin || "-"} / 이력번호: ${row.lot || "-"} / 필요서류: ${row.requiredDoc || "-"}`
  );
  return [
    `${trader} 담당자님께`,
    "",
    `안녕하세요. ${sender.displayName}입니다.`,
    `법인명: ${sender.name}`,
    "아래 입고 건에 대한 필요서류를 회신 부탁드립니다.",
    "",
    ...lines,
    "",
    `회신 방법 : 이메일(${sender.email}) or 팩스(${sender.fax})`,
  ].join("\n");
}

async function sendEmail(sender: RequestSenderProfile, trader: string, recipient: string, documents: DocumentRow[]) {
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
  const subject = requestSubject(sender, trader, documents);
  const result = await transporter.sendMail({
    from: `"${sender.displayName}" <${from}>`,
    to: recipient,
    replyTo: sender.email || from,
    subject,
    text: requestText(sender, trader, documents),
    html: requestEmailHtml(sender, trader, documents),
  });
  return { subject, messageId: clean(result.messageId, 500), providerStatus: "발송완료" };
}

function barobillConfig(sender: Pick<RequestSenderProfile, "profileId" | "secretAlias" | "isDefault">) {
  const configuredAlias = normalizedSecretAlias(sender.secretAlias).toUpperCase();
  const scopedPrefix = configuredAlias ? `BAROBILL_PROFILE_${configuredAlias}` : "";
  // Certificate and account credentials belong to the single legal entity.
  // A sender profile may override them through its secret alias, while its
  // outbound number is deliberately profile-specific.
  const scoped = (name: string) => scopedPrefix ? env(`${scopedPrefix}_${name}`) : "";
  const setting = (name: string) => scoped(name) || env(`BAROBILL_${name}`);
  // Both sender profiles belong to the same legal company and may share the
  // existing Barobill account/from number. A scoped number remains available
  // when a profile needs a distinct outbound identity later.
  const fromNumber = scoped("FROM_NUMBER") || env("BAROBILL_FROM_NUMBER");
  const isTest = setting("ENV").toLowerCase() !== "production";
  return {
    senderProfileId: sender.profileId,
    isTest,
    certKey: setting("CERT_KEY"),
    corpNum: setting("CORP_NUM").replace(/\D/g, ""),
    senderId: setting("SENDER_ID"),
    memberPassword: setting("MEMBER_PASSWORD"),
    fromNumber: fromNumber.replace(/\D/g, ""),
    ftpHost: isTest ? "testftp.barobill.co.kr" : "ftp.barobill.co.kr",
    ftpPort: isTest ? 9031 : 9030,
    apiUrl: isTest ? "https://testws.baroservice.com/FAX.asmx" : "https://ws.baroservice.com/FAX.asmx",
  };
}

function isBarobillConfigured(config: ReturnType<typeof barobillConfig>) {
  return Boolean(config.certKey && config.corpNum && config.senderId && config.memberPassword && config.fromNumber);
}

async function uploadBarobillBytes(fileName: string, bytes: Uint8Array, config: ReturnType<typeof barobillConfig>) {
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

async function uploadBarobillFile(fileName: string, content: string, config: ReturnType<typeof barobillConfig>) {
  await uploadBarobillBytes(fileName, new TextEncoder().encode(content), config);
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

async function barobillSoap(operation: string, params: Record<string, string>, config: ReturnType<typeof barobillConfig>) {
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

async function barobillErrorMessage(errorCode: string, config: ReturnType<typeof barobillConfig>) {
  try {
    return await barobillSoap("GetErrString", {
      CERTKEY: config.certKey,
      ErrCode: errorCode,
    }, config);
  } catch {
    return "";
  }
}

async function sendFax(sender: RequestSenderProfile, trader: string, recipient: string, recipientName: string, documents: DocumentRow[]) {
  const config = barobillConfig(sender);
  if (!isBarobillConfigured(config)) {
    throw new Error("바로빌 연동정보가 아직 설정되지 않았습니다.");
  }
  if (sender.businessRegistrationNo && sender.businessRegistrationNo.replace(/\D/g, "") !== config.corpNum) {
    throw new Error("기본 법인의 사업자번호와 바로빌 법인번호가 일치하지 않습니다.");
  }
  const fileName = `dbmt_doc_request_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.html`;
  await uploadBarobillFile(fileName, requestFaxHtml(sender, trader, documents), config);
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
  }, config);
  if (/^-\d{5}$/.test(sendKey)) {
    const detail = await barobillErrorMessage(sendKey, config);
    throw new Error(`바로빌 오류 ${sendKey}${detail ? `: ${detail}` : ""}`);
  }
  return {
    subject: requestSubject(sender, trader, documents),
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
  sender: RequestSenderProfile,
) {
  const config = barobillConfig(sender);
  if (!isBarobillConfigured(config)) {
    throw new Error("바로빌 연동정보가 아직 설정되지 않았습니다.");
  }
  if (sender.businessRegistrationNo && sender.businessRegistrationNo.replace(/\D/g, "") !== config.corpNum) {
    throw new Error("기본 법인의 사업자번호와 바로빌 법인번호가 일치하지 않습니다.");
  }
  const bytes = decodeJpegDataUrl(imageDataUrl);
  const fileName = `dbmt_cold_storage_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.jpg`;
  await uploadBarobillBytes(fileName, bytes, config);
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
  }, config);
  if (/^-\d{5}$/.test(sendKey)) {
    const detail = await barobillErrorMessage(sendKey, config);
    throw new Error(`바로빌 오류 ${sendKey}${detail ? `: ${detail}` : ""}`);
  }
  return {
    subject: `[${sender.displayName}] 냉동창고 ${requestType} 요청 - ${warehouse} (${itemCount}건)`,
    messageId: sendKey,
    providerStatus: config.isTest ? "테스트 접수" : "전송 접수",
  };
}

async function getColdStorageFaxStatus(messageId: string, sender: RequestSenderProfile) {
  const config = barobillConfig(sender);
  if (!config.certKey || !config.corpNum) throw new Error("바로빌 연동정보가 아직 설정되지 않았습니다.");
  const detailXml = await barobillSoap("GetFaxMessageEx2", {
    CERTKEY: config.certKey,
    CorpNum: config.corpNum,
    SendKey: messageId,
  }, config);
  const sendStateValue = xmlValue(detailXml, "SendState");
  if (sendStateValue === "") throw new Error("바로빌 팩스 상태를 확인할 수 없습니다.");
  const sendState = Number(sendStateValue);
  if (!Number.isInteger(sendState)) throw new Error("바로빌 팩스 상태를 확인할 수 없습니다.");
  if (sendState < 0) {
    const detail = await barobillErrorMessage(String(sendState), config);
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
  const [inventoryLocations, senderProfiles, appDataResult] = await Promise.all([
    getInventoryLocationProjection(supabase),
    getSenderProfileProjection(supabase),
    supabase.from("app_data")
    .select("key,payload")
    .in("key", ["coldStorageRequests", "traderInfoMap"]),
  ]);
  const { data, error } = appDataResult;
  if (error) throw new Error(`냉동창고 요청 데이터를 불러오지 못했습니다: ${error.message}`);
  const values = Object.fromEntries((data || []).map((row: any) => [row.key, row.payload]));
  const traderInfo = values.traderInfoMap && typeof values.traderInfoMap === "object" ? values.traderInfoMap : {};
  return {
    inventoryLocations,
    senderProfiles,
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
  const { data: existingRow, error: existingError } = await supabase.from("app_data")
    .select("payload")
    .eq("key", "coldStorageRequests")
    .maybeSingle();
  if (existingError) throw new Error(`기존 냉동창고 요청을 확인하지 못했습니다: ${existingError.message}`);
  const existingRequests = Array.isArray(existingRow?.payload) ? existingRow.payload : [];
  const existing = existingRequests.find((row: any) => clean(row?.id, 100) === record.id);
  const existingSnapshot = existing?.requesterSnapshot && typeof existing.requesterSnapshot === "object"
    ? existing.requesterSnapshot : null;
  record.requesterSnapshot = existing && clean(existing.requesterId, 50) === record.requesterId &&
      ["server_verified", "company_master"].includes(clean(existingSnapshot?.source, 30))
    ? existingSnapshot
    : await getRequesterSnapshot(supabase, record.requesterId);
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
  if (isPublicColdStorageAction && !(await verifyPublicAccessKey(payload.publicAccessKey))) {
    return jsonResponse(req, { error: "냉동창고 요청 접속코드를 확인해주세요." }, 401);
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

  if (requestedAction === "cold_storage_public_load") {
    try {
      return jsonResponse(req, { ok: true, ...(await getPublicColdStorageData(supabase)) });
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

  payload.action = (publicActionMap[requestedAction] || requestedAction) as DeliveryRequest["action"];
  if (payload.action === "capabilities" && !requestedSenderProfileId(payload)) {
    try {
      const senderProfiles = await getSenderProfileProjection(supabase);
      const defaultProfile = senderProfiles.find((profile: any) => profile.isDefault) || senderProfiles[0] || null;
      return jsonResponse(req, {
        email: Boolean(env("DAUM_SMTP_USER") && env("DAUM_SMTP_APP_PASSWORD") && env("DAUM_SMTP_FROM")),
        fax: Boolean(defaultProfile?.faxConfigured),
        faxProvider: "바로빌",
        faxMode: clean(defaultProfile?.faxMode, 20) || "테스트",
        senderProfileId: clean(defaultProfile?.id, 50),
        senderProfiles,
      });
    } catch (error) {
      return jsonResponse(req, { error: clean(error instanceof Error ? error.message : error, 1000) }, 502);
    }
  }
  let selectedSender: RequestSenderProfile;
  let faxConfig: ReturnType<typeof barobillConfig>;
  try {
    const includeInactive = payload.action === "cold_storage_fax_status";
    selectedSender = await getRequestSenderProfile(supabase, requestedSenderProfileId(payload), includeInactive);
    faxConfig = barobillConfig(selectedSender);
  } catch (error) {
    return jsonResponse(req, { error: clean(error instanceof Error ? error.message : error, 1000) }, 400);
  }
  const capabilities = {
    email: Boolean(env("DAUM_SMTP_USER") && env("DAUM_SMTP_APP_PASSWORD") && env("DAUM_SMTP_FROM")),
    fax: isBarobillConfigured(faxConfig),
    faxProvider: "바로빌",
    faxMode: faxConfig.isTest ? "테스트" : "운영",
    senderProfileId: selectedSender.profileId,
  };
  if (payload.action === "capabilities") {
    try {
      return jsonResponse(req, { ...capabilities, senderProfiles: await getSenderProfileProjection(supabase) });
    } catch (error) {
      return jsonResponse(req, { error: clean(error instanceof Error ? error.message : error, 1000) }, 502);
    }
  }

  if (payload.action === "cold_storage_fax_status") {
    const messageId = clean(payload.messageId, 30);
    if (!messageId || !/^[A-Za-z0-9_-]+$/.test(messageId)) {
      return jsonResponse(req, { error: "팩스 접수번호를 확인해주세요." }, 400);
    }
    if (!capabilities.fax) {
      return jsonResponse(req, { error: "바로빌 팩스 연동정보가 아직 설정되지 않았습니다." }, 503);
    }
    try {
      return jsonResponse(req, { ok: true, ...(await getColdStorageFaxStatus(messageId, selectedSender)) });
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
      const result = await sendColdStorageFax(warehouse, recipient, requestType, itemCount, imageDataUrl, selectedSender);
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
  const subject = requestSubject(selectedSender, trader, documents);
  try {
    const result = channel === "email"
      ? await sendEmail(selectedSender, trader, recipient, documents)
      : await sendFax(selectedSender, trader, recipient, recipientName, documents);
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
