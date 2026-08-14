(function(){
'use strict';

const STORAGE_KEY = 'dbmt_company_master_session';
const PUBLIC_MODE = window.DBMT_COLD_STORAGE_STANDALONE === true;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_RE = /^[a-z][a-z0-9_-]{1,49}$/;
const SENDER_CODE_RE = /^[a-z][a-z0-9_-]{1,49}$/;
const SECRET_ALIAS_RE = /^[a-z][a-z0-9_]{1,49}$/;

const LEGACY_MASTER = {
  companies: [
    {
      id: 'legacy_dongbumt', code: 'dongbumt', legalName: '주식회사 동부엠티', displayName: '동부엠티',
      englishName: '', representativeName: '이창성', corporateRegistrationNo: '1201110960816',
      sealAssetKey: 'assets/company-seal.png', logoAssetKey: '', isPrimary: true, active: true,
      isLegacyDraft: true, revision: null,
      sites: [{
        id: 'legacy_dongbumt_main', companyId: 'legacy_dongbumt', code: 'processing_plant', name: '가공장',
        siteType: 'factory', businessRegistrationNo: '495-88-01108', postalCode: '',
        roadAddress: '인천광역시 검단구 소담2로 36, 2동 201호 (금곡동)', detailAddress: '', englishAddress: '',
        businessType: '도매 및 소매업, 제조업', businessItems: '축산물유통전문, 식육포장처리업, 축산물무역업', email: 'dongbumt1812@hanmail.net',
        phone: '032-766-1812', fax: '032-232-1812', mobile: '',
        livestockBusinessLicenseNo: '제2025-0293093호', ownershipType: 'owned', inventoryLocation: true,
        operatorTraderKey: '', operatorName: '', isHeadOffice: true,
        isDefaultDocumentSite: true, active: true, isLegacyDraft: true, revision: null, identifiers: [
          {
            id: 'legacy_dongbumt_packaging_license', businessSiteId: 'legacy_dongbumt_main',
            provider: 'local_government', identifierType: 'meat_packaging_license', identifierValue: '2025-0293093',
            validFrom: '2025-12-29', validTo: '', active: true, revision: null, isLegacyDraft: true
          },
          {
            id: 'legacy_dongbumt_haccp', businessSiteId: 'legacy_dongbumt_main',
            provider: 'haccp', identifierType: 'certificate_no', identifierValue: '2026-3-0071',
            validFrom: '2026-02-04', validTo: '2029-02-03', active: true, revision: null, isLegacyDraft: true
          }
        ]
      }]
    }
  ],
  documentSenderProfiles: [
    {
      id: 'legacy_sender_dongbumt', code: 'dongbumt', label: '주식회사 동부엠티',
      businessSiteId: 'legacy_dongbumt_main', replyEmail: 'dongbumt1812@hanmail.net',
      replyFax: '032-232-1812', sealAssetKey: 'assets/company-seal.png', secretAlias: 'dongbumt',
      isDefault: true, active: true, isLegacyDraft: true, revision: null
    },
    {
      id: 'legacy_sender_dongbu_distribution', code: 'dongbu_distribution', label: '(주)동부축산유통',
      businessSiteId: '', replyEmail: '', replyFax: '032-578-0108',
      sealAssetKey: 'assets/company-seal-trading.png', secretAlias: 'dongbu_distribution',
      isDefault: false, active: true, isLegacyDraft: true, revision: null
    }
  ]
};

let companyMaster = PUBLIC_MODE ? null : readCachedMaster();
let masterSource = companyMaster ? 'cache' : (PUBLIC_MODE ? 'public' : 'legacy');
let rpcAvailable = null;
let serverEmpty = false;
let selectedCompanyKey = '';
let selectedSiteKey = '';
let selectedIdentifierKey = '';
let selectedSenderKey = '';
let companySavePending = false;

companyMaster = PUBLIC_MODE
  ? normalizePublicMaster({companies:[]})
  : mergeLegacyDrafts(companyMaster || LEGACY_MASTER);

function copy(value){
  return JSON.parse(JSON.stringify(value));
}

function text(value){
  return String(value ?? '').trim();
}

function bool(value, fallback=false){
  return value === undefined || value === null ? fallback : value !== false;
}

function numberOrNull(value){
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function escapeHtml(value){
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[char]));
}

function normalizeIdentifier(row={}){
  return {
    id:text(row.id), businessSiteId:text(row.businessSiteId || row.business_site_id),
    provider:text(row.provider), identifierType:text(row.identifierType || row.identifier_type),
    identifierValue:text(row.identifierValue || row.identifier_value),
    validFrom:text(row.validFrom || row.valid_from), validTo:text(row.validTo || row.valid_to),
    active:bool(row.active, true), revision:numberOrNull(row.revision),
    isLegacyDraft:row.isLegacyDraft === true
  };
}

function normalizeSite(row={}, companyId=''){
  const identifiers = Array.isArray(row.identifiers) ? row.identifiers.map(normalizeIdentifier) : [];
  return {
    id:text(row.id), companyId:text(row.companyId || row.company_id || companyId), code:text(row.code),
    name:text(row.name), siteType:text(row.siteType || row.site_type || 'office') || 'office',
    ownershipType:text(row.ownershipType || row.ownership_type || 'owned') || 'owned',
    inventoryLocation:row.inventoryLocation === true || row.inventory_location === true,
    operatorTraderKey:text(row.operatorTraderKey || row.operator_trader_key),
    operatorName:text(row.operatorName || row.operator_name),
    businessRegistrationNo:text(row.businessRegistrationNo || row.business_registration_no),
    postalCode:text(row.postalCode || row.postal_code), roadAddress:text(row.roadAddress || row.road_address),
    detailAddress:text(row.detailAddress || row.detail_address), englishAddress:text(row.englishAddress || row.english_address),
    businessType:text(row.businessType || row.business_type), businessItems:text(row.businessItems || row.business_items),
    email:text(row.email), phone:text(row.phone), fax:text(row.fax), mobile:text(row.mobile),
    livestockBusinessLicenseNo:text(row.livestockBusinessLicenseNo || row.livestock_business_license_no),
    isHeadOffice:row.isHeadOffice === true || row.is_head_office === true,
    isDefaultDocumentSite:row.isDefaultDocumentSite === true || row.is_default_document_site === true,
    active:bool(row.active, true), revision:numberOrNull(row.revision),
    isLegacyDraft:row.isLegacyDraft === true || text(row.id).startsWith('legacy_'), identifiers
  };
}

function normalizeSenderProfile(row={}){
  const id = text(row.id);
  return {
    id, code:text(row.code), label:text(row.label || row.name),
    businessSiteId:text(row.businessSiteId || row.business_site_id),
    replyEmail:text(row.replyEmail || row.reply_email), replyFax:text(row.replyFax || row.reply_fax),
    sealAssetKey:text(row.sealAssetKey || row.seal_asset_key),
    secretAlias:text(row.secretAlias || row.secret_alias),
    isDefault:row.isDefault === true || row.is_default === true,
    active:bool(row.active, true), revision:numberOrNull(row.revision),
    isLegacyDraft:row.isLegacyDraft === true || id.startsWith('legacy_')
  };
}

function normalizeCompany(row={}){
  const id = text(row.id);
  return {
    id, code:text(row.code), legalName:text(row.legalName || row.legal_name),
    displayName:text(row.displayName || row.display_name), englishName:text(row.englishName || row.english_name),
    representativeName:text(row.representativeName || row.representative_name),
    corporateRegistrationNo:text(row.corporateRegistrationNo || row.corporate_registration_no),
    sealAssetKey:text(row.sealAssetKey || row.seal_asset_key), logoAssetKey:text(row.logoAssetKey || row.logo_asset_key),
    isPrimary:row.isPrimary === true || row.is_primary === true, active:bool(row.active, true),
    revision:numberOrNull(row.revision), isLegacyDraft:row.isLegacyDraft === true || id.startsWith('legacy_'),
    sites:(Array.isArray(row.sites) ? row.sites : []).map(site=>normalizeSite(site,id))
  };
}

function normalizeMaster(value){
  const rows = Array.isArray(value?.companies) ? value.companies : (value?.company ? [value.company] : []);
  const normalizedCompanies = rows.map(normalizeCompany);
  const company = normalizedCompanies.find(row=>row.isPrimary && row.active !== false)
    || normalizedCompanies.find(row=>row.code === 'dongbumt') || normalizedCompanies[0] || null;
  const rawProfiles = value?.documentSenderProfiles || value?.senderProfiles || value?.document_sender_profiles || [];
  return {
    schemaVersion:Number(value?.schemaVersion || value?.schema_version || 1),
    company,
    companies:company ? [{...company, isPrimary:true, active:true}] : [],
    documentSenderProfiles:(Array.isArray(rawProfiles) ? rawProfiles : []).map(normalizeSenderProfile)
  };
}

// The standalone cold-storage page is intentionally given only the fields that
// are printed on a request form. It must never inherit the ERP's richer cache.
function normalizePublicMaster(value){
  const normalized = normalizeMaster(value);
  return {
    companies:normalized.companies.map(company=>({
      id:company.id, code:company.code, legalName:company.legalName,
      displayName:company.displayName, englishName:'', representativeName:company.representativeName,
      corporateRegistrationNo:'', sealAssetKey:company.sealAssetKey, logoAssetKey:'',
      isPrimary:company.isPrimary, active:company.active, revision:company.revision,
      isLegacyDraft:company.isLegacyDraft,
      sites:company.sites.map(site=>({
        id:site.id, companyId:site.companyId, code:site.code, name:site.name,
        siteType:site.siteType, ownershipType:site.ownershipType, inventoryLocation:site.inventoryLocation,
        operatorTraderKey:'', operatorName:site.operatorName, businessRegistrationNo:site.businessRegistrationNo,
        postalCode:site.postalCode, roadAddress:site.roadAddress, detailAddress:site.detailAddress,
        englishAddress:'', businessType:'', businessItems:'', email:'', phone:site.phone,
        fax:site.fax, mobile:'', livestockBusinessLicenseNo:'',
        isHeadOffice:site.isHeadOffice, isDefaultDocumentSite:site.isDefaultDocumentSite,
        active:site.active, revision:site.revision, isLegacyDraft:site.isLegacyDraft, identifiers:[]
      }))
    })),
    documentSenderProfiles:normalized.documentSenderProfiles.map(profile=>({
      id:profile.id, code:profile.code, label:profile.label, businessSiteId:profile.businessSiteId,
      replyEmail:profile.replyEmail, replyFax:profile.replyFax, sealAssetKey:profile.sealAssetKey,
      secretAlias:'', isDefault:profile.isDefault, active:profile.active, revision:profile.revision,
      isLegacyDraft:profile.isLegacyDraft
    }))
  };
}

function readCachedMaster(){
  if(PUBLIC_MODE) return null;
  try{
    // Company identifiers are kept for this browser tab only, not on a shared
    // PC after the session closes.
    localStorage.removeItem('dbmt_company_master_cache');
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    return Array.isArray(parsed?.companies) && parsed.companies.length ? parsed : null;
  }catch(error){
    return null;
  }
}

function persistMaster(){
  if(PUBLIC_MODE) return;
  try{ sessionStorage.setItem(STORAGE_KEY, JSON.stringify(companyMaster)); }
  catch(error){ console.warn('회사정보 캐시 저장 실패:', error); }
}

function mergeLegacyDrafts(remoteMaster){
  const remote = normalizeMaster(remoteMaster);
  const legacy = normalizeMaster(LEGACY_MASTER);
  if(!remote.companies.length) return legacy;
  const company = remote.companies[0];
  const legacyCompany = legacy.companies[0];
  if(!company.sites.length){
    company.sites = legacyCompany.sites.map(site=>({...site, companyId:company.id}));
  }
  legacy.documentSenderProfiles.forEach(legacyProfile=>{
    if(remote.documentSenderProfiles.some(profile=>profile.code === legacyProfile.code)) return;
    const linkedSite = company.sites.find(site=>site.code === 'main') || company.sites[0];
    remote.documentSenderProfiles.push({
      ...legacyProfile,
      businessSiteId:legacyProfile.code === 'dongbumt' ? (linkedSite?.id || '') : ''
    });
  });
  remote.company = company;
  return remote;
}

function formatBusinessNumber(value){
  const digits = text(value).replace(/\D/g,'');
  return digits.length === 10 ? `${digits.slice(0,3)}-${digits.slice(3,5)}-${digits.slice(5)}` : text(value);
}

function addressOf(site){
  return [text(site?.roadAddress), text(site?.detailAddress)].filter(Boolean).join(' ');
}

function profileFromCompany(company, preferredSiteId=''){
  if(!company) return null;
  const activeSites = company.sites.filter(site=>site.active !== false);
  const hasBusinessNumber = site=>/^\d{10}$/.test(text(site?.businessRegistrationNo).replace(/\D/g,''));
  const isRegisteredInternal = site=>site?.siteType !== 'external_warehouse' &&
    site?.ownershipType !== 'third_party' && hasBusinessNumber(site);
  const legalSite = activeSites.find(row=>row.isDefaultDocumentSite && isRegisteredInternal(row))
    || activeSites.find(row=>row.isHeadOffice && isRegisteredInternal(row))
    || activeSites.find(isRegisteredInternal)
    || activeSites.find(row=>row.isDefaultDocumentSite)
    || activeSites.find(row=>row.isHeadOffice) || activeSites[0];
  const preferredSite = activeSites.find(row=>row.id === preferredSiteId);
  const contactSite = preferredSite && preferredSite.siteType !== 'external_warehouse' && preferredSite.ownershipType !== 'third_party'
    ? preferredSite : legalSite;
  if(!contactSite) return null;
  const identitySite = hasBusinessNumber(contactSite) ? contactSite : legalSite;
  return {
    id:company.id, code:company.code, legalName:company.legalName, displayName:company.displayName || company.legalName,
    name:company.legalName, representativeName:company.representativeName, representative:company.representativeName,
    corporateRegistrationNo:company.corporateRegistrationNo,
    registrationNo:formatBusinessNumber(identitySite.businessRegistrationNo), businessRegistrationNo:formatBusinessNumber(identitySite.businessRegistrationNo),
    siteId:contactSite.id || '', siteCode:contactSite.code || '', siteName:contactSite.name || '',
    identitySiteId:identitySite.id || '', postalCode:identitySite.postalCode || '',
    address:addressOf(identitySite), roadAddress:identitySite.roadAddress || '', detailAddress:identitySite.detailAddress || '',
    businessType:identitySite.businessType || '', businessItems:identitySite.businessItems || '', email:contactSite.email || '',
    phone:contactSite.phone || '', fax:contactSite.fax || '', mobile:contactSite.mobile || '',
    livestockBusinessLicenseNo:contactSite.livestockBusinessLicenseNo || '',
    sealAssetKey:company.sealAssetKey || '', logoAssetKey:company.logoAssetKey || '',
    isPrimary:company.isPrimary, active:company.active,
    isLegacyDraft:company.isLegacyDraft || contactSite.isLegacyDraft || identitySite.isLegacyDraft
  };
}

function activeCompanies(){
  return companyMaster.companies.filter(company=>company.active !== false);
}

function getPrimaryProfile(){
  const rows = activeCompanies().filter(company=>company.sites.some(site=>site.active !== false));
  return profileFromCompany(rows.find(company=>company.isPrimary) || rows[0]);
}

function operationalSenderProfiles(includeInactive=false){
  const rows = Array.isArray(companyMaster.documentSenderProfiles) ? companyMaster.documentSenderProfiles : [];
  const persistedRows = rows.filter(profile=>profile.isLegacyDraft !== true);
  const authoritativeRows = persistedRows.length ? persistedRows : rows;
  return authoritativeRows.filter(profile=>includeInactive || profile.active !== false);
}

function getProfileByCode(code){
  const sender = operationalSenderProfiles().find(row=>row.code === code);
  const company = activeCompanies()[0];
  if(sender && company){
    const profile = profileFromCompany(company, sender.businessSiteId);
    if(!profile) return null;
    return {
      ...profile, code:sender.code, senderProfileCode:sender.code, senderLabel:sender.label,
      displayName:sender.label || profile.displayName, name:profile.name,
      email:sender.replyEmail || profile.email, fax:sender.replyFax || profile.fax,
      sealAssetKey:sender.sealAssetKey || profile.sealAssetKey,
      isLegacyDraft:sender.isLegacyDraft || profile.isLegacyDraft
    };
  }
  return profileFromCompany(companyMaster.companies.find(row=>row.code === code && row.active !== false));
}

function getSenderProfiles(){
  return copy(operationalSenderProfiles()
    .sort((a,b)=>Number(b.isDefault)-Number(a.isDefault) || a.label.localeCompare(b.label,'ko')));
}

function getInventoryLocations(){
  const company = activeCompanies()[0];
  if(!company) return [];
  return copy(company.sites.filter(site=>site.active !== false && site.inventoryLocation).map(site=>({
    id:site.id, code:site.code, name:site.name || site.code,
    type:site.siteType, siteType:site.siteType,
    ownership:site.ownershipType, ownershipType:site.ownershipType,
    operatorName:site.operatorName || '', operatorTraderKey:site.operatorTraderKey || '',
    fax:site.fax || '', phone:site.phone || '', address:addressOf(site)
  })));
}

function getRequesterMap(){
  return Object.fromEntries(getSenderProfiles().map(sender=>{
    const profile = getProfileByCode(sender.code);
    if(!profile) return null;
    const legacySeal = LEGACY_MASTER.documentSenderProfiles.find(row=>row.code === sender.code)?.sealAssetKey || '';
    const allowLegacySeal = masterSource === 'legacy' || sender.isLegacyDraft === true;
    return [sender.code, {
      name:profile.legalName || profile.name, legalName:profile.legalName,
      displayName:sender.label || profile.displayName,
      representative:profile.representativeName, registrationNo:profile.registrationNo,
      address:profile.address, phone:profile.phone, fax:profile.fax,
      email:profile.email, seal:profile.sealAssetKey || (allowLegacySeal ? legacySeal : ''),
      senderProfileCode:sender.code
    }];
  }).filter(Boolean));
}

function emitChanged(){
  applyCompanyDefaults();
  document.dispatchEvent(new CustomEvent('dbmt-company-master-changed', {
    detail:{source:masterSource, master:copy(companyMaster), primary:getPrimaryProfile(),
      senderProfiles:getSenderProfiles(), inventoryLocations:getInventoryLocations()}
  }));
}

function applyCompanyDefaults(){
  const profile = getPrimaryProfile();
  const authoritative = masterSource === 'server' || masterSource === 'cache' || masterSource === 'public';
  if(!profile && !authoritative) return;
  const header = document.getElementById('erp-company-title');
  if(header && profile){
    header.textContent = `${profile.displayName || profile.legalName} ERP 시스템`;
    document.title = `${profile.displayName || profile.legalName} ERP 시스템`;
  }
  try{
    if(typeof LBL_DEFAULTS === 'object'){
      const previous = {...LBL_DEFAULTS};
      LBL_DEFAULTS.licenseno = profile?.livestockBusinessLicenseNo || '';
      LBL_DEFAULTS.manufacturer = profile?.legalName || '';
      LBL_DEFAULTS.phone = profile?.phone || '';
      LBL_DEFAULTS.address = profile?.address || '';
      [['lbl-licenseno','licenseno'],['lbl-manufacturer','manufacturer'],['lbl-phone','phone'],['lbl-address','address']]
        .forEach(([id,key])=>{
          const input=document.getElementById(id);
          if(input && (!input.value || input.value === previous[key])) input.value=LBL_DEFAULTS[key];
        });
    }
  }catch(error){ /* standalone pages do not define LBL_DEFAULTS */ }
  try{
    if(typeof DEFAULTS === 'object'){
      DEFAULTS.licenseno = profile?.livestockBusinessLicenseNo || '';
      DEFAULTS.manufacturer = profile?.legalName || '';
      DEFAULTS.phone = profile?.phone || '';
      DEFAULTS.address = profile?.address || '';
    }
  }catch(error){ /* main ERP does not define DEFAULTS */ }
}

function setMaster(value, options={}){
  const normalized = PUBLIC_MODE ? normalizePublicMaster(value) : normalizeMaster(value);
  companyMaster = PUBLIC_MODE
    ? normalized
    : (options.mergeLegacy === false ? normalized : mergeLegacyDrafts(normalized));
  masterSource = options.source || 'server';
  if(options.persist !== false) persistMaster();
  ensureSelection();
  emitChanged();
  if(document.getElementById('p-company-master')) renderCompanyMasterPage();
  return copy(companyMaster);
}

async function loadRemote(password){
  if(PUBLIC_MODE) throw new Error('공용 화면에서는 ERP 회사정보 RPC를 직접 호출할 수 없습니다.');
  const appPassword = text(password || (typeof getSupabasePassword === 'function' ? getSupabasePassword() : ''));
  if(!appPassword) throw new Error('Supabase 연결 비밀번호가 없습니다.');
  if(typeof sbRpc !== 'function') throw new Error('Supabase RPC를 사용할 수 없습니다.');
  try{
    const result = await sbRpc('dbmt_get_company_master', {p_password:appPassword});
    rpcAvailable = true;
    const remote = normalizeMaster(result || {});
    serverEmpty = remote.companies.length === 0;
    setMaster(remote, {source:serverEmpty ? 'legacy' : 'server', mergeLegacy:true});
    return copy(remote);
  }catch(error){
    if(/Could not find|schema cache|dbmt_get_company_master|function/i.test(String(error?.message || error))) rpcAvailable = false;
    throw error;
  }
}

function currentPassword(){
  const password = typeof getSupabasePassword === 'function' ? text(getSupabasePassword()) : '';
  if(!password) throw new Error('Supabase 연결 후 회사정보를 저장할 수 있습니다.');
  return password;
}

function companyKey(company){ return company?.id || company?.code || ''; }
function siteKey(site){ return site?.id || site?.code || ''; }
function identifierKey(row){ return row?.id || `${row?.provider || ''}:${row?.identifierType || ''}`; }
function senderKey(row){ return row?.id || row?.code || ''; }

function selectedCompany(){
  return companyMaster.companies.find(company=>companyKey(company) === selectedCompanyKey) || null;
}

function selectedSite(){
  const company = selectedCompany();
  return company?.sites.find(site=>siteKey(site) === selectedSiteKey) || null;
}

function selectedSender(){
  return companyMaster.documentSenderProfiles.find(profile=>senderKey(profile) === selectedSenderKey) || null;
}

function ensureSelection(){
  let company = selectedCompany();
  if(!company){
    company = companyMaster.companies.find(row=>row.isPrimary && row.active) || companyMaster.companies[0] || null;
    selectedCompanyKey = companyKey(company);
  }
  if(company){
    let site = company.sites.find(row=>siteKey(row) === selectedSiteKey);
    if(!site) site = company.sites.find(row=>row.isDefaultDocumentSite && row.active) || company.sites[0] || null;
    selectedSiteKey = siteKey(site);
  }else{
    selectedSiteKey = '';
  }
  let sender = selectedSender();
  if(!sender){
    sender = companyMaster.documentSenderProfiles.find(row=>row.isDefault && row.active)
      || companyMaster.documentSenderProfiles[0] || null;
    selectedSenderKey = senderKey(sender);
  }
}

function field(id){ return document.getElementById(id); }
function fieldValue(id){ return text(field(id)?.value); }
function setField(id, value=''){
  const element = field(id);
  if(element) element.value = value ?? '';
}
function setChecked(id, value){ const element=field(id); if(element) element.checked=!!value; }

function showMessage(message, isError=false){
  const element = field('cm-inline-message');
  if(element){ element.textContent=message || ''; element.style.color=isError ? '#7a2f2f' : '#4f5962'; }
  if(message && typeof toast === 'function') toast(message, isError ? 3500 : 2200);
}

function sourceMessage(){
  if(rpcAvailable === false) return '<strong>서버 스키마 설치 필요</strong><br>회사정보 화면은 사용할 수 있지만, M01 SQL을 적용하기 전에는 중앙 저장할 수 없습니다.';
  if(masterSource === 'server' && !companyMaster.companies.some(row=>row.isLegacyDraft) && !companyMaster.documentSenderProfiles.some(row=>row.isLegacyDraft)) return '<strong>중앙 기준정보 사용 중</strong><br>단일 법인 아래의 사업장·창고와 별도 발신 프로필을 문서·라벨·재고 기능이 함께 사용합니다.';
  if(masterSource === 'server') return '<strong>중앙 정보 + 미확인 기존값</strong><br>서버에 저장되지 않은 사업장 또는 발신 프로필은 “미확인”으로 표시됩니다.';
  if(masterSource === 'cache') return '<strong>최근 서버 캐시 사용 중</strong><br>Supabase 연결 후 새로고침하여 최신 기준정보를 확인하세요.';
  return '<strong>기존 문서에서 수집한 임시값</strong><br>법인·사업장·창고·발신 프로필을 증빙과 대조한 뒤 각각 중앙 서버에 저장하세요.';
}

function renderCompanyMasterPage(){
  const root = document.getElementById('p-company-master');
  if(!root) return;
  ensureSelection();
  const source = field('cm-source-status');
  if(source) source.innerHTML = sourceMessage();
  renderCompanyForm();
  renderSiteTabs();
  renderSiteForm();
  renderSenderTabs();
  renderSenderForm();
  renderIdentifiers();
}

function renderCompanyForm(){
  const company = selectedCompany();
  setField('cm-company-id', company?.id || ''); setField('cm-company-revision', company?.revision || '');
  setField('cm-company-code', company?.code || ''); setField('cm-company-legal-name', company?.legalName || '');
  setField('cm-company-display-name', company?.displayName || ''); setField('cm-company-english-name', company?.englishName || '');
  setField('cm-company-representative', company?.representativeName || ''); setField('cm-company-corporate-no', company?.corporateRegistrationNo || '');
  setField('cm-company-seal', company?.sealAssetKey || ''); setField('cm-company-logo', company?.logoAssetKey || '');
  const codeInput = field('cm-company-code');
  if(codeInput) codeInput.readOnly = true;
  const label = field('cm-company-form-title');
  if(label) label.textContent = company ? `법인 기본정보 · ${company.legalName || company.code}` : '법인 기본정보';
}

function renderSiteTabs(){
  const box = field('cm-site-tabs');
  const company = selectedCompany();
  if(!box) return;
  if(!company?.sites.length){ box.innerHTML='<span class="cm-empty" style="padding:4px 0;">등록된 사업장·창고가 없습니다.</span>'; return; }
  box.innerHTML = company.sites.map(site=>`<button type="button" class="cm-site-tab${siteKey(site)===selectedSiteKey?' active':''}" data-site-key="${escapeHtml(siteKey(site))}">${escapeHtml(site.name || site.code)}${site.inventoryLocation?' · 재고':''}${site.isDefaultDocumentSite?' · 문서기본':''}${site.isLegacyDraft?' · 미확인':''}</button>`).join('');
  box.querySelectorAll('[data-site-key]').forEach(button=>button.addEventListener('click',()=>selectSite(button.dataset.siteKey)));
}

function renderSiteForm(){
  const site = selectedSite();
  setField('cm-site-id', site?.id || ''); setField('cm-site-revision', site?.revision || '');
  setField('cm-site-code', site?.code || ''); setField('cm-site-name', site?.name || ''); setField('cm-site-type', site?.siteType || 'office');
  setField('cm-site-ownership', site?.ownershipType || 'owned');
  setField('cm-site-operator-key', site?.operatorTraderKey || ''); setField('cm-site-operator-name', site?.operatorName || '');
  setField('cm-site-business-no', formatBusinessNumber(site?.businessRegistrationNo || '')); setField('cm-site-postal', site?.postalCode || '');
  setField('cm-site-road-address', site?.roadAddress || ''); setField('cm-site-detail-address', site?.detailAddress || '');
  setField('cm-site-english-address', site?.englishAddress || ''); setField('cm-site-business-type', site?.businessType || '');
  setField('cm-site-business-items', site?.businessItems || ''); setField('cm-site-email', site?.email || '');
  setField('cm-site-phone', site?.phone || ''); setField('cm-site-fax', site?.fax || ''); setField('cm-site-mobile', site?.mobile || '');
  setField('cm-site-license', site?.livestockBusinessLicenseNo || '');
  setChecked('cm-site-inventory', site?.inventoryLocation); setChecked('cm-site-head', site?.isHeadOffice);
  setChecked('cm-site-default', site?.isDefaultDocumentSite); setChecked('cm-site-active', site ? site.active : true);
  syncSiteTypeFields();
  const codeInput = field('cm-site-code');
  if(codeInput) codeInput.readOnly = !!(site && UUID_RE.test(site.id));
  const title = field('cm-site-form-title');
  if(title) title.textContent = site ? `사업장·창고 정보 · ${site.name || site.code}` : '새 사업장·창고';
}

function renderSenderTabs(){
  const box = field('cm-sender-tabs');
  if(!box) return;
  const profiles = companyMaster.documentSenderProfiles;
  if(!profiles.length){ box.innerHTML='<span class="cm-empty" style="padding:4px 0;">등록된 발신 프로필이 없습니다.</span>'; return; }
  box.innerHTML = profiles.map(profile=>`<button type="button" class="cm-site-tab${senderKey(profile)===selectedSenderKey?' active':''}" data-sender-key="${escapeHtml(senderKey(profile))}">${escapeHtml(profile.label || profile.code)}${profile.isDefault?' · 기본':''}${!profile.active?' · 중지':''}${profile.isLegacyDraft?' · 미확인':''}</button>`).join('');
  box.querySelectorAll('[data-sender-key]').forEach(button=>button.addEventListener('click',()=>selectSender(button.dataset.senderKey)));
}

function renderSenderForm(){
  const profile = selectedSender();
  setField('cm-sender-id', profile?.id || ''); setField('cm-sender-revision', profile?.revision || '');
  setField('cm-sender-code', profile?.code || ''); setField('cm-sender-label', profile?.label || '');
  setField('cm-sender-email', profile?.replyEmail || ''); setField('cm-sender-fax', profile?.replyFax || '');
  setField('cm-sender-seal', profile?.sealAssetKey || ''); setField('cm-sender-secret-alias', profile?.secretAlias || '');
  const siteSelect = field('cm-sender-site');
  if(siteSelect){
    const company = selectedCompany();
    siteSelect.innerHTML = '<option value="">연결 안 함</option>' + (company?.sites || [])
      .filter(site=>UUID_RE.test(site.id) && site.active !== false &&
        site.siteType !== 'external_warehouse' && site.ownershipType !== 'third_party')
      .map(site=>`<option value="${escapeHtml(site.id)}">${escapeHtml(site.name || site.code)}</option>`).join('');
    siteSelect.value = profile?.businessSiteId || '';
  }
  setChecked('cm-sender-default', profile?.isDefault); setChecked('cm-sender-active', profile ? profile.active : true);
  const codeInput = field('cm-sender-code');
  if(codeInput) codeInput.readOnly = !!(profile && UUID_RE.test(profile.id));
  const aliasInput = field('cm-sender-secret-alias');
  if(aliasInput) aliasInput.readOnly = !!(profile && UUID_RE.test(profile.id));
  const title = field('cm-sender-form-title');
  if(title) title.textContent = profile ? `발신 프로필 · ${profile.label || profile.code}` : '새 발신 프로필';
}

function renderIdentifiers(){
  const body = field('cm-identifier-body');
  const site = selectedSite();
  if(!body) return;
  if(!site?.identifiers.length){ body.innerHTML='<tr><td colspan="6" class="cm-empty">등록된 외부기관 식별번호가 없습니다.</td></tr>'; }
  else body.innerHTML = site.identifiers.map(row=>`<tr>
    <td>${escapeHtml(row.provider)}</td><td>${escapeHtml(row.identifierType)}</td><td>${escapeHtml(row.identifierValue)}</td>
    <td>${escapeHtml(row.validFrom || '-')} ~ ${escapeHtml(row.validTo || '-')}</td><td>${row.active?'사용':'중지'}</td>
    <td><button type="button" class="btn btn-secondary btn-sm" data-identifier-key="${escapeHtml(identifierKey(row))}">수정</button></td>
  </tr>`).join('');
  body.querySelectorAll('[data-identifier-key]').forEach(button=>button.addEventListener('click',()=>editIdentifier(button.dataset.identifierKey)));
}

function selectCompany(key){
  selectedCompanyKey = text(key); selectedSiteKey=''; selectedIdentifierKey=''; ensureSelection(); renderCompanyMasterPage();
}

function selectSite(key){
  selectedSiteKey=text(key); selectedIdentifierKey=''; renderCompanyMasterPage(); clearIdentifierForm();
}

function selectSender(key){
  selectedSenderKey=text(key); renderSenderTabs(); renderSenderForm();
}

function newCompany(){
  ensureSelection(); renderCompanyMasterPage();
  showMessage('이 ERP는 법인 1개만 관리합니다. 현재 법인 기본정보를 수정하세요.');
}

function newSite(){
  if(!selectedCompany()){ showMessage('먼저 법인 기본정보를 저장하세요.', true); return; }
  selectedSiteKey=''; selectedIdentifierKey=''; renderSiteTabs(); renderSiteForm(); renderIdentifiers();
  setChecked('cm-site-active',true); setChecked('cm-site-inventory',false); setChecked('cm-site-head',false); setChecked('cm-site-default',false);
  const codeInput=field('cm-site-code'); if(codeInput){codeInput.readOnly=false;codeInput.focus();}
}

function newSender(){
  selectedSenderKey=''; renderSenderTabs(); renderSenderForm();
  setChecked('cm-sender-active',true); setChecked('cm-sender-default',companyMaster.documentSenderProfiles.every(row=>!row.active));
  const codeInput=field('cm-sender-code'); if(codeInput){codeInput.readOnly=false;codeInput.focus();}
  const aliasInput=field('cm-sender-secret-alias'); if(aliasInput) aliasInput.readOnly=false;
}

function syncSiteTypeFields(){
  const siteType = fieldValue('cm-site-type') || 'office';
  const ownership = field('cm-site-ownership');
  const inventory = field('cm-site-inventory');
  const headOffice = field('cm-site-head');
  if(siteType === 'head_office' && headOffice) headOffice.checked=true;
  if(siteType === 'external_warehouse'){
    if(ownership) ownership.value='third_party';
    if(inventory) inventory.checked=true;
  }else if(siteType === 'warehouse' && inventory){
    inventory.checked=true;
  }
}

async function saveCompany(){
  if(companySavePending) return;
  const code=fieldValue('cm-company-code'); const legalName=fieldValue('cm-company-legal-name');
  const displayName=fieldValue('cm-company-display-name') || legalName; const representativeName=fieldValue('cm-company-representative');
  if(!CODE_RE.test(code)){ showMessage('회사 코드는 영문 소문자로 시작하고 영문·숫자·밑줄·하이픈만 사용할 수 있습니다.',true); return; }
  if(!legalName || !representativeName){ showMessage('법인명과 대표자명을 입력하세요.',true); return; }
  const selected=selectedCompany();
  const serverId=UUID_RE.test(fieldValue('cm-company-id')) ? fieldValue('cm-company-id') : null;
  const record={
    code, legalName, displayName, englishName:fieldValue('cm-company-english-name'), representativeName,
    corporateRegistrationNo:fieldValue('cm-company-corporate-no').replace(/\D/g,''),
    sealAssetKey:fieldValue('cm-company-seal'), logoAssetKey:fieldValue('cm-company-logo'),
    isPrimary:true, active:true
  };
  if(serverId) record.id=serverId;
  try{
    companySavePending=true; toggleSaveButtons(true); showMessage('회사정보를 서버에 저장하는 중입니다...');
    const password=currentPassword();
    await sbRpc('dbmt_save_company', {p_password:password,p_record:record,p_expected_revision:serverId ? Number(fieldValue('cm-company-revision')) : null});
    await loadRemote(password);
    const saved=companyMaster.companies.find(row=>row.code===code);
    selectedCompanyKey=companyKey(saved); selectedSiteKey=''; ensureSelection(); renderCompanyMasterPage();
    showMessage(`${legalName} 법인 기본정보를 저장했습니다.`);
  }catch(error){ showMessage(`법인 기본정보 저장 실패: ${error?.message || error}`,true); }
  finally{ companySavePending=false; toggleSaveButtons(false); }
}

async function saveSite(){
  if(companySavePending) return;
  const company=selectedCompany();
  if(!company || !UUID_RE.test(company.id)){ showMessage('법인 기본정보를 먼저 중앙 서버에 저장한 뒤 사업장·창고를 저장하세요.',true); return; }
  const code=fieldValue('cm-site-code'); const name=fieldValue('cm-site-name');
  const businessNo=fieldValue('cm-site-business-no').replace(/\D/g,''); const roadAddress=fieldValue('cm-site-road-address');
  if(!CODE_RE.test(code)){ showMessage('사업장 코드는 영문 소문자로 시작하고 영문·숫자·밑줄·하이픈만 사용할 수 있습니다.',true); return; }
  if(!name || (businessNo && businessNo.length!==10) || !roadAddress){ showMessage('장소명, 사업자번호(입력한 경우 10자리), 도로명주소를 확인하세요.',true); return; }
  const email=fieldValue('cm-site-email');
  if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ showMessage('이메일 주소 형식을 확인하세요.',true); return; }
  syncSiteTypeFields();
  const siteType=fieldValue('cm-site-type') || 'office';
  const ownershipType=fieldValue('cm-site-ownership') || 'owned';
  const isHeadOffice=!!field('cm-site-head')?.checked;
  const isDefaultDocumentSite=!!field('cm-site-default')?.checked;
  if(isHeadOffice && (siteType==='external_warehouse' || ownershipType==='third_party')){ showMessage('본점은 당사 내부 사업장으로 등록해야 합니다.',true); return; }
  if(isDefaultDocumentSite && (siteType==='external_warehouse' || ownershipType==='third_party' || businessNo.length!==10)){ showMessage('문서 기본 장소는 사업자번호가 있는 당사 내부 사업장이어야 합니다.',true); return; }
  const serverId=UUID_RE.test(fieldValue('cm-site-id')) ? fieldValue('cm-site-id') : null;
  const record={
    companyId:company.id, code, name, siteType,
    ownershipType, inventoryLocation:!!field('cm-site-inventory')?.checked,
    operatorTraderKey:fieldValue('cm-site-operator-key'), operatorName:fieldValue('cm-site-operator-name'),
    businessRegistrationNo:businessNo,
    postalCode:fieldValue('cm-site-postal'), roadAddress, detailAddress:fieldValue('cm-site-detail-address'),
    englishAddress:fieldValue('cm-site-english-address'), businessType:fieldValue('cm-site-business-type'),
    businessItems:fieldValue('cm-site-business-items'), email, phone:fieldValue('cm-site-phone'), fax:fieldValue('cm-site-fax'),
    mobile:fieldValue('cm-site-mobile'), livestockBusinessLicenseNo:fieldValue('cm-site-license'),
    isHeadOffice, isDefaultDocumentSite,
    active:!!field('cm-site-active')?.checked
  };
  if(serverId) record.id=serverId;
  try{
    companySavePending=true; toggleSaveButtons(true); showMessage('사업장정보를 서버에 저장하는 중입니다...');
    const password=currentPassword();
    await sbRpc('dbmt_save_business_site', {p_password:password,p_record:record,p_expected_revision:serverId ? Number(fieldValue('cm-site-revision')) : null});
    await loadRemote(password);
    const savedCompany=companyMaster.companies.find(row=>row.id===company.id || row.code===company.code);
    selectedCompanyKey=companyKey(savedCompany);
    const savedSite=savedCompany?.sites.find(row=>row.code===code); selectedSiteKey=siteKey(savedSite);
    renderCompanyMasterPage(); showMessage(`${name} 사업장·창고 정보를 저장했습니다.`);
  }catch(error){ showMessage(`사업장·창고 정보 저장 실패: ${error?.message || error}`,true); }
  finally{ companySavePending=false; toggleSaveButtons(false); }
}

