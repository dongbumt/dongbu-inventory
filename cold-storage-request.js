(function(){
'use strict';

const COLD_STORAGE_REQUEST_STORAGE_KEY = 'dbmt_cold_storage_requests';
const COLD_STORAGE_REQUEST_MAX_ITEMS = 10;
const COLD_STORAGE_CANVAS_WIDTH = 1240;
const COLD_STORAGE_CANVAS_HEIGHT = 1754;
const COLD_STORAGE_REQUESTERS = {
  dongbumt:{
    name:'주식회사 동부엠티', representative:'이창성', registrationNo:'495-88-01108',
    address:'인천광역시 검단구 소담2로36, 2동 201호',
    phone:'032-766-1812', fax:'032-232-1812', seal:'assets/company-seal.png'
  },
  dongbu_distribution:{
    name:'(주)동부축산유통', representative:'이동대', registrationNo:'137-81-38748',
    address:'인천광역시 서해구 가좌로96번길 11',
    phone:'032-579-3920', fax:'032-578-0108', seal:'assets/company-seal-trading.png'
  }
};
const COLD_STORAGE_MANAGERS = {
  '배은정 실장':'010-7147-5409',
  '김상영 본부장':'010-2414-5406'
};

let coldStorageRequests = [];
try{
  const cached = JSON.parse(localStorage.getItem(COLD_STORAGE_REQUEST_STORAGE_KEY) || '[]');
  coldStorageRequests = Array.isArray(cached) ? cached : [];
}catch(e){ coldStorageRequests = []; }

let coldStorageDraft = null;
let coldStorageEditingId = '';
let coldStoragePreviewTimer = null;
let coldStoragePreviewSerial = 0;
const coldStorageSealPromises = new Map();
let coldStorageRefreshPromise = null;
let coldStorageFaxCapabilities = {fax:false, faxProvider:'바로빌', faxMode:'테스트'};

function coldStorageId(prefix='csr'){
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
}

function coldStorageToday(){
  return typeof localDateString === 'function' ? localDateString() : new Date().toISOString().slice(0,10);
}

function coldStorageBlankItem(){
  return {id:coldStorageId('csri'), destination:'', product:'', spec:'', unit:'BOX', quantity:'', lot:''};
}

function coldStorageBlankDraft(){
  return {
    id:'', requestDate:coldStorageToday(), requestType:'출고', requesterId:'dongbumt', warehouse:'', fax:'',
    managerName:'배은정 실장', managerPhone:'010-7147-5409', note:'',
    items:[coldStorageBlankItem()], status:'draft', createdAt:'', updatedAt:'',
    sentAt:'', providerMessageId:'', providerStatus:'', errorMessage:'',
    faxSendState:null, faxResult:'', faxSendPageCount:0, faxSuccessPageCount:0,
    faxSendDateTime:'', faxEndDateTime:'', faxStatusCheckedAt:''
  };
}

function normalizeColdStorageItem(item={}){
  return {...coldStorageBlankItem(), ...item, id:item.id || coldStorageId('csri')};
}

function normalizeColdStorageRequest(record={}){
  const items = Array.isArray(record.items) && record.items.length ? record.items : [coldStorageBlankItem()];
  const managerName = record.managerName === '김상영 과장' ? '김상영 본부장' : record.managerName;
  return {
    ...coldStorageBlankDraft(),
    ...record,
    requestType:record.requestType === '이체' ? '이체' : '출고',
    requesterId:COLD_STORAGE_REQUESTERS[record.requesterId] ? record.requesterId : 'dongbumt',
    managerName:COLD_STORAGE_MANAGERS[managerName] ? managerName : '배은정 실장',
    managerPhone:COLD_STORAGE_MANAGERS[managerName] || '010-7147-5409',
    faxSendState:record.faxSendState === null || record.faxSendState === undefined || record.faxSendState === ''
      ? null : Number(record.faxSendState),
    faxSendPageCount:Number(record.faxSendPageCount) || 0,
    faxSuccessPageCount:Number(record.faxSuccessPageCount) || 0,
    items:items.slice(0,COLD_STORAGE_REQUEST_MAX_ITEMS).map(normalizeColdStorageItem)
  };
}

function coldStorageRequester(requesterId){
  return COLD_STORAGE_REQUESTERS[requesterId] || COLD_STORAGE_REQUESTERS.dongbumt;
}

coldStorageRequests = coldStorageRequests.map(normalizeColdStorageRequest);

function coldStorageOutputItems(record=coldStorageDraft){
  return (record?.items || []).filter(item =>
    [item.destination,item.product,item.spec,item.unit,item.quantity,item.lot]
      .some(value=>String(value ?? '').trim())
  );
}

function coldStorageNumber(value){
  const number = Number(String(value ?? '').replace(/,/g,''));
  return Number.isFinite(number) ? number : 0;
}

function coldStorageFormatQuantity(value){
  const number = coldStorageNumber(value);
  if(!number) return '';
  return number.toLocaleString('ko-KR',{maximumFractionDigits:2});
}

function coldStorageFormatDateTime(value){
  if(!value) return '-';
  const date = new Date(value);
  if(Number.isNaN(date.getTime())) return String(value);
  const pad = number=>String(number).padStart(2,'0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function coldStorageFormatBarobillDateTime(value){
  const match = String(value || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if(!match) return value ? coldStorageFormatDateTime(value) : '';
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
}

function coldStorageWarehouseEntries(){
  if(typeof traderInfoMap !== 'object' || !traderInfoMap) return [];
  return Object.entries(traderInfoMap)
    .filter(([,info])=>String(info?.tradeType || '') === '보관(냉동창고)')
    .sort((a,b)=>a[0].localeCompare(b[0],'ko',{numeric:true}));
}

function coldStoragePopulateOptions(){
  const warehouseList = document.getElementById('csr-warehouse-list');
  if(warehouseList){
    warehouseList.innerHTML = coldStorageWarehouseEntries()
      .map(([name])=>`<option value="${htmlEscape(name)}"></option>`).join('');
  }

  const destinationList = document.getElementById('csr-destination-list');
  if(destinationList && typeof traderInfoMap === 'object' && traderInfoMap){
    destinationList.innerHTML = Object.keys(traderInfoMap).sort((a,b)=>a.localeCompare(b,'ko',{numeric:true}))
      .map(name=>`<option value="${htmlEscape(name)}"></option>`).join('');
  }

  const productNames = new Set();
  if(Array.isArray(window.labelProducts)){
    window.labelProducts.forEach(item=>{ if(item?.name) productNames.add(String(item.name).trim()); });
  }else if(typeof labelProducts !== 'undefined' && Array.isArray(labelProducts)){
    labelProducts.forEach(item=>{ if(item?.name) productNames.add(String(item.name).trim()); });
  }
  try{
    if(typeof getStockMap === 'function'){
      Object.values(getStockMap()).forEach(item=>{
        if(Number(item?.stock || 0) > 0.01 && item?.product) productNames.add(String(item.product).trim());
      });
    }
  }catch(e){ console.warn('냉동창고 요청 품목 후보 생성 실패:',e); }
  const productList = document.getElementById('csr-product-list');
  if(productList){
    productList.innerHTML = [...productNames].filter(Boolean).sort((a,b)=>a.localeCompare(b,'ko',{numeric:true}))
      .map(name=>`<option value="${htmlEscape(name)}"></option>`).join('');
  }
}

function syncColdStorageFaxOptions(){
  const list = document.getElementById('csr-fax-list');
  if(!list) return;
  const info = typeof getTraderInfo === 'function' ? getTraderInfo(coldStorageDraft?.warehouse || '') : {};
  const numbers = [...new Set([info?.fax,info?.faxAlt,coldStorageDraft?.fax].map(value=>String(value || '').trim()).filter(Boolean))];
  list.innerHTML = numbers.map(number=>`<option value="${htmlEscape(number)}"></option>`).join('');
}

function coldStorageSyncInputs(){
  if(!coldStorageDraft) coldStorageDraft = coldStorageBlankDraft();
  const values = {
    'csr-date':'requestDate','csr-requester':'requesterId','csr-warehouse':'warehouse','csr-fax':'fax',
    'csr-manager':'managerName','csr-manager-phone':'managerPhone','csr-note':'note'
  };
  Object.entries(values).forEach(([id,key])=>{
    const input = document.getElementById(id);
    if(input) input.value = coldStorageDraft[key] ?? '';
  });
  setColdStorageRequestType(coldStorageDraft.requestType,false);
  syncColdStorageFaxOptions();
  const state = document.getElementById('csr-save-state');
  if(state){
    state.textContent = coldStorageEditingId
      ? `수정 중 · 최근 저장 ${coldStorageFormatDateTime(coldStorageDraft.updatedAt)}`
      : '새 요청 작성 중';
  }
}

function coldStorageRequesterChanged(value){
  if(!coldStorageDraft) coldStorageDraft = coldStorageBlankDraft();
  coldStorageDraft.requesterId = COLD_STORAGE_REQUESTERS[value] ? value : 'dongbumt';
  scheduleColdStoragePreview(true);
}

function coldStorageManagerChanged(value){
  if(!coldStorageDraft) coldStorageDraft = coldStorageBlankDraft();
  coldStorageDraft.managerName = COLD_STORAGE_MANAGERS[value] ? value : '배은정 실장';
  coldStorageDraft.managerPhone = COLD_STORAGE_MANAGERS[coldStorageDraft.managerName];
  const phone = document.getElementById('csr-manager-phone');
  if(phone) phone.value = coldStorageDraft.managerPhone;
  scheduleColdStoragePreview(true);
}

function coldStorageRequestMetaChanged(field,value){
  if(!coldStorageDraft) coldStorageDraft = coldStorageBlankDraft();
  coldStorageDraft[field] = value;
  scheduleColdStoragePreview();
}

function coldStorageWarehouseChanged(value){
  if(!coldStorageDraft) coldStorageDraft = coldStorageBlankDraft();
  coldStorageDraft.warehouse = String(value || '').trim();
  const info = typeof getTraderInfo === 'function' ? getTraderInfo(coldStorageDraft.warehouse) : {};
  if(info?.fax) coldStorageDraft.fax = info.fax;
  const fax = document.getElementById('csr-fax');
  if(fax) fax.value = coldStorageDraft.fax || '';
  syncColdStorageFaxOptions();
  scheduleColdStoragePreview();
}

function setColdStorageRequestType(type,rerender=true){
  if(!coldStorageDraft) coldStorageDraft = coldStorageBlankDraft();
  coldStorageDraft.requestType = type === '이체' ? '이체' : '출고';
  document.getElementById('csr-type-out')?.classList.toggle('active',coldStorageDraft.requestType === '출고');
  document.getElementById('csr-type-transfer')?.classList.toggle('active',coldStorageDraft.requestType === '이체');
  const destinationHead = document.getElementById('csr-destination-head');
  if(destinationHead) destinationHead.textContent = coldStorageDraft.requestType === '이체' ? '이체처' : '출고처';
  const previewLabel = document.getElementById('csr-preview-label');
  if(previewLabel) previewLabel.textContent = `${coldStorageDraft.requestType} 요청서`;
  if(rerender) scheduleColdStoragePreview();
}

function coldStorageItemInput(item,field,attributes=''){
  return `<input value="${htmlEscape(item[field] ?? '')}" ${attributes} oninput="coldStorageRequestItemChanged('${item.id}','${field}',this.value)">`;
}

function renderColdStorageRequestItems(){
  const body = document.getElementById('csr-item-body');
  if(!body || !coldStorageDraft) return;
  body.innerHTML = coldStorageDraft.items.map((item,index)=>`<tr>
    <td class="csr-item-number">${index+1}</td>
    <td>${coldStorageItemInput(item,'destination','list="csr-destination-list" placeholder="출고·이체처"')}</td>
    <td>${coldStorageItemInput(item,'product','list="csr-product-list" placeholder="품명"')}</td>
    <td>${coldStorageItemInput(item,'spec','placeholder="규격"')}</td>
    <td>${coldStorageItemInput(item,'unit','list="csr-unit-list" placeholder="BOX"')}</td>
    <td>${coldStorageItemInput(item,'quantity','type="number" min="0" step="0.01" class="csr-quantity-input" placeholder="0"')}</td>
    <td>${coldStorageItemInput(item,'lot','placeholder="B/L 또는 LOT"')}</td>
    <td style="text-align:center;"><button type="button" class="btn btn-danger btn-sm" onclick="removeColdStorageRequestItem('${item.id}')" title="품목 삭제">×</button></td>
  </tr>`).join('');
}

function coldStorageRequestItemChanged(id,field,value){
  const item = coldStorageDraft?.items.find(row=>row.id === id);
  if(!item) return;
  item[field] = value;
  scheduleColdStoragePreview();
}

function addColdStorageRequestItem(){
  if(!coldStorageDraft) coldStorageDraft = coldStorageBlankDraft();
  if(coldStorageDraft.items.length >= COLD_STORAGE_REQUEST_MAX_ITEMS){
    toast(`A4 한 장 출력을 위해 품목은 최대 ${COLD_STORAGE_REQUEST_MAX_ITEMS}개까지 입력할 수 있습니다.`);
    return;
  }
  const prior = coldStorageDraft.items[coldStorageDraft.items.length-1];
  coldStorageDraft.items.push({...coldStorageBlankItem(), destination:prior?.destination || '', unit:prior?.unit || 'BOX'});
  renderColdStorageRequestItems();
  scheduleColdStoragePreview();
}

function removeColdStorageRequestItem(id){
  if(!coldStorageDraft) return;
  if(coldStorageDraft.items.length === 1) coldStorageDraft.items = [coldStorageBlankItem()];
  else coldStorageDraft.items = coldStorageDraft.items.filter(item=>item.id !== id);
  renderColdStorageRequestItems();
  scheduleColdStoragePreview();
}

function validateColdStorageRequest(requireFax=false){
  if(!coldStorageDraft) return null;
  const warehouse = String(coldStorageDraft.warehouse || '').trim();
  if(!warehouse){ toast('수신 냉동창고를 선택하세요.'); document.getElementById('csr-warehouse')?.focus(); return null; }
  const fax = String(coldStorageDraft.fax || '').trim();
  if(requireFax && !/^\d{8,15}$/.test(fax.replace(/\D/g,''))){
    toast('수신 팩스번호를 확인하세요.'); document.getElementById('csr-fax')?.focus(); return null;
  }
  const items = coldStorageOutputItems();
  if(!items.length){ toast('요청 품목을 한 개 이상 입력하세요.'); return null; }
  const invalid = items.find(item=>!String(item.destination || '').trim() || !String(item.product || '').trim() || coldStorageNumber(item.quantity) <= 0);
  if(invalid){ toast(`${coldStorageDraft.requestType === '이체' ? '이체처' : '출고처'}, 품명, 수량을 모두 입력하세요.`); return null; }
  return normalizeColdStorageRequest({...coldStorageDraft, warehouse, fax, items});
}

async function refreshColdStorageRequestsFromSupabase(){
  if(localStorage.getItem('dbmt_supabase_enabled') !== '1' || typeof getSupabasePassword !== 'function' || !getSupabasePassword()) return false;
  if(coldStorageRefreshPromise) return coldStorageRefreshPromise;
  coldStorageRefreshPromise = (async()=>{
    const data = await sbRpc('dbmt_get_all',{p_password:getSupabasePassword()});
    const remote = data?.appData?.coldStorageRequests;
    if(!Array.isArray(remote)) return false;
    const before = JSON.stringify(coldStorageRequests);
    coldStorageRequests = remote.map(normalizeColdStorageRequest);
    if(typeof cacheAppDataValue === 'function' && APP_DATA_REGISTRY.coldStorageRequests){
      cacheAppDataValue('coldStorageRequests',APP_DATA_REGISTRY.coldStorageRequests,coldStorageRequests);
    }
    if(typeof resetDataChangeAppDataBaseline === 'function') resetDataChangeAppDataBaseline();
    return before !== JSON.stringify(coldStorageRequests);
  })();
  try{ return await coldStorageRefreshPromise; }
  finally{ coldStorageRefreshPromise = null; }
}

function persistColdStorageRequests(action,record,summary=''){
  const requester = coldStorageRequester(record?.requesterId);
  safeLocalStorageSet(COLD_STORAGE_REQUEST_STORAGE_KEY,JSON.stringify(coldStorageRequests),true);
  recordDataChange({
    menu:'냉동창고 요청', action, target:record?.warehouse || '냉동창고 요청',
    summary:summary || `${record?.requestDate || ''} / ${record?.requestType || ''} / ${requester.name} / ${record?.warehouse || '-'} / 품목 ${coldStorageOutputItems(record).length}건`,
    refId:record?.id || ''
  },{sync:false});
  if(typeof resetDataChangeAppDataBaseline === 'function') resetDataChangeAppDataBaseline();
  gsSaveAppDataKeys(['coldStorageRequests'],'냉동창고 요청');
}

async function saveColdStorageRequest(options={}){
  const recordInput = validateColdStorageRequest(!!options.requireFax);
  if(!recordInput) return null;
  if(options.refresh !== false){
    try{ await refreshColdStorageRequestsFromSupabase(); }
    catch(err){ console.warn('냉동창고 요청 최신 이력 확인 실패:',err); }
  }
  const now = new Date().toISOString();
  const prior = coldStorageEditingId ? coldStorageRequests.find(row=>row.id === coldStorageEditingId) : null;
  const record = normalizeColdStorageRequest({
    ...recordInput,
    id:coldStorageEditingId || coldStorageId(),
    status:options.keepStatus ? (prior?.status || recordInput.status) : 'saved',
    createdAt:prior?.createdAt || now,
    updatedAt:now,
    sentAt:options.keepStatus ? (prior?.sentAt || '') : '',
    providerMessageId:options.keepStatus ? (prior?.providerMessageId || '') : '',
    providerStatus:options.keepStatus ? (prior?.providerStatus || '') : '',
    errorMessage:''
  });
  if(prior) coldStorageRequests = coldStorageRequests.map(row=>row.id === record.id ? record : row);
  else coldStorageRequests.unshift(record);
  coldStorageEditingId = record.id;
  coldStorageDraft = normalizeColdStorageRequest(record);
  persistColdStorageRequests(prior ? '수정' : '저장',record);
  coldStorageSyncInputs();
  renderColdStorageRequestItems();
  renderColdStorageRequestHistory();
  scheduleColdStoragePreview(true);
  if(!options.quiet) toast(`냉동창고 ${record.requestType} 요청이 ${prior ? '수정 저장' : '저장'}됐습니다.`);
  return record;
}

function newColdStorageRequest(){
  if(coldStorageDraft && coldStorageOutputItems().length && !confirm('작성 중인 내용을 지우고 새 요청을 시작할까요?')) return;
  coldStorageEditingId = '';
  coldStorageDraft = coldStorageBlankDraft();
  coldStorageSyncInputs();
  renderColdStorageRequestItems();
  scheduleColdStoragePreview(true);
}

function loadColdStorageRequest(id){
  const record = coldStorageRequests.find(row=>row.id === id);
  if(!record) return;
  coldStorageEditingId = id;
  coldStorageDraft = normalizeColdStorageRequest(JSON.parse(JSON.stringify(record)));
  coldStorageSyncInputs();
  renderColdStorageRequestItems();
  scheduleColdStoragePreview(true);
  document.getElementById('p-cold-storage-request')?.scrollIntoView({behavior:'smooth',block:'start'});
}

function duplicateColdStorageRequest(id){
  const record = coldStorageRequests.find(row=>row.id === id);
  if(!record) return;
  coldStorageEditingId = '';
  coldStorageDraft = normalizeColdStorageRequest({
    ...JSON.parse(JSON.stringify(record)), id:'', requestDate:coldStorageToday(), status:'draft',
    createdAt:'', updatedAt:'', sentAt:'', providerMessageId:'', providerStatus:'', errorMessage:'',
    items:(record.items || []).map(item=>({...item,id:coldStorageId('csri')}))
  });
  coldStorageSyncInputs();
  renderColdStorageRequestItems();
  scheduleColdStoragePreview(true);
}

function deleteColdStorageRequest(id){
  const record = coldStorageRequests.find(row=>row.id === id);
  if(!record || !confirm(`“${record.warehouse || '냉동창고'}” ${record.requestType} 요청 이력을 삭제할까요?`)) return;
  coldStorageRequests = coldStorageRequests.filter(row=>row.id !== id);
  persistColdStorageRequests('삭제',record);
  if(coldStorageEditingId === id){
    coldStorageEditingId = '';
    coldStorageDraft = coldStorageBlankDraft();
    coldStorageSyncInputs();
    renderColdStorageRequestItems();
    scheduleColdStoragePreview(true);
  }
  renderColdStorageRequestHistory();
  toast('냉동창고 요청 이력이 삭제됐습니다.');
}

function coldStorageStatusInfo(record){
  if(record.status === 'completed') return {label:'전송 완료',className:'completed'};
  if(record.status === 'partial') return {label:'부분 성공',className:'partial'};
  if(record.status === 'canceled') return {label:'예약 취소',className:'canceled'};
  if(record.status === 'accepted') return {label:record.providerStatus || '전송 접수',className:'accepted'};
  if(record.status === 'failed') return {label:'전송 실패',className:'failed'};
  return {label:'저장',className:'saved'};
}

function coldStorageFaxStatusDetail(record){
  if(!record.providerMessageId) return '';
  const parts = [];
  const finishedAt = coldStorageFormatBarobillDateTime(record.faxEndDateTime);
  if(finishedAt) parts.push(finishedAt);
  if(record.faxSendPageCount > 0) parts.push(`${record.faxSuccessPageCount}/${record.faxSendPageCount}쪽`);
  if(!parts.length && record.faxStatusCheckedAt) parts.push(`확인 ${coldStorageFormatDateTime(record.faxStatusCheckedAt)}`);
  return parts.join(' · ');
}

function renderColdStorageRequestHistory(){
  const body = document.getElementById('csr-history-body');
  if(!body) return;
  const from = document.getElementById('csr-history-from')?.value || '';
  const to = document.getElementById('csr-history-to')?.value || '';
  const query = String(document.getElementById('csr-history-search')?.value || '').trim().toLocaleLowerCase('ko-KR');
  const rows = coldStorageRequests.slice()
    .sort((a,b)=>String(b.updatedAt || b.requestDate || '').localeCompare(String(a.updatedAt || a.requestDate || '')))
    .filter(record=>{
      if(from && String(record.requestDate || '') < from) return false;
      if(to && String(record.requestDate || '') > to) return false;
      if(query){
        const requester = coldStorageRequester(record.requesterId);
        const haystack = [requester.name,requester.registrationNo,record.warehouse,record.requestType,record.fax,...(record.items || []).flatMap(item=>[item.destination,item.product,item.spec,item.lot])]
          .join(' ').toLocaleLowerCase('ko-KR');
        if(!haystack.includes(query)) return false;
      }
      return true;
    });
  const count = document.getElementById('csr-history-count');
  if(count) count.textContent = `표시 ${rows.length}건 / 전체 ${coldStorageRequests.length}건`;
  if(!rows.length){
    body.innerHTML = '<tr><td colspan="9" class="csr-empty-cell">조건에 맞는 요청 이력이 없습니다.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(record=>{
    const items = coldStorageOutputItems(record);
    const requester = coldStorageRequester(record.requesterId);
    const total = items.reduce((sum,item)=>sum+coldStorageNumber(item.quantity),0);
    const units = [...new Set(items.map(item=>String(item.unit || '').trim()).filter(Boolean))];
    const totalUnit = units.length === 1 ? units[0] : (units.length > 1 ? '혼합' : '');
    const preview = items.slice(0,2).map(item=>`${item.destination || '-'} · ${item.product || '-'}`).join('<br>');
    const extra = items.length > 2 ? `<br><span style="color:#667085;">외 ${items.length-2}건</span>` : '';
    const status = coldStorageStatusInfo(record);
    const statusDetail = coldStorageFaxStatusDetail(record);
    const statusTitle = [record.providerStatus,record.errorMessage,record.faxResult ? `결과 ${record.faxResult}` : '',record.providerMessageId ? `접수번호 ${record.providerMessageId}` : ''].filter(Boolean).join(' / ');
    return `<tr>
      <td style="white-space:nowrap;">${htmlEscape(record.requestDate || '-')}</td>
      <td><strong>${htmlEscape(record.requestType || '-')}</strong></td>
      <td style="white-space:nowrap;">${htmlEscape(requester.name)}</td>
      <td><strong>${htmlEscape(record.warehouse || '-')}</strong></td>
      <td style="font-size:11px;line-height:1.5;">${preview}${extra}</td>
      <td style="text-align:right;white-space:nowrap;">${coldStorageFormatQuantity(total)} ${htmlEscape(totalUnit)}</td>
      <td style="white-space:nowrap;">${htmlEscape(record.fax || '-')}</td>
      <td><span class="csr-status ${status.className}" title="${htmlEscape(statusTitle)}">${htmlEscape(status.label)}</span>${statusDetail ? `<span class="csr-status-detail">${htmlEscape(statusDetail)}</span>` : ''}</td>
      <td style="text-align:center;white-space:nowrap;">
        ${record.providerMessageId ? `<button class="btn btn-secondary btn-sm" onclick="refreshColdStorageFaxStatus(${jsArg(record.id)})">상태확인</button>` : ''}
        <button class="btn btn-secondary btn-sm" onclick="loadColdStorageRequest(${jsArg(record.id)})">불러오기</button>
        <button class="btn btn-secondary btn-sm" onclick="duplicateColdStorageRequest(${jsArg(record.id)})">복사</button>
        <button class="btn btn-danger btn-sm" onclick="deleteColdStorageRequest(${jsArg(record.id)})">삭제</button>
      </td>
    </tr>`;
  }).join('');
}

function coldStorageStatusRecordState(sendState){
  if(sendState === 3) return 'completed';
  if(sendState === 7) return 'partial';
  if(sendState === 4) return 'canceled';
  if([5,6,8].includes(sendState)) return 'failed';
  return 'accepted';
}

function updateColdStorageRecordFromFaxResult(record,result){
  return normalizeColdStorageRequest({
    ...record,
    status:coldStorageStatusRecordState(Number(result.sendState)),
    providerStatus:result.status || record.providerStatus || '전송 접수',
    faxSendState:Number(result.sendState),
    faxResult:result.sendResult || '',
    faxSendPageCount:Number(result.sendPageCount) || 0,
    faxSuccessPageCount:Number(result.successPageCount) || 0,
    faxSendDateTime:result.sendDateTime || record.faxSendDateTime || '',
    faxEndDateTime:result.endDateTime || record.faxEndDateTime || '',
    faxStatusCheckedAt:new Date().toISOString(),
    updatedAt:new Date().toISOString(),
    errorMessage:[5,6,8].includes(Number(result.sendState))
      ? (result.sendResult ? `바로빌 전송결과 ${result.sendResult}` : result.status || '팩스 전송 실패')
      : ''
  });
}

function persistColdStorageFaxStatuses(){
  safeLocalStorageSet(COLD_STORAGE_REQUEST_STORAGE_KEY,JSON.stringify(coldStorageRequests),true);
  if(typeof resetDataChangeAppDataBaseline === 'function') resetDataChangeAppDataBaseline();
  gsSaveAppDataKeys(['coldStorageRequests'],'냉동창고 팩스 상태');
}

function recordColdStorageFaxTransition(before,after){
  const terminal = ['completed','partial','canceled','failed'].includes(after.status);
  if(!terminal || before.status === after.status) return;
  recordDataChange({
    menu:'냉동창고 요청', action:'팩스 결과', target:after.warehouse || '냉동창고',
    summary:`${after.requestDate} / ${after.warehouse} / ${after.requestType} 요청 / ${after.providerStatus}${after.faxEndDateTime ? ` / ${coldStorageFormatBarobillDateTime(after.faxEndDateTime)}` : ''}`,
    refId:after.id
  },{sync:false});
}

async function requestColdStorageFaxStatus(record,password){
  const result = await sbFunctionRequest('send-document-request',{
    action:'cold_storage_fax_status',appPassword:password,messageId:record.providerMessageId
  });
  return updateColdStorageRecordFromFaxResult(record,result);
}

async function refreshColdStorageFaxStatus(id,options={}){
  const password = typeof getSupabasePassword === 'function' ? getSupabasePassword() : '';
  if(!password){ if(!options.quiet) toast('Supabase 연결 비밀번호를 먼저 설정하세요.'); return null; }
  const record = coldStorageRequests.find(row=>row.id === id);
  if(!record?.providerMessageId){ if(!options.quiet) toast('팩스 접수번호가 없는 요청입니다.'); return null; }
  try{
    const updated = await requestColdStorageFaxStatus(record,password);
    recordColdStorageFaxTransition(record,updated);
    coldStorageRequests = coldStorageRequests.map(row=>row.id === id ? updated : row);
    if(coldStorageEditingId === id) coldStorageDraft = normalizeColdStorageRequest(updated);
    persistColdStorageFaxStatuses();
    renderColdStorageRequestHistory();
    if(!options.quiet) toast(`팩스 상태: ${updated.providerStatus}`);
    return updated;
  }catch(err){
    if(!options.quiet) toast(`팩스 상태 확인 실패: ${err?.message || err}`);
    return null;
  }
}

async function refreshColdStorageFaxStatuses(options={}){
  const password = typeof getSupabasePassword === 'function' ? getSupabasePassword() : '';
  if(!password){ if(!options.quiet) toast('Supabase 연결 비밀번호를 먼저 설정하세요.'); return; }
  if(options.refreshRemote !== false){
    try{ await refreshColdStorageRequestsFromSupabase(); }catch(err){ console.warn('팩스 상태 확인 전 이력 갱신 실패:',err); }
  }
  let records = coldStorageRequests.filter(record=>record.providerMessageId);
  if(options.pendingOnly) records = records.filter(record=>!['completed','partial','canceled','failed'].includes(record.status));
  records = records.slice(0,100);
  if(!records.length){ renderColdStorageRequestHistory(); if(!options.quiet) toast('상태를 확인할 팩스 이력이 없습니다.'); return; }
  const button = document.getElementById('csr-status-refresh-button');
  if(button){ button.disabled=true;button.textContent='상태 확인 중...'; }
  let changed = 0;
  try{
    for(let start=0;start<records.length;start+=4){
      const batch = records.slice(start,start+4);
      const results = await Promise.all(batch.map(async record=>{
        try{ return {before:record,after:await requestColdStorageFaxStatus(record,password)}; }
        catch(err){ console.warn('팩스 상태 개별 조회 실패:',record.id,err); return null; }
      }));
      results.filter(Boolean).forEach(({before,after})=>{
        recordColdStorageFaxTransition(before,after);
        coldStorageRequests = coldStorageRequests.map(row=>row.id === after.id ? after : row);
        if(coldStorageEditingId === after.id) coldStorageDraft = normalizeColdStorageRequest(after);
        changed += 1;
      });
    }
    if(changed) persistColdStorageFaxStatuses();
    renderColdStorageRequestHistory();
    if(!options.quiet) toast(`팩스 상태 ${changed}건을 확인했습니다.`);
  }finally{
    if(button){ button.disabled=false;button.textContent='팩스 상태 새로고침'; }
  }
}

function scheduleColdStorageFaxStatusPolling(id){
  [4000,12000,25000].forEach(delay=>setTimeout(()=>{
    const record = coldStorageRequests.find(row=>row.id === id);
    if(!record || ['completed','partial','canceled','failed'].includes(record.status)) return;
    refreshColdStorageFaxStatus(id,{quiet:true});
  },delay));
}

function coldStorageSealImage(asset){
  const source = String(asset || COLD_STORAGE_REQUESTERS.dongbumt.seal);
  if(coldStorageSealPromises.has(source)) return coldStorageSealPromises.get(source);
  const promise = new Promise(resolve=>{
    const image = new Image();
    image.onload = ()=>resolve(image);
    image.onerror = ()=>resolve(null);
    image.src = source;
  });
  coldStorageSealPromises.set(source,promise);
  return promise;
}

function csrSetFont(ctx,size,weight=400){
  ctx.font = `${weight} ${size}px "Malgun Gothic","Noto Sans KR",Arial,sans-serif`;
}

function csrFitText(ctx,text,maxWidth,size,minSize=16,weight=400){
  let current = size;
  const value = String(text ?? '');
  while(current > minSize){
    csrSetFont(ctx,current,weight);
    if(ctx.measureText(value).width <= maxWidth) break;
    current -= 1;
  }
  return current;
}

function csrWrapLines(ctx,text,maxWidth,maxLines=2){
  const raw = String(text ?? '').split(/\r?\n/);
  const lines = [];
  raw.forEach(paragraph=>{
    if(!paragraph){ lines.push(''); return; }
    let current = '';
    [...paragraph].forEach(char=>{
      const test = current + char;
      if(current && ctx.measureText(test).width > maxWidth){ lines.push(current); current = char; }
      else current = test;
    });
    if(current) lines.push(current);
  });
  if(lines.length > maxLines){
    const limited = lines.slice(0,maxLines);
    let last = limited[maxLines-1];
    while(last && ctx.measureText(last+'…').width > maxWidth) last = last.slice(0,-1);
    limited[maxLines-1] = last+'…';
    return limited;
  }
  return lines;
}

function csrDrawText(ctx,text,x,y,options={}){
  const size = options.size || 24;
  const weight = options.weight || 400;
  const align = options.align || 'left';
  const color = options.color || '#20242a';
  const maxWidth = options.maxWidth || 10000;
  const fitted = csrFitText(ctx,text,maxWidth,size,options.minSize || 14,weight);
  csrSetFont(ctx,fitted,weight);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = options.baseline || 'middle';
  ctx.fillText(String(text ?? ''),x,y,maxWidth);
}

function csrDrawCell(ctx,{x,y,w,h,text='',fill='#fff',weight=400,size=23,align='center',maxLines=2,padding=10}){
  ctx.fillStyle = fill;
  ctx.fillRect(x,y,w,h);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.strokeRect(x,y,w,h);
  const fitted = csrFitText(ctx,String(text ?? ''),w-padding*2,size,15,weight);
  csrSetFont(ctx,fitted,weight);
  const lines = csrWrapLines(ctx,text,w-padding*2,maxLines);
  const lineHeight = fitted * 1.25;
  const startY = y+h/2-(lines.length-1)*lineHeight/2;
  lines.forEach((line,index)=>csrDrawText(ctx,line,align==='left'?x+padding:align==='right'?x+w-padding:x+w/2,startY+index*lineHeight,{size:fitted,weight,align,maxWidth:w-padding*2}));
}

function coldStorageKoreanDate(value){
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}년 ${Number(match[2])}월 ${Number(match[3])}일` : String(value || '');
}

async function renderColdStorageRequestCanvas(target,record=coldStorageDraft){
  const canvas = target || document.createElement('canvas');
  canvas.width = COLD_STORAGE_CANVAS_WIDTH;
  canvas.height = COLD_STORAGE_CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d');
  if(document.fonts?.ready) await document.fonts.ready;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0,0,canvas.width,canvas.height);

  const normalized = normalizeColdStorageRequest(record || coldStorageBlankDraft());
  const requester = coldStorageRequester(normalized.requesterId);
  const items = coldStorageOutputItems(normalized).slice(0,COLD_STORAGE_REQUEST_MAX_ITEMS);
  const title = normalized.requestType === '이체' ? '이 체 요 청 서' : '출 고 요 청 서';
  csrDrawText(ctx,title,canvas.width/2,95,{size:62,weight:700,align:'center',maxWidth:920});
  ctx.strokeStyle = '#20242a';
  ctx.lineWidth = 3;
  ctx.beginPath();ctx.moveTo(80,155);ctx.lineTo(1160,155);ctx.stroke();

  csrDrawText(ctx,`수신 : ${normalized.warehouse || '냉동창고'} 귀하`,85,205,{size:28,weight:700,maxWidth:620});
  csrDrawText(ctx,`요청일 : ${coldStorageKoreanDate(normalized.requestDate)}`,1155,205,{size:25,weight:600,align:'right',maxWidth:430});
  csrDrawText(ctx,`수신 FAX : ${normalized.fax || '-'}`,85,252,{size:23,maxWidth:520});
  csrDrawText(ctx,`담당 : ${normalized.managerName || '-'}  ${normalized.managerPhone || ''}`,1155,252,{size:23,align:'right',maxWidth:520});

  const tableX = 80;
  const tableY = 310;
  const widths = [60,200,300,170,100,110,140];
  const headers = ['No.',normalized.requestType === '이체' ? '이체처' : '출고처','품명','규격','단위','수량','B/L·LOT'];
  let x = tableX;
  headers.forEach((header,index)=>{
    csrDrawCell(ctx,{x,y:tableY,w:widths[index],h:60,text:header,fill:'#ededed',weight:700,size:23});
    x += widths[index];
  });
  const visibleRows = Math.max(6,items.length);
  const rowHeight = items.length > 8 ? 70 : 78;
  for(let rowIndex=0;rowIndex<visibleRows;rowIndex++){
    const item = items[rowIndex] || {};
    const values = [rowIndex+1,item.destination||'',item.product||'',item.spec||'',item.unit||'',coldStorageFormatQuantity(item.quantity),item.lot||''];
    x = tableX;
    values.forEach((value,index)=>{
      csrDrawCell(ctx,{x,y:tableY+60+rowIndex*rowHeight,w:widths[index],h:rowHeight,text:value,size:index===2?23:21,weight:index===2?600:400,align:index===5?'right':'center',maxLines:2,padding:9});
      x += widths[index];
    });
  }

  const tableBottom = tableY+60+visibleRows*rowHeight;
  const instructionY = Math.max(900,tableBottom+60);
  csrDrawText(ctx,`상기와 같이 ${normalized.requestType} 요청을 하오니 처리하여 주시기 바랍니다.`,canvas.width/2,instructionY,{size:30,weight:600,align:'center',maxWidth:1050});

  const noteY = instructionY+55;
  ctx.fillStyle = '#f7f7f7';ctx.fillRect(80,noteY,1080,90);
  ctx.strokeStyle = '#777';ctx.lineWidth = 2;ctx.strokeRect(80,noteY,1080,90);
  csrDrawText(ctx,'요청사항',105,noteY+25,{size:20,weight:700,maxWidth:120});
  csrSetFont(ctx,21,400);
  const noteLines = csrWrapLines(ctx,normalized.note || '',890,2);
  noteLines.forEach((line,index)=>csrDrawText(ctx,line,240,noteY+28+index*27,{size:21,maxWidth:885}));

  const companyY = 1365;
  ctx.strokeStyle = '#444';ctx.lineWidth = 2;ctx.strokeRect(80,companyY,1080,265);
  ctx.fillStyle = '#efefef';ctx.fillRect(80,companyY,1080,46);
  csrDrawText(ctx,'요 청 자',105,companyY+23,{size:21,weight:700});
  csrDrawText(ctx,requester.name,115,companyY+88,{size:34,weight:700,maxWidth:570});
  csrDrawText(ctx,`사업자등록번호  ${requester.registrationNo}`,115,companyY+133,{size:21,maxWidth:620});
  csrDrawText(ctx,`주소  ${requester.address}`,115,companyY+174,{size:20,maxWidth:700});
  csrDrawText(ctx,`전화  ${requester.phone}    FAX  ${requester.fax}`,115,companyY+215,{size:20,maxWidth:700});
  csrDrawText(ctx,`대표자  ${requester.representative}  (인)`,1125,companyY+82,{size:27,weight:600,align:'right',maxWidth:330});
  const seal = await coldStorageSealImage(requester.seal);
  if(seal){ ctx.save();ctx.globalAlpha=.9;ctx.drawImage(seal,980,companyY+103,145,145);ctx.restore(); }

  csrDrawText(ctx,`문서번호  ${normalized.id || '저장 전'}`,85,1695,{size:17,color:'#707782',maxWidth:500});
  csrDrawText(ctx,`${normalized.requestType} 요청 품목 ${items.length}건`,1155,1695,{size:17,color:'#707782',align:'right',maxWidth:400});
  return canvas;
}

function scheduleColdStoragePreview(immediate=false){
  clearTimeout(coldStoragePreviewTimer);
  const serial = ++coldStoragePreviewSerial;
  const run = async()=>{
    const target = document.getElementById('csr-preview-canvas');
    if(!target || serial !== coldStoragePreviewSerial) return;
    try{ await renderColdStorageRequestCanvas(target,coldStorageDraft); }
    catch(err){ console.error('냉동창고 요청서 미리보기 실패:',err); }
  };
  if(immediate) run(); else coldStoragePreviewTimer = setTimeout(run,180);
}

async function downloadColdStorageRequestImage(){
  const record = validateColdStorageRequest(false);
  if(!record) return;
  const canvas = await renderColdStorageRequestCanvas(null,record);
  const link = document.createElement('a');
  const safeWarehouse = String(record.warehouse || '냉동창고').replace(/[\\/:*?"<>|]/g,'_');
  link.download = `${record.requestDate}_${safeWarehouse}_${record.requestType}요청서.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

async function printColdStorageRequest(){
  const record = validateColdStorageRequest(false);
  if(!record) return;
  const popup = window.open('','_blank');
  if(!popup){ toast('팝업이 차단되어 인쇄창을 열 수 없습니다.'); return; }
  popup.document.write('<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>요청서 준비 중</title></head><body style="font-family:Malgun Gothic,sans-serif;text-align:center;padding:40px;">요청서를 준비하고 있습니다.</body></html>');
  const canvas = await renderColdStorageRequestCanvas(null,record);
  const dataUrl = canvas.toDataURL('image/png');
  popup.document.open();
  popup.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${record.requestType} 요청서</title><style>@page{size:A4 portrait;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}img{display:block;width:210mm;height:297mm;object-fit:contain}@media screen{body{background:#ddd;display:flex;justify-content:center}img{box-shadow:0 0 12px rgba(0,0,0,.18)}}</style></head><body><img src="${dataUrl}" onload="setTimeout(()=>window.print(),200)"></body></html>`);
  popup.document.close();
}

function updateColdStorageFaxButton(){
  const button = document.getElementById('csr-fax-button');
  if(!button) return;
  button.disabled = !coldStorageFaxCapabilities.fax;
  button.textContent = coldStorageFaxCapabilities.fax
    ? `바로빌 팩스${coldStorageFaxCapabilities.faxMode === '테스트' ? ' (테스트)' : ''}`
    : '바로빌 팩스 준비중';
}

async function loadColdStorageFaxCapabilities(){
  const message = document.getElementById('csr-fax-config');
  const password = typeof getSupabasePassword === 'function' ? getSupabasePassword() : '';
  if(!password){
    coldStorageFaxCapabilities = {fax:false,faxProvider:'바로빌',faxMode:'테스트'};
    if(message){ message.style.display='';message.textContent='팩스 발송에는 Supabase 연결 비밀번호가 필요합니다.'; }
    updateColdStorageFaxButton();
    return;
  }
  try{
    const result = await sbFunctionRequest('send-document-request',{action:'capabilities',appPassword:password});
    coldStorageFaxCapabilities = {fax:!!result?.fax,faxProvider:result?.faxProvider || '바로빌',faxMode:result?.faxMode || '테스트'};
    if(message){
      message.style.display = coldStorageFaxCapabilities.fax ? 'none' : '';
      message.textContent = coldStorageFaxCapabilities.fax ? '' : '바로빌 계정·인증키 설정이 필요합니다.';
    }
  }catch(err){
    coldStorageFaxCapabilities = {fax:false,faxProvider:'바로빌',faxMode:'테스트'};
    if(message){ message.style.display='';message.textContent=`팩스 발송 상태 확인 실패: ${err?.message || err}`; }
  }
  updateColdStorageFaxButton();
}

async function sendColdStorageRequestFax(){
  const validated = validateColdStorageRequest(true);
  if(!validated) return;
  const password = typeof getSupabasePassword === 'function' ? getSupabasePassword() : '';
  if(!password){ toast('Supabase 연결 비밀번호를 먼저 설정하세요.'); return; }
  if(!coldStorageFaxCapabilities.fax){
    await loadColdStorageFaxCapabilities();
    if(!coldStorageFaxCapabilities.fax){ toast('바로빌 팩스 연결 상태를 확인하세요.'); return; }
  }
  const modeText = coldStorageFaxCapabilities.faxMode === '테스트' ? '\n\n현재 바로빌 테스트 환경입니다.' : '';
  if(!confirm(`${validated.warehouse} (${validated.fax})로 ${validated.requestType} 요청서를 팩스 전송할까요?${modeText}`)) return;

  const saved = await saveColdStorageRequest({requireFax:true,quiet:true});
  if(!saved) return;
  const button = document.getElementById('csr-fax-button');
  if(button){ button.disabled=true;button.textContent='팩스 전송 중...'; }
  try{
    const canvas = await renderColdStorageRequestCanvas(null,saved);
    const imageDataUrl = canvas.toDataURL('image/jpeg',.9);
    const result = await sbFunctionRequest('send-document-request',{
      action:'cold_storage_fax', appPassword:password,
      requestId:saved.id, requestType:saved.requestType,
      warehouse:saved.warehouse, recipient:saved.fax,
      recipientName:saved.warehouse, itemCount:coldStorageOutputItems(saved).length,
      imageDataUrl
    });
    const now = new Date().toISOString();
    const updated = normalizeColdStorageRequest({
      ...saved,status:'accepted',sentAt:now,updatedAt:now,
      providerMessageId:result?.messageId || '',providerStatus:result?.status || '전송 접수',errorMessage:''
    });
    coldStorageRequests = coldStorageRequests.map(row=>row.id === updated.id ? updated : row);
    coldStorageDraft = normalizeColdStorageRequest(updated);
    persistColdStorageRequests('팩스 전송',updated,`${updated.requestDate} / ${updated.warehouse} / ${updated.requestType} 요청 / ${updated.fax} / ${updated.providerStatus}`);
    coldStorageSyncInputs();
    renderColdStorageRequestHistory();
    scheduleColdStoragePreview(true);
    toast(`팩스가 ${updated.providerStatus || '접수'}됐습니다.`);
    scheduleColdStorageFaxStatusPolling(updated.id);
  }catch(err){
    const now = new Date().toISOString();
    const failed = normalizeColdStorageRequest({...saved,status:'failed',updatedAt:now,errorMessage:String(err?.message || err)});
    coldStorageRequests = coldStorageRequests.map(row=>row.id === failed.id ? failed : row);
    coldStorageDraft = normalizeColdStorageRequest(failed);
    persistColdStorageRequests('팩스 실패',failed,`${failed.requestDate} / ${failed.warehouse} / ${failed.requestType} 요청 / 실패: ${failed.errorMessage}`);
    renderColdStorageRequestHistory();
    toast(`팩스 전송 실패: ${failed.errorMessage}`);
  }finally{
    updateColdStorageFaxButton();
  }
}

async function initColdStorageRequestPage(){
  if(!coldStorageDraft) coldStorageDraft = coldStorageBlankDraft();
  coldStoragePopulateOptions();
  coldStorageSyncInputs();
  renderColdStorageRequestItems();
  renderColdStorageRequestHistory();
  scheduleColdStoragePreview(true);
  loadColdStorageFaxCapabilities();
  try{
    const changed = await refreshColdStorageRequestsFromSupabase();
    if(changed && document.getElementById('p-cold-storage-request')?.classList.contains('active')) renderColdStorageRequestHistory();
    refreshColdStorageFaxStatuses({quiet:true,pendingOnly:true,refreshRemote:false});
  }catch(err){ console.warn('냉동창고 요청 최신 이력 불러오기 실패:',err); }
}

window.initColdStorageRequestPage = initColdStorageRequestPage;
window.coldStorageRequestMetaChanged = coldStorageRequestMetaChanged;
window.coldStorageRequesterChanged = coldStorageRequesterChanged;
window.coldStorageManagerChanged = coldStorageManagerChanged;
window.coldStorageWarehouseChanged = coldStorageWarehouseChanged;
window.setColdStorageRequestType = setColdStorageRequestType;
window.coldStorageRequestItemChanged = coldStorageRequestItemChanged;
window.addColdStorageRequestItem = addColdStorageRequestItem;
window.removeColdStorageRequestItem = removeColdStorageRequestItem;
window.saveColdStorageRequest = saveColdStorageRequest;
window.newColdStorageRequest = newColdStorageRequest;
window.loadColdStorageRequest = loadColdStorageRequest;
window.duplicateColdStorageRequest = duplicateColdStorageRequest;
window.deleteColdStorageRequest = deleteColdStorageRequest;
window.refreshColdStorageFaxStatus = refreshColdStorageFaxStatus;
window.refreshColdStorageFaxStatuses = refreshColdStorageFaxStatuses;
window.renderColdStorageRequestHistory = renderColdStorageRequestHistory;
window.downloadColdStorageRequestImage = downloadColdStorageRequestImage;
window.printColdStorageRequest = printColdStorageRequest;
window.sendColdStorageRequestFax = sendColdStorageRequestFax;

if(typeof APP_DATA_REGISTRY === 'object'){
  APP_DATA_REGISTRY.coldStorageRequests = {
    get:()=>coldStorageRequests,
    set:value=>{ coldStorageRequests = Array.isArray(value) ? value.map(normalizeColdStorageRequest) : []; },
    ls:COLD_STORAGE_REQUEST_STORAGE_KEY
  };
}
if(typeof APP_DATA_LABELS === 'object') APP_DATA_LABELS.coldStorageRequests = '냉동창고 요청';
if(typeof DATA_CHANGE_MENU_BY_APP_KEY === 'object') DATA_CHANGE_MENU_BY_APP_KEY.coldStorageRequests = '냉동창고 요청';
if(Array.isArray(DATA_CHANGE_MENU_ORDER) && !DATA_CHANGE_MENU_ORDER.includes('냉동창고 요청')){
  const position = DATA_CHANGE_MENU_ORDER.indexOf('재고현황');
  DATA_CHANGE_MENU_ORDER.splice(position >= 0 ? position+1 : DATA_CHANGE_MENU_ORDER.length,0,'냉동창고 요청');
}

})();
