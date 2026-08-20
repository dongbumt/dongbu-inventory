(function(){
'use strict';

const QUOTATION_STORAGE_KEY = 'dbmt_quotations';
const QUOTATION_MAX_ROWS = 8;
const QUOTATION_CANVAS_WIDTH = 2480;
const QUOTATION_CANVAS_HEIGHT = 3508;
const QUOTATION_COMPANY_FALLBACK = {
  name: '주식회사 동부엠티',
  ceo: '이창성',
  registrationNo: '495-88-01108',
  address: '인천광역시 검단구 소담2로 36, 2동 201호 (금곡동)',
  phoneFax: '032-766-1812 / 032-232-1812',
};

function quotationCompany(record={}){
  const snapshot = record.companyProfile || null;
  const profile = snapshot || window.DBMTCompanyMaster?.getPrimaryProfile?.();
  const masterSource = window.DBMTCompanyMaster?.getSource?.() || 'legacy';
  if(!profile) return masterSource === 'server' || masterSource === 'cache'
    ? {name:'',ceo:'',registrationNo:'',address:'',phoneFax:''}
    : QUOTATION_COMPANY_FALLBACK;
  const allowLegacyFallback = profile.isLegacyDraft === true || profile.source === 'legacy' || (!snapshot && masterSource === 'legacy');
  return {
    name:profile.legalName || profile.name || (allowLegacyFallback ? QUOTATION_COMPANY_FALLBACK.name : ''),
    ceo:profile.representativeName || profile.representative || profile.ceo || QUOTATION_COMPANY_FALLBACK.ceo,
    registrationNo:profile.registrationNo || profile.businessRegistrationNo || (allowLegacyFallback ? QUOTATION_COMPANY_FALLBACK.registrationNo : ''),
    address:profile.address || (allowLegacyFallback ? QUOTATION_COMPANY_FALLBACK.address : ''),
    phoneFax:profile.phoneFax || [profile.phone,profile.fax].filter(Boolean).join(' / ') || (allowLegacyFallback ? QUOTATION_COMPANY_FALLBACK.phoneFax : '')
  };
}

function quotationCompanySnapshot(){
  const company=quotationCompany();
  const profile=window.DBMTCompanyMaster?.getPrimaryProfile?.();
  const masterSource = window.DBMTCompanyMaster?.getSource?.() || 'legacy';
  const allowLegacySeal = profile?.isLegacyDraft === true || masterSource === 'legacy';
  return {
    ...company, sealAssetKey:profile?.sealAssetKey || (allowLegacySeal ? 'assets/company-seal.png' : ''),
    source:masterSource, isLegacyDraft:profile?.isLegacyDraft === true, capturedAt:new Date().toISOString()
  };
}

let quotationList = [];
try{
  const cached = JSON.parse(localStorage.getItem(QUOTATION_STORAGE_KEY) || '[]');
  quotationList = Array.isArray(cached) ? cached : [];
}catch(e){ quotationList = []; }

let quotationDraft = null;
let quotationEditingId = '';
let quotationPreviewType = 'external';
let quotationPreviewTimer = null;
let quotationPreviewSerial = 0;
let quotationSealPromise = null;

function quotationId(prefix='qt'){
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
}

function quotationBlankRow(){
  return {
    id: quotationId('qtr'), category:'우육', product:'', grade:'', origin:'', unit:'KG',
    price1:'', price2:'', note:'', spec:'', monthlyUsage:'', targetPrice:'', rawPrice:'',
    yieldRate:95, overheadCost:'', salePrice:''
  };
}

function quotationBlankDraft(){
  return {
    id:'', date:typeof localDateString === 'function' ? localDateString() : new Date().toISOString().slice(0,10),
    customer:'', recipient:'귀하', subject:'', priceHeader1:'KG단가', priceHeader2:'BOX단가',
    managerName:'김상영 본부장', managerPhone:'010-2414-5406',
    note:'위 품목은 시세에 따라 단가가 변동됩니다.', rows:[quotationBlankRow()],
    companyProfile:null, createdAt:'', updatedAt:''
  };
}

function quotationNormalizeRow(row={}){
  const normalized={...quotationBlankRow(), ...row, id:row.id || quotationId('qtr')};
  delete normalized.processCost;
  return normalized;
}

function quotationNormalize(record={}){
  const rows = Array.isArray(record.rows) && record.rows.length ? record.rows : [quotationBlankRow()];
  return {...quotationBlankDraft(), ...record, rows:rows.slice(0,QUOTATION_MAX_ROWS).map(quotationNormalizeRow)};
}

function qNumber(value){
  const number = Number(String(value ?? '').replace(/,/g,''));
  return Number.isFinite(number) ? number : 0;
}

function qMoney(value){
  const number = qNumber(value);
  return number ? Math.round(number).toLocaleString('ko-KR') : '-';
}

function qAmount(value, digits=0){
  const number = qNumber(value);
  if(!number) return '-';
  return number.toLocaleString('ko-KR',{maximumFractionDigits:digits});
}

function quotationCalc(row){
  const rawPrice = qNumber(row.rawPrice);
  const yieldRate = Math.min(100, Math.max(0.01, qNumber(row.yieldRate) || 95));
  const lossAdjusted = rawPrice ? rawPrice / (yieldRate / 100) : 0;
  const productionCost = lossAdjusted;
  const overheadCost = qNumber(row.overheadCost);
  const allInCost = productionCost + overheadCost;
  const targetPrice = qNumber(row.targetPrice);
  const salePrice = qNumber(row.salePrice);
  const suggestedPrice = salePrice || (Math.ceil(Math.max(targetPrice, allInCost) / 10) * 10);
  const margin = suggestedPrice - allInCost;
  const marginRate = suggestedPrice ? margin / suggestedPrice * 100 : 0;
  return {rawPrice,yieldRate,lossAdjusted,productionCost,overheadCost,allInCost,targetPrice,salePrice,suggestedPrice,margin,marginRate};
}

function quotationRowsForOutput(record){
  return (record?.rows || []).filter(row => [row.product,row.spec,row.price1,row.price2].some(v=>String(v ?? '').trim()));
}

function quotationCustomerOptions(){
  const list = document.getElementById('qt-customer-list');
  if(!list) return;
  const names = typeof traderInfoMap === 'object' && traderInfoMap
    ? Object.keys(traderInfoMap).sort((a,b)=>a.localeCompare(b,'ko-KR')) : [];
  list.innerHTML = names.map(name=>`<option value="${htmlEscape(name)}"></option>`).join('');
}

function quotationSyncMetaInputs(){
  const values = {
    'qt-date':'date','qt-customer':'customer','qt-recipient':'recipient','qt-subject':'subject',
    'qt-price-header-1':'priceHeader1','qt-price-header-2':'priceHeader2','qt-manager':'managerName',
    'qt-manager-phone':'managerPhone','qt-note':'note'
  };
  Object.entries(values).forEach(([id,key])=>{
    const el = document.getElementById(id);
    if(el) el.value = quotationDraft?.[key] ?? '';
  });
  const head1 = document.getElementById('qt-editor-price-head-1');
  const head2 = document.getElementById('qt-editor-price-head-2');
  if(head1) head1.textContent = quotationDraft?.priceHeader1 || '단가 1';
  if(head2) head2.textContent = quotationDraft?.priceHeader2 || '단가 2';
}

function quotationInput(row, field, type='text', attrs=''){
  const value = row[field] ?? '';
  return `<input type="${type}" value="${htmlEscape(value)}" ${attrs} oninput="quotationRowChanged('${row.id}','${field}',this.value)">`;
}

function quotationCategorySelect(row){
  const options = ['우육','돈육','계육','양육','기타'];
  return `<select onchange="quotationRowChanged('${row.id}','category',this.value)">${options.map(value=>`<option value="${value}"${row.category===value?' selected':''}>${value}</option>`).join('')}</select>`;
}

function renderQuotationRows(){
  const body = document.getElementById('qt-row-body');
  if(!body || !quotationDraft) return;
  body.innerHTML = quotationDraft.rows.map(row=>{
    const calc = quotationCalc(row);
    const marginClass = calc.margin < 0 ? ' quote-calc-negative' : '';
    return `<tr data-quote-row="${row.id}">
      <td>${quotationCategorySelect(row)}</td>
      <td>${quotationInput(row,'product','text','placeholder="품목명"')}</td>
      <td>${quotationInput(row,'grade','text','placeholder="등급"')}</td>
      <td>${quotationInput(row,'origin','text','placeholder="원산지"')}</td>
      <td>${quotationInput(row,'unit','text','placeholder="KG"')}</td>
      <td>${quotationInput(row,'price1','number','min="0" step="1"')}</td>
      <td>${quotationInput(row,'price2','number','min="0" step="1"')}</td>
      <td>${quotationInput(row,'note','text','placeholder="비고"')}</td>
      <td>${quotationInput(row,'monthlyUsage','number','min="0" step="0.01"')}</td>
      <td>${quotationInput(row,'targetPrice','number','min="0" step="1"')}</td>
      <td>${quotationInput(row,'rawPrice','number','min="0" step="1"')}</td>
      <td>${quotationInput(row,'yieldRate','number','min="0.01" max="100" step="0.1"')}</td>
      <td style="text-align:right;font-weight:700;" id="qt-production-${row.id}">${qMoney(calc.productionCost)}</td>
      <td>${quotationInput(row,'overheadCost','number','min="0" step="1"')}</td>
      <td style="text-align:right;font-weight:700;" id="qt-allin-${row.id}">${qMoney(calc.allInCost)}</td>
      <td>${quotationInput(row,'salePrice','number','min="0" step="1"')}</td>
      <td style="text-align:center;white-space:nowrap;"><strong id="qt-suggested-${row.id}">${qMoney(calc.suggestedPrice)}</strong><br><button type="button" class="btn btn-secondary btn-sm" onclick="applyQuotationSuggested('${row.id}')" style="padding:3px 7px;margin-top:3px;">단가1 적용</button></td>
      <td style="text-align:center;"><button type="button" class="btn btn-danger btn-sm" onclick="removeQuotationRow('${row.id}')" title="품목 삭제">×</button></td>
    </tr>
    <tr class="quote-spec-row">
      <td colspan="8"><div style="display:grid;grid-template-columns:52px 1fr;gap:6px;align-items:center;"><strong>스펙</strong>${quotationInput(row,'spec','text','class="quote-spec-input" placeholder="예) 냉동, 1.3 × 30 × 60MM 세절, 5KG 실링포장"')}</div></td>
      <td colspan="9"><div class="quote-calc-summary">
        <span>로스반영 <strong id="qt-loss-${row.id}">${qMoney(calc.lossAdjusted)}</strong></span>
        <span>생산원가 <strong id="qt-production-summary-${row.id}">${qMoney(calc.productionCost)}</strong></span>
        <span>판관비포함 <strong id="qt-allin-summary-${row.id}">${qMoney(calc.allInCost)}</strong></span>
        <span>예상마진 <strong id="qt-margin-${row.id}" class="${marginClass.trim()}">${qMoney(calc.margin)} (${calc.suggestedPrice?calc.marginRate.toFixed(1):'0.0'}%)</strong></span>
      </div></td>
      <td></td>
    </tr>`;
  }).join('');
}

function renderQuotationComputedRow(row){
  const calc = quotationCalc(row);
  const values = {
    [`qt-production-${row.id}`]:qMoney(calc.productionCost),
    [`qt-allin-${row.id}`]:qMoney(calc.allInCost),
    [`qt-suggested-${row.id}`]:qMoney(calc.suggestedPrice),
    [`qt-loss-${row.id}`]:qMoney(calc.lossAdjusted),
    [`qt-production-summary-${row.id}`]:qMoney(calc.productionCost),
    [`qt-allin-summary-${row.id}`]:qMoney(calc.allInCost),
  };
  Object.entries(values).forEach(([id,value])=>{ const el=document.getElementById(id); if(el) el.textContent=value; });
  const margin = document.getElementById(`qt-margin-${row.id}`);
  if(margin){
    margin.textContent = `${qMoney(calc.margin)} (${calc.suggestedPrice?calc.marginRate.toFixed(1):'0.0'}%)`;
    margin.classList.toggle('quote-calc-negative', calc.margin < 0);
  }
}

function quotationMetaChanged(field, value){
  if(!quotationDraft) quotationDraft = quotationBlankDraft();
  quotationDraft[field] = value;
  if(field === 'priceHeader1' || field === 'priceHeader2'){
    const target = document.getElementById(field === 'priceHeader1' ? 'qt-editor-price-head-1' : 'qt-editor-price-head-2');
    if(target) target.textContent = value || (field === 'priceHeader1' ? '단가 1' : '단가 2');
  }
  scheduleQuotationPreview();
}

function quotationRowChanged(id, field, value){
  const row = quotationDraft?.rows.find(item=>item.id===id);
  if(!row) return;
  row[field] = value;
  if(['monthlyUsage','targetPrice','rawPrice','yieldRate','overheadCost','salePrice'].includes(field)) renderQuotationComputedRow(row);
  scheduleQuotationPreview();
}

function addQuotationRow(){
  if(!quotationDraft) quotationDraft = quotationBlankDraft();
  if(quotationDraft.rows.length >= QUOTATION_MAX_ROWS){
    toast(`A4 한 장 출력을 위해 품목은 최대 ${QUOTATION_MAX_ROWS}개까지 등록할 수 있습니다.`);
    return;
  }
  quotationDraft.rows.push(quotationBlankRow());
  renderQuotationRows();
  scheduleQuotationPreview();
}

function removeQuotationRow(id){
  if(!quotationDraft) return;
  if(quotationDraft.rows.length === 1){
    quotationDraft.rows = [quotationBlankRow()];
  }else{
    quotationDraft.rows = quotationDraft.rows.filter(row=>row.id!==id);
  }
  renderQuotationRows();
  scheduleQuotationPreview();
}

function applyQuotationSuggested(id){
  const row = quotationDraft?.rows.find(item=>item.id===id);
  if(!row) return;
  const suggested = quotationCalc(row).suggestedPrice;
  if(!suggested){ toast('원물시세, 타겟단가 또는 판매가를 먼저 입력하세요.'); return; }
  row.price1 = suggested;
  renderQuotationRows();
  scheduleQuotationPreview();
}

function newQuotation(){
  if(quotationDraft && quotationRowsForOutput(quotationDraft).length && !confirm('작성 중인 내용을 지우고 새 견적을 시작할까요?')) return;
  quotationEditingId = '';
  quotationSealPromise = null;
  quotationDraft = quotationBlankDraft();
  quotationSyncMetaInputs();
  renderQuotationRows();
  scheduleQuotationPreview(true);
}

function quotationPersist(action, record){
  safeLocalStorageSet(QUOTATION_STORAGE_KEY, JSON.stringify(quotationList), true);
  recordDataChange({
    menu:'견적서', action, target:record.customer || record.subject || '견적서',
    summary:`${record.date || ''} / ${record.customer || '-'} / ${record.subject || '제목 없음'} / 품목 ${quotationRowsForOutput(record).length}개`,
    refId:record.id || ''
  }, {sync:false});
  resetDataChangeAppDataBaseline();
  gsSaveAppDataKeys(['quotationList'],'견적서');
}

function saveQuotation(){
  if(!quotationDraft) return;
  const customer = String(quotationDraft.customer || '').trim();
  const rows = quotationRowsForOutput(quotationDraft);
  if(!customer){ toast('고객사를 입력하세요.'); document.getElementById('qt-customer')?.focus(); return; }
  if(!rows.length || !rows.some(row=>String(row.product || '').trim())){ toast('품목을 한 개 이상 입력하세요.'); return; }
  const now = new Date().toISOString();
  const prior = quotationEditingId ? quotationList.find(row=>row.id===quotationEditingId) : null;
  const record = quotationNormalize({
    ...quotationDraft,
    id:quotationEditingId || quotationId(), rows,
    companyProfile:prior?.companyProfile || quotationDraft.companyProfile || quotationCompanySnapshot(),
    createdAt:prior?.createdAt || now, updatedAt:now
  });
  const action = prior ? '수정' : '저장';
  if(prior) quotationList = quotationList.map(row=>row.id===record.id ? record : row);
  else quotationList.unshift(record);
  quotationEditingId = record.id;
  quotationDraft = quotationNormalize(record);
  quotationPersist(action,record);
  quotationSyncMetaInputs();
  renderQuotationRows();
  renderQuotationHistory();
  scheduleQuotationPreview(true);
  toast(`견적서가 ${action === '수정' ? '수정 저장' : '저장'}됐습니다.`);
}

function loadQuotation(id){
  const record = quotationList.find(row=>row.id===id);
  if(!record) return;
  quotationEditingId = id;
  quotationSealPromise = null;
  quotationDraft = quotationNormalize(JSON.parse(JSON.stringify(record)));
  quotationSyncMetaInputs();
  renderQuotationRows();
  scheduleQuotationPreview(true);
  window.scrollTo({top:0,behavior:'smooth'});
}

function duplicateQuotation(id){
  const record = quotationList.find(row=>row.id===id);
  if(!record) return;
  quotationEditingId = '';
  quotationSealPromise = null;
  quotationDraft = quotationNormalize({
    ...JSON.parse(JSON.stringify(record)), id:'',
    subject:`${record.subject || '견적서'} 복사본`,
    date:typeof localDateString === 'function' ? localDateString() : new Date().toISOString().slice(0,10),
    companyProfile:null, createdAt:'', updatedAt:'', rows:(record.rows||[]).map(row=>({...row,id:quotationId('qtr')}))
  });
  quotationSyncMetaInputs();
  renderQuotationRows();
  scheduleQuotationPreview(true);
  window.scrollTo({top:0,behavior:'smooth'});
}

function deleteQuotation(id){
  const record = quotationList.find(row=>row.id===id);
  if(!record || !confirm(`“${record.customer || '고객사 미입력'}” 견적서를 삭제할까요?`)) return;
  quotationList = quotationList.filter(row=>row.id!==id);
  quotationPersist('삭제',record);
  if(quotationEditingId===id){ quotationEditingId=''; quotationDraft=quotationBlankDraft(); quotationSyncMetaInputs(); renderQuotationRows(); scheduleQuotationPreview(true); }
  renderQuotationHistory();
  toast('견적서가 삭제됐습니다.');
}

function quotationFormatDateTime(value){
  if(!value) return '-';
  const d = new Date(value);
  if(Number.isNaN(d.getTime())) return String(value);
  const pad=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderQuotationHistory(){
  const body = document.getElementById('qt-history-body');
  if(!body) return;
  const query = String(document.getElementById('qt-history-search')?.value || '').trim().toLocaleLowerCase('ko-KR');
  const rows = quotationList.slice().sort((a,b)=>String(b.updatedAt||b.date||'').localeCompare(String(a.updatedAt||a.date||'')))
    .filter(row=>!query || [row.customer,row.subject,row.date].join(' ').toLocaleLowerCase('ko-KR').includes(query));
  if(!rows.length){
    body.innerHTML='<tr><td colspan="6" style="text-align:center;padding:20px;color:#888;">저장된 견적이 없습니다.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(row=>`<tr>
    <td>${htmlEscape(row.date || '-')}</td><td style="font-weight:700;">${htmlEscape(row.customer || '-')}</td>
    <td>${htmlEscape(row.subject || '-')}</td><td style="text-align:right;">${quotationRowsForOutput(row).length}개</td>
    <td style="font-size:11px;color:#667085;">${htmlEscape(quotationFormatDateTime(row.updatedAt))}</td>
    <td style="text-align:center;white-space:nowrap;">
      <button class="btn btn-secondary btn-sm" onclick="loadQuotation('${row.id}')">불러오기</button>
      <button class="btn btn-secondary btn-sm" onclick="duplicateQuotation('${row.id}')">복사</button>
      <button class="btn btn-danger btn-sm" onclick="deleteQuotation('${row.id}')">삭제</button>
    </td>
  </tr>`).join('');
}

function initQuotationPage(){
  if(!quotationDraft) quotationDraft = quotationBlankDraft();
  quotationCustomerOptions();
  quotationSyncMetaInputs();
  renderQuotationRows();
  renderQuotationHistory();
  setQuotationPreviewType(quotationPreviewType,false);
  scheduleQuotationPreview(true);
}

function setQuotationPreviewType(type, rerender=true){
  quotationPreviewType = type === 'internal' ? 'internal' : 'external';
  document.getElementById('qt-preview-external')?.classList.toggle('active',quotationPreviewType==='external');
  document.getElementById('qt-preview-internal')?.classList.toggle('active',quotationPreviewType==='internal');
  if(rerender) scheduleQuotationPreview(true);
}

function scheduleQuotationPreview(immediate=false){
  clearTimeout(quotationPreviewTimer);
  const run = ()=>renderQuotationPreview().catch(err=>console.error('견적서 미리보기 실패:',err));
  if(immediate) run(); else quotationPreviewTimer=setTimeout(run,320);
}

function quotationSealImage(){
  if(quotationSealPromise) return quotationSealPromise;
  const snapshot = quotationDraft?.companyProfile;
  const profile = window.DBMTCompanyMaster?.getPrimaryProfile?.();
  const masterSource = window.DBMTCompanyMaster?.getSource?.() || 'legacy';
  const allowLegacySeal = snapshot
    ? snapshot.isLegacyDraft === true || snapshot.source === 'legacy'
    : (profile?.isLegacyDraft === true || masterSource === 'legacy');
  const source = snapshot?.sealAssetKey || (!snapshot ? profile?.sealAssetKey : '') || (allowLegacySeal ? 'assets/company-seal.png' : '');
  if(!source) return Promise.resolve(null);
  quotationSealPromise = new Promise(resolve=>{
    const image = new Image();
    image.onload=()=>resolve(image);
    image.onerror=()=>resolve(null);
    image.src=source;
  });
  return quotationSealPromise;
}

document.addEventListener('dbmt-company-master-changed',()=>{
  quotationSealPromise=null;
  if(document.getElementById('p-quotation')?.classList.contains('active')) scheduleQuotationPreview(true);
});

function qSetFont(ctx,size,weight=400){
  ctx.font=`${weight} ${size}px "Malgun Gothic","Noto Sans KR",Arial,sans-serif`;
}

function qFitText(ctx,text,maxWidth,size,minSize=20,weight=400){
  let current=size;
  qSetFont(ctx,current,weight);
  while(current>minSize && ctx.measureText(String(text||'')).width>maxWidth){ current-=2; qSetFont(ctx,current,weight); }
  return current;
}

function qBreakWord(ctx,word,maxWidth){
  const chunks=[];
  let chunk='';
  Array.from(String(word||'')).forEach(char=>{
    const next=chunk+char;
    if(chunk && ctx.measureText(next).width>maxWidth){ chunks.push(chunk); chunk=char; }
    else chunk=next;
  });
  if(chunk) chunks.push(chunk);
  return chunks;
}

function qWrapLines(ctx,text,maxWidth,maxLines=3){
  const paragraphs=String(text??'').split(/\n/);
  const lines=[];
  paragraphs.forEach((paragraph,pIndex)=>{
    const words=paragraph.split(/\s+/).filter(Boolean);
    let line='';
    words.forEach(word=>{
      const pieces=ctx.measureText(word).width>maxWidth ? qBreakWord(ctx,word,maxWidth) : [word];
      pieces.forEach(piece=>{
        const next=line ? `${line} ${piece}` : piece;
        if(line && ctx.measureText(next).width>maxWidth){ lines.push(line); line=piece; }
        else line=next;
      });
    });
    if(line) lines.push(line);
    if(pIndex<paragraphs.length-1 && !line) lines.push('');
  });
  if(lines.length>maxLines){
    const clipped=lines.slice(0,maxLines);
    let last=clipped[maxLines-1];
    while(last && ctx.measureText(last+'…').width>maxWidth) last=last.slice(0,-1);
    clipped[maxLines-1]=last+'…';
    return clipped;
  }
  return lines.length?lines:[''];
}

function qDrawCell(ctx,{x,y,w,h,text='',align='center',size=28,weight=400,fill='#ffffff',stroke='#303030',padding=12,maxLines=2,color='#111111'}){
  ctx.fillStyle=fill; ctx.fillRect(x,y,w,h);
  ctx.strokeStyle=stroke; ctx.lineWidth=2; ctx.strokeRect(x,y,w,h);
  ctx.fillStyle=color; ctx.textBaseline='middle'; ctx.textAlign=align;
  qSetFont(ctx,size,weight);
  const lines=qWrapLines(ctx,text,Math.max(10,w-padding*2),maxLines);
  const lineHeight=size*1.28;
  const total=(lines.length-1)*lineHeight;
  lines.forEach((line,index)=>{
    let tx=x+w/2;
    if(align==='left') tx=x+padding;
    if(align==='right') tx=x+w-padding;
    ctx.fillText(line,tx,y+h/2-total/2+index*lineHeight);
  });
}

function qDrawText(ctx,text,x,y,{size=30,weight=400,align='left',color='#111',maxWidth=0,minSize=18}={}){
  ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline='middle';
  if(maxWidth) qFitText(ctx,text,maxWidth,size,minSize,weight); else qSetFont(ctx,size,weight);
  ctx.fillText(String(text??''),x,y);
}

function qKoreanDate(value){
  const parts=String(value||'').split('-');
  if(parts.length!==3) return value||'';
  return `${parts[0]}년 ${Number(parts[1])}월 ${Number(parts[2])}일`;
}

function qPublicColumnWidths(){ return [150,360,180,220,140,260,260,630]; }

function qDrawPublicTable(ctx,record,rows,startY,{compact=false}={}){
  const x0=140;
  const widths=qPublicColumnWidths();
  const headers=['구분','품목','등급','원산지','단위',record.priceHeader1||'단가 1',record.priceHeader2||'단가 2','비고'];
  const headH=compact?82:106;
  const mainH=compact?76:100;
  const specH=compact?54:72;
  let x=x0;
  headers.forEach((header,index)=>{ qDrawCell(ctx,{x,y:startY,w:widths[index],h:headH,text:header,size:compact?24:34,weight:700,fill:'#ededed'}); x+=widths[index]; });
  let y=startY+headH;
  rows.forEach(row=>{
    const calc=quotationCalc(row);
    const price1=qNumber(row.price1)||calc.suggestedPrice;
    const values=[row.category,row.product,row.grade,row.origin,row.unit,qMoney(price1),qMoney(row.price2),row.note];
    x=x0;
    values.forEach((value,index)=>{
      qDrawCell(ctx,{x,y,w:widths[index],h:mainH,text:value||'',size:compact?22:32,weight:index===1?700:400,align:[5,6].includes(index)?'right':'center',maxLines:2});
      x+=widths[index];
    });
    y+=mainH;
    qDrawCell(ctx,{x:x0,y,w:widths[0],h:specH,text:'스펙',size:compact?20:32,weight:700,fill:'#f7f7f7'});
    qDrawCell(ctx,{x:x0+widths[0],y,w:widths.slice(1).reduce((sum,n)=>sum+n,0),h:specH,text:row.spec||'',size:compact?20:32,align:'left',padding:20,maxLines:2,fill:'#fafafa'});
    y+=specH;
  });
  return y;
}

async function qDrawExternalQuotation(ctx,record){
  const company=quotationCompany(record);
  const rows=quotationRowsForOutput(record);
  ctx.fillStyle='#fff';ctx.fillRect(0,0,QUOTATION_CANVAS_WIDTH,QUOTATION_CANVAS_HEIGHT);
  qDrawText(ctx,'견 적 서',QUOTATION_CANVAS_WIDTH/2,175,{size:92,weight:700,align:'center'});
  ctx.strokeStyle='#222';ctx.lineWidth=4;ctx.strokeRect(730,82,1020,190);

  const leftX=140,leftW=1040,rightX=1210,rightW=1130,top=330;
  qDrawCell(ctx,{x:leftX,y:top,w:leftW,h:86,text:`작성일자 : ${qKoreanDate(record.date)}`,size:34,weight:700});
  qDrawCell(ctx,{x:leftX,y:top+86,w:leftW,h:104,text:`${record.customer||''} ${record.recipient||'귀하'}`,size:42,weight:700});
  qDrawCell(ctx,{x:leftX,y:top+190,w:leftW,h:104,text:record.subject||'아래와 같이 견적합니다',size:36,weight:600,maxLines:2});

  qDrawCell(ctx,{x:rightX,y:top,w:rightW,h:294,text:'',fill:'#fff'});
  qDrawText(ctx,'공 급 자',rightX+34,top+46,{size:29,weight:700,color:'#4b4b4b'});
  qDrawText(ctx,company.name,rightX+225,top+58,{size:46,weight:700,maxWidth:850});
  qDrawText(ctx,`사업자번호  ${company.registrationNo}`,rightX+34,top+128,{size:31,weight:500});
  qDrawText(ctx,`주소  ${company.address}`,rightX+34,top+194,{size:28,maxWidth:1030});
  qDrawText(ctx,`전화/FAX  ${company.phoneFax}`,rightX+34,top+254,{size:28});

  qDrawPublicTable(ctx,record,rows,700);

  const footerY=2890;
  const footerH=340;
  ctx.strokeStyle='#222';ctx.lineWidth=3;ctx.strokeRect(140,footerY,2200,footerH);
  ctx.beginPath();ctx.moveTo(1320,footerY+24);ctx.lineTo(1320,footerY+footerH-24);ctx.stroke();
  qDrawText(ctx,'[ 비 고 ]',175,footerY+48,{size:38,weight:700});
  qSetFont(ctx,34,400);
  const noteLines=qWrapLines(ctx,record.note||'',1080,4);
  noteLines.forEach((line,index)=>qDrawText(ctx,line,175,footerY+104+index*42,{size:34}));
  qDrawText(ctx,`담당자 : ${record.managerName||'-'} (${record.managerPhone||'-'})`,175,footerY+285,{size:34,weight:600,maxWidth:1080});
  qDrawText(ctx,company.name,1580,footerY+118,{size:44,weight:700,align:'center',maxWidth:430});
  qDrawText(ctx,`대표이사  ${company.ceo||QUOTATION_COMPANY_FALLBACK.ceo}`,1580,footerY+205,{size:38,weight:600,align:'center',maxWidth:430});
  const seal=await quotationSealImage();
  if(seal){ ctx.save();ctx.globalAlpha=.9;ctx.drawImage(seal,1815,footerY+72,205,205);ctx.restore(); }
}

function qDrawInternalQuotation(ctx,record){
  const rows=quotationRowsForOutput(record);
  ctx.fillStyle='#fff';ctx.fillRect(0,0,QUOTATION_CANVAS_WIDTH,QUOTATION_CANVAS_HEIGHT);
  qDrawText(ctx,'견적 검토표',QUOTATION_CANVAS_WIDTH/2,130,{size:76,weight:700,align:'center'});
  qDrawText(ctx,'내부용',QUOTATION_CANVAS_WIDTH-150,130,{size:28,weight:700,align:'right',color:'#555'});
  ctx.strokeStyle='#222';ctx.lineWidth=3;ctx.strokeRect(140,220,2200,170);
  qDrawText(ctx,`작성일  ${qKoreanDate(record.date)}`,180,270,{size:28,weight:600});
  qDrawText(ctx,`고객사  ${record.customer||'-'} ${record.recipient||''}`,180,340,{size:32,weight:700,maxWidth:900});
  qDrawText(ctx,`견적 제목  ${record.subject||'-'}`,1210,270,{size:28,weight:600,maxWidth:1080});
  qDrawText(ctx,`표시 단가  ${record.priceHeader1||'단가 1'} / ${record.priceHeader2||'단가 2'}`,1210,340,{size:26,maxWidth:1080});

  const publicEnd=qDrawPublicTable(ctx,record,rows,450,{compact:true});
  const tableY=publicEnd+70;
  const x0=140;
  const widths=[380,200,200,210,150,230,200,230,400];
  const headers=['품목','월 사용량','타겟단가','원물시세','수율','생산원가','판관비','판관비포함','판매가 / 권장견적가'];
  let x=x0;
  headers.forEach((header,index)=>{qDrawCell(ctx,{x,y:tableY,w:widths[index],h:94,text:header,size:23,weight:700,fill:'#dedede',maxLines:2});x+=widths[index];});
  let y=tableY+94;
  rows.forEach(row=>{
    const calc=quotationCalc(row);
    const values=[
      row.product||'-',`${qAmount(row.monthlyUsage,2)} KG`,qMoney(row.targetPrice),qMoney(row.rawPrice),`${calc.yieldRate.toFixed(1)}%`,
      qMoney(calc.productionCost),qMoney(row.overheadCost),qMoney(calc.allInCost),
      `판매 ${qMoney(row.salePrice)}\n견적 ${qMoney(qNumber(row.price1)||calc.suggestedPrice)}`
    ];
    x=x0;
    values.forEach((value,index)=>{qDrawCell(ctx,{x,y,w:widths[index],h:108,text:value,size:22,weight:[0,7,8].includes(index)?700:400,align:index===0?'left':'right',maxLines:2,padding:12});x+=widths[index];});
    y+=108;
  });

  const totalUsage=rows.reduce((sum,row)=>sum+qNumber(row.monthlyUsage),0);
  const monthlySales=rows.reduce((sum,row)=>{
    const quote=qNumber(row.price1)||quotationCalc(row).suggestedPrice;
    return sum+qNumber(row.monthlyUsage)*quote;
  },0);
  const monthlyMargin=rows.reduce((sum,row)=>{
    const calc=quotationCalc(row);
    const quote=qNumber(row.price1)||calc.suggestedPrice;
    return sum+qNumber(row.monthlyUsage)*(quote-calc.allInCost);
  },0);
  const weightedQuote=totalUsage?monthlySales/totalUsage:0;
  const summaryY=Math.min(3060,Math.max(y+70,2780));
  qDrawText(ctx,'내부 검토 요약',140,summaryY,{size:30,weight:700});
  const metrics=[
    ['월 사용량 합계',`${qAmount(totalUsage,2)} KG`],['가중 평균 견적가',`${qMoney(weightedQuote)} 원/KG`],
    ['예상 월 매출',`${qMoney(monthlySales)} 원`],['예상 월 마진',`${qMoney(monthlyMargin)} 원`]
  ];
  metrics.forEach((metric,index)=>{
    const boxX=140+index*550;
    qDrawCell(ctx,{x:boxX,y:summaryY+50,w:520,h:135,text:'',fill:'#f2f2f2'});
    qDrawText(ctx,metric[0],boxX+24,summaryY+88,{size:22,weight:600,color:'#555'});
    qDrawText(ctx,metric[1],boxX+496,summaryY+145,{size:31,weight:700,align:'right',maxWidth:450});
  });
  qDrawText(ctx,'내부 검토용 · 외부 전달 금지',QUOTATION_CANVAS_WIDTH/2,3395,{size:25,weight:700,align:'center',color:'#666'});
}

async function renderQuotationCanvas(type,record,canvas){
  const target=canvas||document.createElement('canvas');
  target.width=QUOTATION_CANVAS_WIDTH;target.height=QUOTATION_CANVAS_HEIGHT;
  const ctx=target.getContext('2d',{alpha:false});
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  if(type==='internal') qDrawInternalQuotation(ctx,record);
  else await qDrawExternalQuotation(ctx,record);
  return target;
}

async function renderQuotationPreview(){
  const canvas=document.getElementById('qt-preview-canvas');
  if(!canvas || !quotationDraft) return;
  const serial=++quotationPreviewSerial;
  const rendered=await renderQuotationCanvas(quotationPreviewType,quotationDraft);
  if(serial!==quotationPreviewSerial) return;
  canvas.width=QUOTATION_CANVAS_WIDTH;
  canvas.height=QUOTATION_CANVAS_HEIGHT;
  const ctx=canvas.getContext('2d',{alpha:false});
  ctx.drawImage(rendered,0,0);
}

function quotationFilePart(value){
  return String(value||'견적서').trim().replace(/[\\/:*?"<>|]+/g,'_').replace(/\s+/g,'_').slice(0,50)||'견적서';
}

function quotationValidateOutput(record){
  if(!String(record?.customer||'').trim()){ toast('고객사를 입력한 뒤 출력하세요.'); return false; }
  if(!quotationRowsForOutput(record).length){ toast('출력할 품목을 입력하세요.'); return false; }
  return true;
}

async function downloadQuotationImage(type){
  if(!quotationDraft || !quotationValidateOutput(quotationDraft)) return;
  const canvas=await renderQuotationCanvas(type,quotationDraft);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!blob){ toast('PNG 이미지를 만들지 못했습니다.'); return; }
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  const kind=type==='internal'?'내부용':'외부용';
  link.href=url;link.download=`${quotationDraft.date||'날짜'}_${quotationFilePart(quotationDraft.customer)}_견적서_${kind}.png`;
  document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast(`${kind} 견적서 PNG를 저장했습니다.`);
}

async function copyQuotationImage(){
  if(!quotationDraft || !quotationValidateOutput(quotationDraft)) return;
  if(!navigator.clipboard?.write || typeof ClipboardItem === 'undefined'){
    toast('이 브라우저에서는 이미지 클립보드 복사를 지원하지 않습니다.');
    return;
  }
  try{
    const canvas=await renderQuotationCanvas(quotationPreviewType,quotationDraft);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    if(!blob) throw new Error('PNG 변환 실패');
    await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
    toast(`${quotationPreviewType==='internal'?'내부용':'외부용'} 견적서 이미지를 클립보드에 복사했습니다.`);
  }catch(err){
    console.error('견적서 클립보드 복사 실패:',err);
    toast('클립보드 복사에 실패했습니다. 브라우저의 클립보드 권한을 확인해주세요.');
  }
}

async function printQuotationImage(type){
  if(!quotationDraft || !quotationValidateOutput(quotationDraft)) return;
  const popup=window.open('','_blank');
  if(!popup){ toast('팝업이 차단되어 인쇄창을 열 수 없습니다.'); return; }
  popup.document.write('<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>견적서 준비 중</title></head><body style="font-family:Malgun Gothic,sans-serif;text-align:center;padding:40px;">견적서 이미지를 준비하고 있습니다.</body></html>');
  const canvas=await renderQuotationCanvas(type,quotationDraft);
  const dataUrl=canvas.toDataURL('image/png');
  popup.document.open();
  popup.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${type==='internal'?'내부용':'외부용'} 견적서</title><style>@page{size:A4 portrait;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}img{display:block;width:210mm;height:297mm;object-fit:contain}@media screen{body{background:#ddd;display:flex;justify-content:center}img{box-shadow:0 0 12px rgba(0,0,0,.18)}}</style></head><body><img src="${dataUrl}" onload="setTimeout(()=>window.print(),200)"></body></html>`);
  popup.document.close();
}

window.quotationMetaChanged=quotationMetaChanged;
window.quotationRowChanged=quotationRowChanged;
window.addQuotationRow=addQuotationRow;
window.removeQuotationRow=removeQuotationRow;
window.applyQuotationSuggested=applyQuotationSuggested;
window.newQuotation=newQuotation;
window.saveQuotation=saveQuotation;
window.loadQuotation=loadQuotation;
window.duplicateQuotation=duplicateQuotation;
window.deleteQuotation=deleteQuotation;
window.renderQuotationHistory=renderQuotationHistory;
window.initQuotationPage=initQuotationPage;
window.setQuotationPreviewType=setQuotationPreviewType;
window.copyQuotationImage=copyQuotationImage;
window.downloadQuotationImage=downloadQuotationImage;
window.printQuotationImage=printQuotationImage;

if(typeof APP_DATA_REGISTRY==='object'){
  APP_DATA_REGISTRY.quotationList={
    get:()=>quotationList,
    set:value=>{ quotationList=Array.isArray(value)?value.map(quotationNormalize):[]; },
    ls:QUOTATION_STORAGE_KEY
  };
}
if(typeof APP_DATA_LABELS==='object') APP_DATA_LABELS.quotationList='견적서';
if(typeof DATA_CHANGE_MENU_BY_APP_KEY==='object') DATA_CHANGE_MENU_BY_APP_KEY.quotationList='견적서';
if(Array.isArray(DATA_CHANGE_MENU_ORDER) && !DATA_CHANGE_MENU_ORDER.includes('견적서')){
  const position=DATA_CHANGE_MENU_ORDER.indexOf('원가계산기');
  DATA_CHANGE_MENU_ORDER.splice(position>=0?position+1:DATA_CHANGE_MENU_ORDER.length,0,'견적서');
}

})();