async function saveSender(){
  if(companySavePending) return;
  const code=fieldValue('cm-sender-code'); const label=fieldValue('cm-sender-label');
  const secretAlias=fieldValue('cm-sender-secret-alias'); const replyEmail=fieldValue('cm-sender-email');
  if(!SENDER_CODE_RE.test(code)){ showMessage('발신 프로필 코드는 영문 소문자로 시작하고 영문·숫자·밑줄·하이픈만 사용할 수 있습니다.',true); return; }
  if(!label){ showMessage('발신 프로필 표시명을 입력하세요.',true); return; }
  if(!SECRET_ALIAS_RE.test(secretAlias)){ showMessage('서버 비밀키 별칭은 영문 소문자로 시작하고 영문·숫자·밑줄만 사용할 수 있습니다.',true); return; }
  if(replyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyEmail)){ showMessage('회신 이메일 주소 형식을 확인하세요.',true); return; }
  const serverId=UUID_RE.test(fieldValue('cm-sender-id')) ? fieldValue('cm-sender-id') : null;
  const record={
    code, label, businessSiteId:fieldValue('cm-sender-site') || null,
    replyEmail, replyFax:fieldValue('cm-sender-fax'), sealAssetKey:fieldValue('cm-sender-seal'),
    secretAlias, isDefault:!!field('cm-sender-default')?.checked, active:!!field('cm-sender-active')?.checked
  };
  if(serverId) record.id=serverId;
  try{
    companySavePending=true; toggleSaveButtons(true); showMessage('발신 프로필을 서버에 저장하는 중입니다...');
    const password=currentPassword();
    await sbRpc('dbmt_save_document_sender_profile', {p_password:password,p_record:record,p_expected_revision:serverId ? Number(fieldValue('cm-sender-revision')) : null});
    await loadRemote(password);
    selectedSenderKey=senderKey(companyMaster.documentSenderProfiles.find(row=>row.code===code));
    renderCompanyMasterPage(); showMessage(`${label} 발신 프로필을 저장했습니다.`);
  }catch(error){ showMessage(`발신 프로필 저장 실패: ${error?.message || error}`,true); }
  finally{ companySavePending=false; toggleSaveButtons(false); }
}

