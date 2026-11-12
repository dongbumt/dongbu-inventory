(function(){
'use strict';
const M=window.DBMTLedgerModel,states={};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>Number(v).toLocaleString('ko-KR');
const kg=v=>Number(v).toLocaleString('ko-KR',{minimumFractionDigits:2,maximumFractionDigits:2});
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const token=()=>window.DBMTAuth?.getSessionToken()||'';
const can=(s,a='view')=>!!window.DBMTAuth?.isPersonal()&&window.DBMTAuth.can(s.menu,a);
const el=(s,id)=>document.getElementById(s.prefix+'-'+id);
const cell=(v,decimal=false)=>`<td class="ledger-num${v<0?' ledger-negative':''}">${v==null?'':decimal?kg(v):money(v)}</td>`;
const boxes=v=>v==null?'박스 미기록 포함':money(v)+' BOX';
function message(s,text,error=false){el(s,'message').textContent=text;el(s,'message').classList.toggle('error',error);}
function empty(s){el(s,'info').textContent=s.kind==='customer'?'등록된 거래처를 선택해주세요.':'등록된 상품을 선택해주세요.';el(s,'table').innerHTML='<table><tbody><tr><td class="ledger-empty">대상을 선택한 후 조회해주세요.</td></tr></tbody></table>';el(s,'totals').textContent='';el(s,'detail').textContent='';s.report=null;}
function closeSuggestions(s){el(s,'suggestions').hidden=true;el(s,'entity').setAttribute('aria-expanded','false');}
function sync(s){
  const view=can(s),busy=s.loading||s.saving;
  s.root.querySelectorAll('.ledger-filters input,.ledger-filters select,.ledger-options input').forEach(x=>x.disabled=busy||!view);
  s.root.querySelectorAll('[data-ledger-action]').forEach(b=>{
    const a=b.dataset.ledgerAction;
    b.disabled=busy||!view||(a==='print'&&!s.report);
    if(['save-account','save-entry','edit-entry','delete-entry'].includes(a)){
      const action=a==='save-account'?(account(s)?'update':'create'):a==='save-entry'?(s.editing?'update':'create'):a==='delete-entry'?'delete':'update';
      b.disabled=b.disabled||!can(s,action)||!el(s,'entity-id').value;
    }
  });
  if(s.kind==='customer'){
    el(s,'finance').hidden=!view||(!can(s,'create')&&!can(s,'update'));
    s.root.querySelectorAll('.ledger-finance input,.ledger-finance select').forEach(x=>x.disabled=busy||!view);
  }
  s.root.querySelectorAll('[data-ledger-action="query"]').forEach(b=>b.setAttribute('aria-busy',s.loading?'true':'false'));
}
function account(s){return s.ctx?.accounts.find(a=>String(a.partner_id)===el(s,'entity-id').value)||null;}
function resetFinance(s){
  if(s.kind!=='customer')return;
  const a=account(s);s.dirty=false;s.accountDirty=false;s.entryDirty=false;s.editing=null;s.draftId=null;s.accountRevision=a?.revision??null;s.financePartner=el(s,'entity-id').value;
  el(s,'opening-date').value=a?.opening_date||el(s,'from').value||today();el(s,'opening-ar').value=a?.opening_ar??'';el(s,'opening-ap').value=a?.opening_ap??'';
  el(s,'entry-date').value=today();el(s,'entry-kind').value='receipt';el(s,'entry-amount').value='';el(s,'entry-note').value='';el(s,'entry-title').textContent='수금·지급 등록';sync(s);
}
function applyPermissions(){
  Object.values(states).forEach(s=>{
    if(s.token!==token()||!can(s)){
      s.seq++;s.token=token();s.ctx=null;s.loading=false;s.saving=false;s.promise=null;s.lastFilters=null;s.selected='';s.dirty=false;
      el(s,'entity').value='';el(s,'entity-id').value='';closeSuggestions(s);empty(s);resetFinance(s);message(s,can(s)?'':'이 원장의 조회 권한이 없습니다.');
    }
    sync(s);
  });
}
function criteria(s){return {from:el(s,'from').value,to:el(s,'to').value,ascending:el(s,'ascending').checked,
  ...(s.kind==='customer'?{partnerId:el(s,'entity-id').value,mode:s.root.querySelector('input[name="cl-mode"]:checked').value}:{productId:el(s,'entity-id').value,lot:el(s,'lot').value})};}
function choices(s){return s.ctx?(s.kind==='customer'?s.ctx.partners:s.ctx.products):[];}
function suggestions(s){
  if(!s.ctx||!can(s))return;
  const q=el(s,'entity').value.trim().toLocaleLowerCase('ko-KR');
  const matches=choices(s).filter(p=>[p.name,p.code,p.productCode,p.brand,p.origin,...(p.aliases||[])].filter(Boolean).join(' ').toLocaleLowerCase('ko-KR').includes(q))
    .sort((a,b)=>String(a.name).localeCompare(String(b.name),'ko')||String(a.id).localeCompare(String(b.id)));
  el(s,'suggestions').innerHTML=matches.slice(0,60).map(p=>`<button type="button" data-ledger-choose="${esc(p.id)}"><strong>${esc(p.name)}</strong><small>${esc([p.code||p.productCode,p.brand,p.origin,p.packunit,p.active===false||p.isActive===false?'사용 중지 · 과거 조회 가능':''].filter(Boolean).join(' · '))}</small></button>`).join('')||'<div class="ledger-no-matches">등록된 항목이 없습니다.</div>';
  el(s,'suggestions').hidden=false;el(s,'entity').setAttribute('aria-expanded','true');
}
function choose(s,id){
  if(s.dirty&&!confirm('작성 중인 기초잔액·수금·지급 입력을 비우고 다른 거래처를 선택할까요?'))return;
  const p=choices(s).find(p=>String(p.id)===id);if(!p)return;
  s.dirty=false;el(s,'entity-id').value=id;el(s,'entity').value=p.name;s.selected='';
  if(s.kind==='product')el(s,'lot').innerHTML='<option value="">전체</option>';
  el(s,'entity').focus();closeSuggestions(s);resetFinance(s);render(s);
}
function customerTable(r){
  const head='<colgroup>'+[9,18.5,4.5,7,7,10,10,10,10,14].map(n=>`<col style="width:${n}%">`).join('')+'</colgroup><thead><tr>'+['일자','상품명(브랜드)','박스','KG','단가','매입금액','매출금액','지급액','수금액','잔액'].map(t=>`<th>${t}</th>`).join('')+'</tr></thead>';
  let body=`<tr class="ledger-carry"><td></td><td>이월 / ${r.configured?'기초잔액':'거래차액'}</td><td colspan="7"></td>${cell(r.opening)}</tr>`;
  body+=r.rows.map(x=>`<tr data-ledger-row="${esc(x.id)}"><td class="ledger-center">${x.date.replaceAll('-','/')}</td><td><button type="button" class="ledger-row-button" title="${esc(x.name+(x.brand?' ('+x.brand+')':''))}">${esc(x.name+(x.brand?' ('+x.brand+')':''))}</button></td>${cell(x.boxes)}${cell(x.weight,true)}${cell(x.price)}${cell(x.kind==='입고'?x.amount:null)}${cell(x.kind==='출고'?x.amount:null)}${cell(x.kind==='지급'?x.amount:null)}${cell(x.kind==='수금'?x.amount:null)}${cell(x.balance)}</tr>`).join('');
  if(!r.rows.length)body+='<tr><td colspan="10" class="ledger-empty">조회된 거래가 없습니다.</td></tr>';
  return `<table aria-label="거래처원장">${head}<tbody>${body}</tbody><tfoot><tr><td colspan="2">거래량·금액 합계</td>${cell(r.qty.boxes)}${cell(r.qty.weight,true)}<td></td>${cell(r.sums.입고)}${cell(r.sums.출고)}${cell(r.sums.지급)}${cell(r.sums.수금)}${cell(r.closing)}</tr></tfoot></table>`;
}
function productTable(r){
  const head='<colgroup>'+[9,16.5,6,3.5,6.5,5.7,8.5,3.5,6.5,5.7,8.5,12.6,7.5].map(n=>`<col style="width:${n}%">`).join('')+'</colgroup><thead><tr><th rowspan="2">일자</th><th rowspan="2">거래처·작업</th><th rowspan="2">구분</th><th colspan="4">입고</th><th colspan="4">출고</th><th rowspan="2">이력번호</th><th rowspan="2">지점</th></tr><tr>'+['박스','KG','단가','금액','박스','KG','단가','금액'].map(x=>`<th>${x}</th>`).join('')+'</tr></thead>';
  let body=`<tr class="ledger-carry"><td></td><td>이월 / 기초재고</td><td class="ledger-center">이월</td>${cell(r.opening.boxes)}${cell(r.opening.weight,true)}<td colspan="8"></td></tr>`;
  const entry=x=>cell(x.boxes)+cell(x.weight,true)+cell(x.price)+cell(x.amount),blank='<td></td>'.repeat(4);
  body+=r.rows.map(x=>`<tr data-ledger-row="${esc(x.id)}"><td class="ledger-center">${x.date.replaceAll('-','/')}</td><td><button type="button" class="ledger-row-button" title="${esc(x.name)}">${esc(x.name)}</button></td><td class="ledger-center" title="${esc(x.kind)}">${esc(x.kind)}</td>${x.direction>0?entry(x):blank}${x.direction<0?entry(x):blank}<td class="ledger-center" title="${esc(x.lot)}">${esc(x.lot)}</td><td class="ledger-center" title="${esc(x.location)}">${esc(x.location)}</td></tr>`).join('');
  if(!r.rows.length)body+='<tr><td colspan="13" class="ledger-empty">조회된 수불 내역이 없습니다.</td></tr>';
  const sum=x=>cell(x.boxes)+cell(x.weight,true)+'<td></td>'+cell(x.amount);
  return `<table aria-label="상품원장">${head}<tbody>${body}</tbody><tfoot><tr><td colspan="3">기간 합계</td>${sum(r.incoming)}${sum(r.outgoing)}<td colspan="2"></td></tr></tfoot></table>`;
}
function detail(s){
  const r=s.report?.rows.find(x=>String(x.id)===s.selected);if(!r){el(s,'detail').textContent='행을 누르면 이력번호와 비고를 확인할 수 있습니다.';return;}
  el(s,'detail').innerHTML=`<span>${esc([r.date,r.kind,r.name,r.brand,r.lot,r.location,r.note].filter(Boolean).join(' · '))}</span>`+(r.financial?`<button type="button" class="btn btn-secondary btn-sm" data-ledger-action="edit-entry">수정</button><button type="button" class="btn btn-secondary btn-sm" data-ledger-action="delete-entry">삭제</button>`:'');sync(s);
}
function fitNumbers(s){
  const table=el(s,'table').querySelector('table');if(!table||!table.clientWidth)return;
  let factor=1;table.querySelectorAll('td.ledger-num,td.ledger-center').forEach(c=>{if(c.scrollWidth>c.clientWidth+1)factor=Math.max(factor,c.scrollWidth/c.clientWidth);});
  if(factor>1)table.style.minWidth=Math.ceil(table.clientWidth*(factor+0.02))+'px';
}
function render(s){
  if(!s.ctx||!el(s,'entity-id').value){empty(s);sync(s);return;}
  try{
    const filters=criteria(s),r=s.kind==='customer'?M.customer(s.ctx,filters):M.product(s.ctx,filters);
    s.report=r;s.lastFilters=filters;
    const loaded=new Date(s.loadedAt).toLocaleString('ko-KR');
    if(s.kind==='customer'){
      el(s,'info').innerHTML=`<span>거래처코드 ${esc(r.party.code||'—')}</span><strong>${esc(r.party.name)}</strong><span class="ledger-info-right">${filters.from} ~ ${filters.to} · 원 / KG</span>`;
      el(s,'table').innerHTML=customerTable(r);
      el(s,'totals').innerHTML=`<span>${r.rows.length}건</span><span>${r.configured?'잔액: 양수 미수 / 음수 미지급':'기초잔액 미등록'}</span>${r.qty.boxes==null?'<span>박스 미기록 포함</span>':''}<span class="ledger-balance">${r.configured?'최종 잔액':'거래 차액'} <strong>${money(r.closing)}원</strong></span>`;
      if(!s.dirty)resetFinance(s);
    }else{
      const p=r.product;el(s,'info').innerHTML=`<span>상품코드 ${esc(p.productCode||'—')}</span><strong>${esc(p.name)}</strong><span>${esc([p.brand,p.origin,p.packunit].filter(Boolean).join(' · '))}</span><span class="ledger-info-right">${esc(filters.lot||'전체 이력번호')} · 원 / KG</span>`;
      el(s,'table').innerHTML=productTable(r);
      el(s,'totals').innerHTML=`<span>${r.rows.length}건</span><span>생입: 생산입고 / 생출: 생산투입</span><span class="ledger-balance">재고 <strong>${boxes(r.closing.boxes)}</strong><strong>${kg(r.closing.weight)} KG</strong></span>`;
      el(s,'lot').innerHTML='<option value="">전체</option>'+r.lots.map(l=>`<option value="${esc(l)}"${filters.lot===l?' selected':''}>${esc(l)}</option>`).join('');
    }
    fitNumbers(s);detail(s);message(s,[r.notice,`자료 기준: ${loaded}`].filter(Boolean).join('\n'));
  }catch(error){message(s,error.message,true);}
  sync(s);
}
async function load(kind){
  const s=states[kind];if(!can(s)){applyPermissions();return;}
  if(s.loading||s.saving)return s.promise;
  const auth=token(),request=++s.seq;s.loading=true;sync(s);closeSuggestions(s);message(s,'서버의 최신 원장 자료를 불러오는 중입니다…');
  s.promise=(async()=>{
    try{
      const data=await sbRpc('dbmt_erp_get_ledger_snapshot',{p_token:auth,p_kind:kind});
      if(request!==s.seq||auth!==token()||!can(s))return;
      if(!data?.ok||!Array.isArray(data.transactions)||!Array.isArray(data.products)||!Array.isArray(data.partners)||!Array.isArray(data.production))throw Error(data?.message||'원장 자료 형식을 확인할 수 없습니다.');
      s.ctx=M.prepare(data);s.loadedAt=data.loadedAt||new Date().toISOString();
      const selected=choices(s).find(p=>String(p.id)===el(s,'entity-id').value);
      if(el(s,'entity-id').value&&!selected){el(s,'entity-id').value='';s.dirty=false;}
      render(s);if(!s.report)message(s,'대상을 검색하여 선택한 후 조회해주세요.');
    }catch(error){if(auth===token()&&request===s.seq)message(s,'조회 실패: '+(error.message||error),true);}
    finally{if(request===s.seq){s.loading=false;s.promise=null;sync(s);}}
  })();return s.promise;
}
async function write(s,rpc,args,done){
  if(s.saving||s.loading)return;
  const auth=token();s.saving=true;sync(s);message(s,'서버에 저장하는 중입니다…');
  try{
    const data=await sbRpc(rpc,{p_token:auth,...args});
    if(auth!==token()||!can(s))return;
    if(!data?.ok)throw Error(data?.message||'저장하지 못했습니다.');
    done(data);render(s);message(s,'서버 저장을 완료했습니다.');
  }catch(error){if(auth===token())message(s,'저장 실패: '+(error.message||error),true);}
  finally{if(auth===token()){s.saving=false;sync(s);}}
}
function financialOwner(s){if(!el(s,'entity-id').value||s.financePartner!==el(s,'entity-id').value)throw Error('거래처를 먼저 선택해주세요.');}
function resetEntry(s){s.editing=null;s.draftId=null;s.entryDirty=false;s.dirty=!!s.accountDirty;el(s,'entry-date').value=today();el(s,'entry-kind').value='receipt';el(s,'entry-amount').value='';el(s,'entry-note').value='';el(s,'entry-title').textContent='수금·지급 등록';}
async function saveAccount(s){
  try{
    financialOwner(s);if(!can(s,account(s)?'update':'create'))throw Error('기초잔액 저장 권한이 없습니다.');
    const ar=el(s,'opening-ar').value,ap=el(s,'opening-ap').value,d=el(s,'opening-date').value;
    if(!M.date(d)||ar===''||ap===''||![ar,ap].every(v=>Number.isSafeInteger(Number(v))&&Number(v)>=0))throw Error('기초일자와 받을 잔액·줄 잔액을 입력하세요. 확인된 0원도 입력할 수 있습니다.');
    await write(s,'dbmt_erp_save_ledger_account',{p_partner:s.financePartner,p_date:d,p_ar:Number(ar),p_ap:Number(ap),p_revision:s.accountRevision},data=>{
      if(!data.account)throw Error('저장 결과를 확인할 수 없습니다. 다시 조회해주세요.');
      s.ctx.accounts=s.ctx.accounts.filter(a=>a.partner_id!==data.account.partner_id).concat(data.account);s.accountRevision=data.account.revision;s.accountDirty=false;s.dirty=!!s.entryDirty;
    });
  }catch(e){message(s,e.message,true);}
}
async function saveEntry(s){
  try{
    financialOwner(s);if(!can(s,s.editing?'update':'create'))throw Error('수금·지급 저장 권한이 없습니다.');
    const amount=el(s,'entry-amount').value,d=el(s,'entry-date').value;
    if(!M.date(d)||amount===''||!Number.isSafeInteger(Number(amount))||Number(amount)<=0)throw Error('처리일과 1원 이상의 정수 금액을 입력해주세요.');
    if(!account(s))throw Error('기초잔액을 먼저 등록해주세요.');
    s.draftId=s.draftId||crypto.randomUUID();
    await write(s,'dbmt_erp_save_ledger_entry',{p_id:s.editing?.id||s.draftId,p_partner:s.financePartner,p_date:d,p_kind:el(s,'entry-kind').value,p_amount:Number(amount),p_note:el(s,'entry-note').value,p_revision:s.editing?.revision??null},data=>{
      if(!data.entry)throw Error('저장 결과를 확인할 수 없습니다. 다시 조회해주세요.');
      s.ctx.entries=s.ctx.entries.filter(e=>e.id!==data.entry.id).concat(data.entry);resetEntry(s);
    });
  }catch(e){message(s,e.message,true);}
}
function editEntry(s){
  if(!can(s,'update'))return;
  const r=s.report?.rows.find(r=>String(r.id)===s.selected&&r.financial);if(!r)return;
  if(s.dirty&&!confirm('작성 중인 입력을 비우고 선택한 내역을 수정할까요?'))return;
  resetFinance(s);s.editing=r.raw;s.dirty=true;s.entryDirty=true;el(s,'finance').open=true;el(s,'entry-title').textContent='수금·지급 수정';
  el(s,'entry-date').value=r.date;el(s,'entry-kind').value=r.raw.kind;el(s,'entry-amount').value=r.amount;el(s,'entry-note').value=r.note||'';sync(s);
}
async function deleteEntry(s){
  if(!can(s,'delete'))return;const r=s.report?.rows.find(r=>String(r.id)===s.selected&&r.financial);if(!r)return;
  if(!confirm(`${r.date} ${r.kind} ${money(r.amount)}원 내역을 삭제할까요?`))return;
  await write(s,'dbmt_erp_delete_ledger_entry',{p_id:r.id,p_revision:r.raw.revision},()=>{s.ctx.entries=s.ctx.entries.filter(e=>e.id!==r.id);s.selected='';if(s.editing?.id===r.id){s.dirty=false;resetFinance(s);}});
}
function print(s){
  if(!s.report||!can(s))return;
  const popup=window.open('about:blank','_blank');if(!popup){message(s,'출력 창을 열 수 없습니다. 팝업 허용을 확인해주세요.',true);return;}
  popup.opener=null;const table=el(s,'table').firstElementChild.cloneNode(true);table.removeAttribute('style');table.querySelectorAll('button').forEach(b=>b.replaceWith(document.createTextNode(b.textContent)));
  const title=s.kind==='customer'?'거래처원장':'상품원장';
  popup.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title><style>@page{size:A4 landscape;margin:10mm}body{font:10pt 'Malgun Gothic',sans-serif;color:#222;margin:0}h1{font-size:16pt;margin:0 0 8mm}.info{font-size:9pt;margin-bottom:4mm}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:8.5pt}th,td{border:1px solid #bbb;padding:4px;overflow-wrap:anywhere;vertical-align:middle}th,tfoot,.ledger-carry{background:#f2f2f2}th{text-align:center}td.ledger-num{text-align:right}td.ledger-center{text-align:center}thead{display:table-header-group}tfoot{display:table-row-group}tr{break-inside:avoid}.totals{margin-top:4mm;font-size:9pt}</style></head><body><h1>${title}</h1><div class="info">${esc(el(s,'info').textContent)}</div>${table.outerHTML}<div class="totals">${esc(el(s,'totals').textContent)}</div><div class="totals">${esc(el(s,'message').textContent)}</div></body></html>`);
  popup.document.close();popup.focus();setTimeout(()=>{if(!popup.closed)popup.print();},150);
}
for(const kind of ['customer','product']){
  const s=states[kind]={kind,prefix:kind==='customer'?'cl':'pl',menu:kind==='customer'?'customer_ledger':'product_ledger',root:document.querySelector(`[data-ledger="${kind}"]`),seq:0,token:'',loading:false,saving:false,ctx:null,report:null,selected:'',dirty:false};
  if(!s.root)continue;
  el(s,'from').value=today().slice(0,7)+'-01';el(s,'to').value=today();empty(s);
  s.root.addEventListener('click',e=>{
    const choice=e.target.closest('[data-ledger-choose]');if(choice){e.preventDefault();choose(s,choice.dataset.ledgerChoose);return;}
    const row=e.target.closest('[data-ledger-row]');if(row&&e.target.closest('button')){s.selected=row.dataset.ledgerRow;s.root.querySelectorAll('[data-ledger-row]').forEach(r=>r.classList.toggle('ledger-selected',r.dataset.ledgerRow===s.selected));detail(s);}
    const a=e.target.closest('[data-ledger-action]')?.dataset.ledgerAction;
    if(a==='query')load(kind);if(a==='print')print(s);if(a==='save-account')saveAccount(s);if(a==='save-entry')saveEntry(s);if(a==='edit-entry')editEntry(s);if(a==='delete-entry')deleteEntry(s);
    if(a==='reset-finance'){resetFinance(s);message(s,'입력을 초기화했습니다.');}
  });
  el(s,'entity').addEventListener('focus',()=>suggestions(s));
  el(s,'entity').addEventListener('input',()=>{el(s,'entity-id').value='';suggestions(s);sync(s);});
  const markDirty=e=>{if(e.target.closest('.ledger-finance')){s.dirty=true;if(e.target.id.startsWith('cl-opening-'))s.accountDirty=true;else s.entryDirty=true;}};
  s.root.addEventListener('input',markDirty);
  s.root.addEventListener('change',e=>{if(e.target.closest('.ledger-finance'))markDirty(e);else if(e.target.id===s.prefix+'-lot'||e.target.id===s.prefix+'-ascending'||e.target.name==='cl-mode')render(s);});
  s.root.addEventListener('keydown',e=>{
    const list=el(s,'suggestions'),input=el(s,'entity'),buttons=[...list.querySelectorAll('button')],index=buttons.indexOf(e.target);
    if(e.key==='Escape'){closeSuggestions(s);return;}
    if(e.key==='ArrowDown'&&(e.target===input||index>=0)){e.preventDefault();if(list.hidden)suggestions(s);const items=[...list.querySelectorAll('button')];items[Math.min(index+1,items.length-1)]?.focus();}
    if(e.key==='ArrowUp'&&index>=0){e.preventDefault();if(index===0)input.focus();else buttons[index-1].focus();}
    if(e.key==='Enter'&&e.target===input){e.preventDefault();if(!list.hidden)buttons[0]?.click();else load(kind);}
    if(e.key==='Enter'&&e.target.matches('input[type=date]')&&!e.target.closest('.ledger-finance')){e.preventDefault();load(kind);}
  });
}
document.addEventListener('click',e=>Object.values(states).forEach(s=>{if(s.root&&!el(s,'entity').parentElement.contains(e.target))closeSuggestions(s);}));
window.DBMTLedgers=Object.freeze({init:async(kind,reason='menu')=>{applyPermissions();const s=states[kind];if(!s||!can(s))return;if(reason==='menu'||!s.ctx)return load(kind);render(s);},applyPermissions});
})();
