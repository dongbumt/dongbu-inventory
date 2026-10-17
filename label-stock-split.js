(function(){
  'use strict';
  const state={generation:0,token:'',productionId:'',stockRowId:'',data:null,selected:new Set(),loading:false,saving:false,saved:false,cancelled:false,attempt:null,opener:null};
  const unresolved=new Map();
  const el=id=>document.getElementById('label-split-'+id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const can=()=>Boolean(window.DBMTAuth?.isPersonal() && DBMTAuth.can('production','view') && DBMTAuth.can('production','update'));
  const token=()=>window.DBMTAuth?.getSessionToken()||'';
  const kg=value=>Number(value||0).toLocaleString('ko-KR',{minimumFractionDigits:2,maximumFractionDigits:2})+' KG';
  const sum=rows=>Math.round(rows.reduce((total,row)=>total+Number(row.weight),0)*100)/100;
  const attemptKey=()=>JSON.stringify([state.token,state.productionId,state.stockRowId]);
  const labels=()=>state.data?.labels||[];
  const busyEditing=()=>Boolean(typeof _editProdId!=='undefined' && _editProdId || typeof productionWritePending!=='undefined' && productionWritePending);
  const current=(generation,session)=>state.generation===generation && state.token===session && token()===session && can();
  async function request(name,payload){
    let timer;
    try{
      return await Promise.race([sbRpc(name,payload),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('서버 응답 대기 시간이 지났습니다.')),45000);})]);
    }finally{clearTimeout(timer);}
  }
  function message(text='',error=false){el('message').textContent=text;el('message').classList.toggle('error',error);}
  function buttonHtml(entry,row){
    if(!entry?._labelCompletion || !row?.stockRowId || !can())return '';
    return `<button type="button" class="btn btn-secondary btn-sm label-split-open" data-production-id="${esc(entry.id)}" data-stock-row-id="${esc(row.stockRowId)}">라벨 분할</button>`;
  }
  function dateText(value){
    const date=new Date(value);
    if(!value || !Number.isFinite(date.getTime()))return String(value||'—');
    return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
  }
  function batches(){
    const groups=new Map();
    labels().forEach(row=>{
      const id=String(row.batchId || row.printedAt || row.id);
      if(!groups.has(id))groups.set(id,[]);
      groups.get(id).push(row);
    });
    return groups;
  }
  function syncControls(){
    const rows=labels(),count=state.selected.size;
    const locked=state.loading || state.saving || state.saved || Boolean(state.attempt?.unknown) || !state.data?.canSplit || !can();
    el('labels').querySelectorAll('input').forEach(input=>{input.disabled=locked;input.checked=state.selected.has(input.dataset.labelId);input.closest('tr').classList.toggle('is-selected',input.checked);});
    el('select-all').disabled=locked || !rows.length;
    el('select-all').checked=Boolean(rows.length && count===rows.length);
    el('select-all').indeterminate=count>0 && count<rows.length;
    const groups=batches();
    el('batches').querySelectorAll('button').forEach(button=>{
      button.disabled=locked;
      button.classList.toggle('is-selected',(groups.get(button.dataset.batchId)||[]).every(row=>state.selected.has(row.id)));
    });
    const chosen=rows.filter(row=>state.selected.has(row.id)),remaining=rows.filter(row=>!state.selected.has(row.id));
    el('selected-weight').textContent=kg(sum(chosen));el('selected-boxes').textContent=`${chosen.length} 박스`;
    el('remaining-weight').textContent=kg(sum(remaining));el('remaining-boxes').textContent=`${remaining.length} 박스`;
    el('save').disabled=state.loading || state.saving || state.saved || !can() || !state.data?.canSplit || !count || count===rows.length || sum(chosen)<=0 || sum(remaining)<=0;
    el('save').textContent=state.saving?'분할 저장 중…':state.attempt?.unknown?'저장 결과 확인 · 다시 시도':'분할 저장';
    el('refresh').disabled=state.loading || state.saving || Boolean(state.attempt?.unknown);
    el('refresh').textContent=state.saved?'최신 내역 다시 불러오기':'최신 라벨 불러오기';
    el('close').disabled=state.saving;
    el('dismiss').disabled=state.saving;
    el('hint').textContent=state.attempt?.unknown?'저장 결과를 확인하지 못했습니다. 같은 선택으로 다시 시도하면 중복 분할 없이 결과를 확인합니다.':!state.data?.canSplit && state.data?.reason?state.data.reason:count===rows.length && rows.length?'전체 라벨을 선택하면 분할할 수 없습니다. 남길 라벨을 1장 이상 제외하세요.':'분리할 라벨을 선택하세요. 각 라벨은 1박스이며, 선택한 중량과 박스수만 새 생산품 행으로 나뉩니다.';
  }
  function render(){
    el('product').textContent=state.data?.product || state.data?.row?.product || '생산품 라벨을 불러오는 중…';
    const row=state.data?.row;
    el('context').textContent=row?`${row.origin||''}${row.lot?' · LOT '+row.lot:''} · 전체 ${kg(sum(labels()))} / ${labels().length} 박스`:'';
    el('labels').innerHTML=labels().length?labels().map(row=>`<tr data-label-row="${esc(row.id)}"><td><input type="checkbox" data-label-id="${esc(row.id)}" aria-label="${esc(row.code)} 라벨 선택"></td><td><code>${esc(row.code)}</code></td><td>${esc(dateText(row.printedAt))}</td><td>${kg(row.weight)}</td></tr>`).join(''):`<tr><td colspan="4" class="label-split-empty">${state.loading?'출력 라벨을 불러오는 중입니다.':'분할할 수 있는 라벨이 없습니다.'}</td></tr>`;
    el('batches').innerHTML=[...batches()].map(([id,rows])=>`<button type="button" class="btn btn-secondary btn-sm" data-batch-id="${esc(id)}" title="이 출력 묶음 전체 선택 또는 해제">${esc(dateText(rows[0].printedAt))} · ${rows.length}박스</button>`).join('');
    syncControls();
  }
  function close(force=false){
    if(state.saving && !force)return false;
    if(state.attempt?.unknown)unresolved.set(attemptKey(),{data:state.data,selected:[...state.selected],attempt:state.attempt});
    state.generation++;state.loading=false;state.data=null;state.selected=new Set();state.attempt=null;state.saved=false;state.cancelled=false;
    el('dialog').close();
    if(state.opener?.isConnected)state.opener.focus();
    return true;
  }
  function applyPermissions(){
    const session=token();
    if(state.token && (session!==state.token || !can())){
      state.saving=false;state.attempt=null;close(true);unresolved.clear();state.token='';
    }
    document.querySelectorAll('.label-split-open').forEach(button=>{button.hidden=!can();});
  }
  async function refresh(){
    if(state.loading || state.saving || state.attempt?.unknown || !can())return;
    if(state.saved){await reloadAfterSave();return;}
    const generation=++state.generation,session=state.token;
    const prior=new Set(state.selected);
    state.loading=true;state.data=null;state.attempt=null;message('');render();
    try{
      const data=await request('dbmt_erp_get_label_split',{p_token:session,p_production_id:state.productionId,p_stock_row_id:state.stockRowId});
      if(!current(generation,session))return;
      if(!data?.ok)throw new Error(data?.message||'분할할 라벨을 불러오지 못했습니다.');
      if(String(data.productionId)!==state.productionId || String(data.stockRowId)!==state.stockRowId || !Array.isArray(data.labels))throw new Error('생산품 라벨 정보가 일치하지 않습니다. 다시 불러오세요.');
      const seen=new Set();
      data.labels=data.labels.map(row=>({...row,id:String(row.id??'')}));
      for(const row of data.labels){
        if(!row.id || seen.has(row.id) || !Number.isFinite(Number(row.weight)) || !(Number(row.weight)>0))throw new Error('라벨 중량 또는 연결 정보를 확인할 수 없습니다.');
        seen.add(row.id);
      }
      state.data=data;state.selected=new Set(data.labels.filter(row=>prior.has(row.id)).map(row=>row.id));
      if(!data.canSplit)message(data.reason||'이 생산품은 현재 분할할 수 없습니다.',true);
    }catch(error){if(current(generation,session))message(error.message||String(error),true);}
    finally{if(current(generation,session)){state.loading=false;render();}}
  }
  async function open(productionId,stockRowId){
    if(state.saving)return;
    if(!can()){if(typeof toast==='function')toast('생산일보를 수정할 권한이 없습니다.');return;}
    if(busyEditing()){if(typeof toast==='function')toast('입력 중인 생산일보를 저장하거나 초기화한 뒤 라벨을 분할해주세요.');return;}
    state.generation++;state.token=token();state.productionId=String(productionId);state.stockRowId=String(stockRowId);state.selected=new Set();state.data=null;state.attempt=null;state.saved=false;state.cancelled=false;state.loading=false;state.opener=document.activeElement;
    message('');render();if(!el('dialog').open)el('dialog').showModal();
    const pending=unresolved.get(attemptKey());
    if(pending){state.data=pending.data;state.selected=new Set(pending.selected);state.attempt=pending.attempt;message('이전에 요청한 분할의 저장 결과를 확인해주세요.',true);render();return;}
    await refresh();
  }
  function applyEntry(entry,rows,cancelled=false){
    if(!Array.isArray(rows) || !cancelled && !entry)return false;
    const id=cancelled?state.productionId:String(entry.id);
    userProdEntries=userProdEntries.filter(row=>String(row.id)!==id).concat(cancelled?[]:entry);
    userTransactions=userTransactions.filter(row=>String(row._prodId)!==id).concat(cancelled?[]:rows);
    transactions=[...EXCEL_TRANSACTIONS,...userTransactions];
    markLocalCoreChanged();
    safeLocalStorageSet('dbmt_user_prod',JSON.stringify(userProdEntries),true);
    safeLocalStorageSet('dbmt_user_transactions',JSON.stringify(userTransactions),true);
    renderProduction();
    return true;
  }
  async function reloadAfterSave(){
    const generation=state.generation,session=state.token;
    state.loading=true;message(state.cancelled?'생산완료가 취소된 내역입니다. 최신 생산일보와 재고를 불러오는 중입니다…':'분할을 저장했습니다. 최신 생산일보와 재고를 불러오는 중입니다…');syncControls();
    const revision=typeof localCoreRevision==='undefined'?null:localCoreRevision;
    try{
      const data=await request('dbmt_erp_get_label_productions',{p_token:session});
      if(!current(generation,session))return;
      if(!data?.ok || !Array.isArray(data.productionIds) || !Array.isArray(data.entries) || !Array.isArray(data.transactions))throw new Error(data?.message||'최신 생산일보를 불러오지 못했습니다.');
      if(revision!==null && localCoreRevision!==revision)throw new Error('다른 변경사항이 저장됐습니다. 최신 내역을 다시 불러오세요.');
      const ids=new Set(data.productionIds.map(String));ids.add(state.productionId);
      userProdEntries=userProdEntries.filter(row=>!ids.has(String(row.id))).concat(data.entries);
      userTransactions=userTransactions.filter(row=>!ids.has(String(row._prodId))).concat(data.transactions);
      transactions=[...EXCEL_TRANSACTIONS,...userTransactions];markLocalCoreChanged();
      safeLocalStorageSet('dbmt_user_prod',JSON.stringify(userProdEntries),true);
      safeLocalStorageSet('dbmt_user_transactions',JSON.stringify(userTransactions),true);
      renderProduction();
      if(typeof renderTransactions==='function')renderTransactions();
      if(typeof renderStock==='function' && document.getElementById('p-stock')?.classList.contains('active'))renderStock();
      const cancelled=state.cancelled;
      state.loading=false;close();if(typeof toast==='function')toast(cancelled?'생산완료가 취소된 생산일보입니다. 최신 생산일보와 재고로 갱신했습니다.':'선택한 라벨의 중량과 박스수대로 생산품과 재고를 분할했습니다.');
    }catch(error){if(current(generation,session))message(`${state.cancelled?'생산완료가 취소된 내역입니다.':'분할은 저장됐습니다.'} ${error.message||error}\n‘최신 내역 다시 불러오기’를 눌러 화면을 갱신해주세요.`,true);}
    finally{if(current(generation,session)){state.loading=false;syncControls();}}
  }
  async function save(){
    syncControls();if(el('save').disabled || !can())return;
    const generation=state.generation,session=state.token;
    const selected=[...state.selected].sort();
    const fingerprint=JSON.stringify([state.productionId,state.stockRowId,state.data.version,selected]);
    if(!state.attempt || state.attempt.fingerprint!==fingerprint)state.attempt={fingerprint,requestId:crypto.randomUUID(),unknown:false};
    state.saving=true;syncControls();message('선택한 라벨을 기준으로 생산품과 재고를 분할하는 중입니다…');
    if(typeof productionWritePending!=='undefined')productionWritePending++;
    try{
      const result=await request('dbmt_erp_split_label_stock',{p_token:session,p_production_id:state.productionId,p_stock_row_id:state.stockRowId,p_label_ids:selected,p_version:state.data.version,p_request_id:state.attempt.requestId});
      if(!current(generation,session))return;
      if(typeof result?.ok!=='boolean')throw new Error('서버에서 저장 결과를 확인할 수 있는 응답을 받지 못했습니다.');
      if(!result?.ok){const error=new Error(result?.message||'라벨 분할을 저장하지 못했습니다.');error.code='REJECTED';throw error;}
      unresolved.delete(attemptKey());state.attempt=null;state.saved=true;state.cancelled=Boolean(result.cancelled);
      applyEntry(result.entry,result.transactionRows,state.cancelled);
      state.saving=false;await reloadAfterSave();
    }catch(error){
      if(!current(generation,session))return;
      if(state.saved){message(`분할은 저장됐습니다. ${error.message||error}\n‘최신 내역 다시 불러오기’를 눌러 화면을 갱신해주세요.`,true);return;}
      const rejected=Boolean(error.code) || Number(error.status)>=400 && Number(error.status)<500;
      if(rejected){state.attempt=null;unresolved.delete(attemptKey());message(`${error.message||error}\n최신 라벨을 불러온 뒤 다시 선택해주세요.`,true);state.data.canSplit=false;}
      else{state.attempt.unknown=true;unresolved.set(attemptKey(),{data:state.data,selected:[...state.selected],attempt:state.attempt});message(`저장 결과를 확인하지 못했습니다. ${error.message||error}\n‘저장 결과 확인 · 다시 시도’를 눌러주세요.`,true);}
    }finally{
      if(typeof productionWritePending!=='undefined')productionWritePending=Math.max(0,productionWritePending-1);
      if(current(generation,session)){state.saving=false;syncControls();}
    }
  }
  const dialog=document.createElement('dialog');dialog.id='label-split-dialog';dialog.setAttribute('aria-labelledby','label-split-title');
  dialog.innerHTML=`<div class="label-split-layout"><header class="label-split-header"><div class="label-split-header-row"><h2 id="label-split-title">출력 라벨로 생산품 분할</h2><button type="button" class="btn btn-secondary btn-sm" id="label-split-dismiss" aria-label="라벨 분할 닫기">×</button></div><p id="label-split-product"></p><p id="label-split-context"></p></header><section class="label-split-workspace"><div class="label-split-toolbar"><label><input type="checkbox" id="label-split-select-all">전체 선택</label><span>출력 묶음 선택</span><div id="label-split-batches"></div></div><div class="label-split-table-wrap"><table class="label-split-table"><thead><tr><th>선택</th><th>바코드</th><th>출력일시</th><th>중량</th></tr></thead><tbody id="label-split-labels"></tbody></table></div><div class="label-split-summary" aria-live="polite"><article><h3>분리할 생산품</h3><strong id="label-split-selected-weight">0.00 KG</strong><span id="label-split-selected-boxes">0 박스</span></article><article><h3>남는 생산품</h3><strong id="label-split-remaining-weight">0.00 KG</strong><span id="label-split-remaining-boxes">0 박스</span></article></div><p id="label-split-hint"></p><p id="label-split-message" role="status" aria-live="polite"></p></section><footer class="label-split-footer"><button type="button" class="btn btn-secondary" id="label-split-refresh">최신 라벨 불러오기</button><button type="button" class="btn btn-secondary" id="label-split-close">닫기</button><button type="button" class="btn btn-primary" id="label-split-save">분할 저장</button></footer></div>`;
  document.body.append(dialog);
  el('labels').addEventListener('change',event=>{const input=event.target.closest('input[data-label-id]');if(!input || input.disabled)return;input.checked?state.selected.add(input.dataset.labelId):state.selected.delete(input.dataset.labelId);state.attempt=null;syncControls();});
  el('labels').addEventListener('click',event=>{if(event.target.closest('input'))return;const input=event.target.closest('tr')?.querySelector('input');if(input && !input.disabled){input.click();}});
  el('select-all').addEventListener('change',event=>{if(event.target.disabled)return;state.selected=event.target.checked?new Set(labels().map(row=>row.id)):new Set();state.attempt=null;syncControls();});
  el('batches').addEventListener('click',event=>{const button=event.target.closest('button[data-batch-id]');if(!button || button.disabled)return;const rows=batches().get(button.dataset.batchId)||[],all=rows.every(row=>state.selected.has(row.id));rows.forEach(row=>all?state.selected.delete(row.id):state.selected.add(row.id));state.attempt=null;syncControls();});
  el('save').addEventListener('click',save);el('refresh').addEventListener('click',refresh);el('close').addEventListener('click',()=>close());el('dismiss').addEventListener('click',()=>close());
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  document.addEventListener('click',event=>{const button=event.target.closest('.label-split-open');if(button && !button.disabled)open(button.dataset.productionId,button.dataset.stockRowId);});
  window.addEventListener('focus',applyPermissions);
  window.DBMTLabelStockSplit={open,close,save,refresh,applyPermissions,buttonHtml};
})();