function toggleSaveButtons(disabled){
  ['cm-save-company','cm-save-site','cm-save-sender','cm-save-identifier','cm-refresh'].forEach(id=>{const element=field(id);if(element) element.disabled=disabled;});
}

function clearIdentifierForm(){
  selectedIdentifierKey='';
  ['cm-identifier-id','cm-identifier-revision','cm-identifier-provider','cm-identifier-type','cm-identifier-value','cm-identifier-from','cm-identifier-to'].forEach(id=>setField(id,''));
  setChecked('cm-identifier-active',true);
}

function editIdentifier(key){
  const row=selectedSite()?.identifiers.find(item=>identifierKey(item)===key);
  if(!row) return;
  selectedIdentifierKey=key; setField('cm-identifier-id',row.id); setField('cm-identifier-revision',row.revision || '');
  setField('cm-identifier-provider',row.provider); setField('cm-identifier-type',row.identifierType);
  setField('cm-identifier-value',row.identifierValue); setField('cm-identifier-from',row.validFrom); setField('cm-identifier-to',row.validTo);
  setChecked('cm-identifier-active',row.active);
}

async function saveIdentifier(){
  const site=selectedSite();
  if(!site || !UUID_RE.test(site.id)){ showMessage('사업장을 먼저 중앙 서버에 저장하세요.',true); return; }
  const provider=fieldValue('cm-identifier-provider'); const identifierType=fieldValue('cm-identifier-type');
  const identifierValue=fieldValue('cm-identifier-value');
  if(!CODE_RE.test(provider) || !CODE_RE.test(identifierType) || !identifierValue){ showMessage('기관·식별자 종류는 영문 소문자 코드로, 식별번호는 실제 값을 입력하세요.',true); return; }
  const serverId=UUID_RE.test(fieldValue('cm-identifier-id')) ? fieldValue('cm-identifier-id') : null;
  const record={businessSiteId:site.id,provider,identifierType,identifierValue,validFrom:fieldValue('cm-identifier-from') || null,validTo:fieldValue('cm-identifier-to') || null,active:!!field('cm-identifier-active')?.checked};
  if(serverId) record.id=serverId;
  try{
    companySavePending=true;toggleSaveButtons(true);const password=currentPassword();
    await sbRpc('dbmt_save_business_site_identifier',{p_password:password,p_record:record,p_expected_revision:serverId ? Number(fieldValue('cm-identifier-revision')) : null});
    const companyCode=selectedCompany()?.code; const siteCode=site.code;
    await loadRemote(password); const company=companyMaster.companies.find(row=>row.code===companyCode);
    selectedCompanyKey=companyKey(company);selectedSiteKey=siteKey(company?.sites.find(row=>row.code===siteCode));
    clearIdentifierForm();renderCompanyMasterPage();showMessage('외부기관 식별번호를 저장했습니다.');
  }catch(error){showMessage(`식별번호 저장 실패: ${error?.message || error}`,true);}
  finally{companySavePending=false;toggleSaveButtons(false);}
}

async function refreshCompanyMaster(){
  try{ toggleSaveButtons(true); showMessage('중앙 기준정보를 불러오는 중입니다...'); await loadRemote(currentPassword()); renderCompanyMasterPage(); showMessage('법인·사업장·발신 프로필을 새로고침했습니다.'); }
  catch(error){ showMessage(`기준정보 새로고침 실패: ${error?.message || error}`,true); }
  finally{ toggleSaveButtons(false); }
}

const companyMasterApi = {
  getMaster:()=>copy(companyMaster), getPrimaryProfile, getProfileByCode, getRequesterMap,
  getSenderProfiles, getInventoryLocations,
  getSource:()=>masterSource, isRpcAvailable:()=>rpcAvailable, isServerEmpty:()=>serverEmpty,
  setMaster, applyDefaults:applyCompanyDefaults
};
if(!PUBLIC_MODE){
  companyMasterApi.loadRemote = loadRemote;
  window.initCompanyMasterPage = renderCompanyMasterPage;
  window.renderCompanyMasterPage = renderCompanyMasterPage;
  window.selectCompanyMaster = selectCompany;
  window.newCompanyMasterRecord = newCompany;
  window.newCompanyBusinessSite = newSite;
  window.syncCompanyBusinessSiteType = syncSiteTypeFields;
  window.newDocumentSenderProfile = newSender;
  window.saveCompanyMasterRecord = saveCompany;
  window.saveCompanyBusinessSite = saveSite;
  window.saveDocumentSenderProfile = saveSender;
  window.clearCompanyIdentifierForm = clearIdentifierForm;
  window.saveCompanySiteIdentifier = saveIdentifier;
  window.refreshCompanyMaster = refreshCompanyMaster;
}
window.DBMTCompanyMaster = companyMasterApi;

applyCompanyDefaults();
document.addEventListener('DOMContentLoaded',()=>{
  applyCompanyDefaults();
  if(document.getElementById('p-company-master')) renderCompanyMasterPage();
});

})();
