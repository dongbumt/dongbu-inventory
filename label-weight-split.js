/* Issued stock-label repacking. Production records and the ordinary print counter stay unchanged. */
(function(global){
  'use strict';
  const el=id=>document.getElementById('lws-'+id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const kg=v=>Number(v||0).toFixed(2),pendingPrefix='dbmt_label_weight_pending_';
  const s={epoch:0,queryId:0,busy:false,saving:false,printing:false,rows:[],count:0,offset:0,selected:null,pending:null,last:null,history:[],identity:'',storageKey:'',opener:null};
  let options=null;
  const auth=()=>options?options.auth():{p_pin:null,p_token:global.DBMTAuth?.getSessionToken()||''};
  const authKey=()=>JSON.stringify(auth());
  const readable=()=>options?Boolean(auth().p_pin):Boolean(global.DBMTAuth?.isPersonal()&&DBMTAuth.can('label','view'));
  const writable=()=>options?Boolean(auth().p_pin):Boolean(readable()&&DBMTAuth.can('label','create')&&DBMTAuth.can('label','update'));
  function message(value='',error=false){el('message').textContent=value;el('message').classList.toggle('error',error);}
  function current(epoch,key){return s.epoch===epoch&&authKey()===key&&el('dialog').open&&readable();}
  async function request(name,params){let timer;try{return await Promise.race([sbRpc(name,params),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('서버 응답 시간이 초과됐습니다.')),45000);})]);}finally{clearTimeout(timer);}}
  function cents(value){const t=String(value);if(!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(t))return null;const [a,b='']=t.split('.');const n=Number(a||'0')*100+Number(b.padEnd(2,'0'));return Number.isSafeInteger(n)&&n>0?n:null;}
  function weights(){return [...el('weights').querySelectorAll('input')].map(input=>cents(input.value));}
  function sync(){
    const locked=s.busy||s.saving||s.printing||!!s.pending;
    for(const input of el('dialog').querySelectorAll('#lws-search input,#lws-search select,#lws-weights input,#lws-weights button'))input.disabled=locked;
    el('search-button').disabled=locked;el('add').disabled=locked||weights().length>=50;el('back').disabled=locked;
    const values=weights(),total=values.reduce((sum,n)=>sum+(n||0),0),target=s.selected?Math.round(Number(s.selected.weight)*100):0;
    for(const button of el('weights').querySelectorAll('[data-remove]'))button.disabled=locked||values.length<=2;
    el('totals').textContent=`합계 ${kg(total/100)} KG / 원본 ${kg(target/100)} KG · 차이 ${kg((target-total)/100)} KG`;
    el('totals').classList.toggle('error',total!==target);
    el('save').disabled=!writable()||s.busy||s.saving||s.printing||(!s.pending&&(!s.selected||values.length<2||values.some(n=>n===null)||total!==target));
    el('save').textContent=s.saving?'분할 저장 중':s.pending?'같은 요청 재시도':'분할 저장';
    el('close').disabled=s.saving||s.printing;el('history-button').disabled=locked;
    el('prev').disabled=locked||s.offset===0;el('next').disabled=locked||s.offset+50>=s.count;
    for(const button of el('rows').querySelectorAll('button'))button.disabled=locked;
    for(const button of el('dialog').querySelectorAll('[data-print]'))button.disabled=s.printing||s.saving||!writable()||button.dataset.empty==='true';
  }
  function weightRow(value=''){
    const row=document.createElement('div');row.className='lws-weight-row';row.innerHTML=`<label>중량(KG)<input type="number" inputmode="decimal" min="0.01" step="0.01" value="${esc(value)}" aria-label="분할 중량(KG)"></label><button type="button" data-remove title="분할 중량 삭제" aria-label="분할 중량 삭제">×</button>`;
    el('weights').appendChild(row);return row.querySelector('input');
  }
  function select(row,values=['','']){
    s.selected=row;s.last=null;el('results').hidden=true;el('history').hidden=true;el('editor').hidden=false;el('saved').hidden=true;
    el('selected').innerHTML=`<strong>${esc(row.product)} · ${kg(row.weight)} KG</strong><code>${esc(row.printCode||DBMTLabelLayout.encodePrintCode(row.code))}</code><p>이력번호 ${esc(row.lot)} · 생산일 ${esc(row.mfgdate)} · 소비기한 ${esc(row.expdate)} · ${esc(row.location)}</p>`;
    el('weights').replaceChildren();values.forEach(weightRow);message('');sync();el('weights').querySelector('input')?.focus();
  }
  async function search(offset=0){
    if(s.saving||s.printing||s.pending||!readable())return;
    const query=el('query').value.trim();if(!query){message('바코드 끝 6자리 이상 또는 전체 제품 바코드를 입력해주세요.',true);return;}
    const epoch=s.epoch,key=authKey(),queryRequest=++s.queryId;s.busy=true;s.offset=offset;message('재고 라벨 조회 중');sync();
    try{
      const data=await request('dbmt_label_weight_search',{...auth(),p_query:query,p_location:el('location').value,p_product:el('product').value.trim(),p_offset:offset});
      if(!current(epoch,key)||queryRequest!==s.queryId)return;
      if(!data?.ok||!Array.isArray(data.rows))throw Error(data?.message||'조회 결과를 확인할 수 없습니다.');
      s.rows=data.rows;s.count=data.count;el('results').hidden=false;el('history').hidden=true;el('editor').hidden=true;el('saved').hidden=true;
      el('rows').innerHTML=data.rows.map((row,index)=>`<tr><td><button type="button" data-select="${index}">선택</button></td><td><strong>${esc(row.product)}</strong><small>이력번호 ${esc(row.lot)}</small><code>${esc(row.printCode)}</code></td><td>${kg(row.weight)} KG</td><td>${esc(row.mfgdate)}<small>소비기한 ${esc(row.expdate)}</small></td></tr>`).join('')||'<tr><td colspan="4">조회된 재고 라벨이 없습니다.</td></tr>';
      el('count').textContent=`${s.count}건 · ${s.count?offset+1:0}~${Math.min(offset+50,s.count)}`;message('');
    }catch(error){if(current(epoch,key))message(error.message||String(error),true);}
    finally{if(current(epoch,key)&&queryRequest===s.queryId){s.busy=false;sync();el('rows').querySelector('button')?.focus();}}
  }
  function applyPosting(row){
    if(options||typeof userTransactions==='undefined'||!row||userTransactions.some(t=>t.id===row.id))return;
    userTransactions.push(row);transactions=[...EXCEL_TRANSACTIONS,...userTransactions];markLocalCoreChanged();
    safeLocalStorageSet('dbmt_user_transactions',JSON.stringify(userTransactions),true);
  }
  function saved(result){
    s.pending=null;s.last=result;s.selected=null;try{sessionStorage.removeItem(s.storageKey);}catch(_){}
    el('editor').hidden=true;el('saved').hidden=false;el('saved-title').textContent=`${kg(result.weight)} KG → ${result.labels.length}박스`;
    el('saved-list').innerHTML=result.labels.map(log=>`<li>${kg(log.labelWeight)} KG · <code>${esc(DBMTLabelLayout.encodePrintCode(log.code))}</code></li>`).join('');
    message('분할 저장 완료 · 원본 바코드 사용 중지');
    try{applyPosting(result.transaction);}catch(_){message('분할은 저장됐습니다. ERP 거래·재고 새로고침으로 최신 내역을 확인해주세요.');}
  }
  async function save(){
    if(s.busy||s.saving||s.printing||!writable())return;sync();if(el('save').disabled)return;
    if(!s.pending){
      const values=weights().map(n=>n/100),item=s.selected;
      if(!confirm(`${item.product}\n${DBMTLabelLayout.encodePrintCode(item.code)}\n${kg(item.weight)} KG → ${values.map(kg).join(' + ')} KG\n원본 바코드는 사용 중지됩니다. 분할할까요?`))return;
      const body={p_request_id:crypto.randomUUID(),p_code:item.code,p_revision:item.revision,p_location:el('location').value,p_weights:values};
      try{sessionStorage.setItem(s.storageKey,JSON.stringify({body,item}));s.pending=body;}catch(_){message('임시 저장을 사용할 수 없어 분할하지 않았습니다.',true);return;}
    }
    const epoch=s.epoch,key=authKey();s.saving=true;sync();message('분할 저장 중');
    try{
      const result=await request('dbmt_label_weight_split',{...auth(),...s.pending});
      if(!current(epoch,key))return;
      if(!result?.ok||result.requestId!==s.pending.p_request_id||!Array.isArray(result.labels))throw Error('저장 응답을 확인할 수 없습니다. 같은 요청으로 재시도해주세요.');
      saved(result);
    }catch(error){if(current(epoch,key)){
      if(error.code==='P0001'||error.code==='22023'){
        s.pending=null;s.selected=null;try{sessionStorage.removeItem(s.storageKey);}catch(_){}
        el('editor').hidden=true;el('results').hidden=true;message(`${error.message}\n재고 라벨을 다시 조회해주세요.`,true);
      }else message(`${error.message||error}\n저장 결과가 불명확하면 같은 요청 재시도로 확인해주세요.`,true);
    }}
    finally{if(current(epoch,key)){s.saving=false;sync();}}
  }
  function body(log){
    if(typeof labelDataFromLog==='function')return buildLabelBody(labelDataFromLog(log));
    const row=log.workOrderSnapshot||{},defaults=typeof LBL_DEFAULTS==='object'?LBL_DEFAULTS:{};
    return buildLabelBody({...defaults,...row,productBarcode:DBMTLabelLayout.encodePrintCode(log.code),
      weight:kg(log.labelWeight),mfgdate:String(row.mfgdate||'').replaceAll('-','.'),expdate:String(row.expdate||'').replaceAll('-','.'),
      lotText:row.lot||log.lot||'',ingredients:row.ingredients||`${inferLabelMeatType(row.product,'')} 100%`});
  }
  async function print(id){
    if(s.printing||s.saving||!writable())return;
    const epoch=s.epoch,key=authKey();s.printing=true;sync();
    try{
      const data=await request('dbmt_label_weight_history',{...auth(),p_request_id:id});if(!current(epoch,key))return;
      const logs=data.rows?.[0]?.labels||[];if(!logs.length)throw Error('현재 재고로 남아 있는 분할 라벨이 없습니다. 다시 조회해주세요.');
      if(logs.some(log=>!['7x10','10x10'].includes(log.sizeKey||log.workOrderSnapshot?.labelSize||'7x10')))throw Error('라벨 출력 크기를 확인해주세요.');
      for(const sizeKey of ['7x10','10x10']){
        const group=logs.filter(log=>(log.sizeKey||log.workOrderSnapshot?.labelSize||'7x10')===sizeKey);
        if(group.length)await DBMTLabelPrint.printHidden({labelsHtml:group.map(log=>`<section class="print-label">${body(log)}</section>`).join(''),sizeKey});
      }
      message(`${logs.length}장 인쇄 요청 · 실제 출력 여부를 확인해주세요.`);
    }catch(error){if(current(epoch,key))message(error.message||String(error),true);}
    finally{if(current(epoch,key)){s.printing=false;sync();}}
  }
  async function history(){
    if(s.busy||s.saving||s.pending||s.printing||!readable())return;
    const epoch=s.epoch,key=authKey();s.busy=true;sync();message('분할이력 조회 중');
    try{
      const data=await request('dbmt_label_weight_history',{...auth(),p_request_id:null});if(!current(epoch,key))return;
      el('results').hidden=true;el('editor').hidden=true;el('saved').hidden=true;el('history').hidden=false;
      el('history').innerHTML=(data.rows||[]).map(row=>`<details class="lws-history-row"><summary>${esc(new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(row.created_at)))} · ${kg(row.result.weight)} KG · 재고 ${row.labels.length}장</summary><code>${esc(DBMTLabelLayout.encodePrintCode(row.result.parentCode))}</code><ul>${row.labels.map(log=>`<li>${esc(log.product||log.workOrderSnapshot?.product)} · ${kg(log.labelWeight)} KG · ${esc(DBMTLabelLayout.encodePrintCode(log.code))}</li>`).join('')}</ul><button type="button" data-print="${esc(row.id)}" data-empty="${!row.labels.length}" ${row.labels.length?'':'disabled'}>재고 라벨 인쇄</button></details>`).join('')||'분할이력이 없습니다.';message('');
    }catch(error){if(current(epoch,key))message(error.message||String(error),true);}
    finally{if(current(epoch,key)){s.busy=false;sync();}}
  }
  function applyPermissions(){
    const launcher=document.getElementById('label-weight-open');if(launcher)launcher.disabled=!readable();
    if(el('dialog').open&&s.identity!==authKey()){
      s.epoch++;s.busy=false;s.saving=false;s.printing=false;s.selected=null;s.last=null;s.rows=[];
      el('dialog').close();for(const id of ['rows','history','selected','saved-list','weights'])el(id).replaceChildren();
    }
    if(el('dialog').open)sync();
  }
  async function open(){
    if(!readable()){alert('라벨 화면에 먼저 로그인·연결해주세요.');return;}
    if(el('dialog').open)return;s.epoch++;s.queryId++;s.identity=authKey();s.opener=document.activeElement;s.busy=true;s.saving=false;s.printing=false;s.pending=null;s.selected=null;s.last=null;
    s.storageKey=pendingPrefix+(options?'pin':DBMTAuth.auditIdentity().userId);
    el('dialog').showModal();for(const id of ['results','editor','saved','history'])el(id).hidden=true;el('weights').replaceChildren();message('');sync();
    const epoch=s.epoch,key=authKey();
    try{
      const data=await request('dbmt_label_weight_search',{...auth(),p_query:'',p_location:'가공장',p_product:'',p_offset:0});if(!current(epoch,key))return;
      el('location').innerHTML=(data.locations||[]).map(name=>`<option>${esc(name)}</option>`).join('');el('location').value='가공장';
      const pending=JSON.parse(sessionStorage.getItem(s.storageKey)||'null');
      if(pending){select(pending.item,pending.body.p_weights);s.pending=pending.body;el('location').value=pending.body.p_location;message('이전 분할의 저장 결과를 같은 요청 재시도로 확인해주세요.',true);}
    }catch(error){if(current(epoch,key))message(error.message||String(error),true);}
    finally{if(current(epoch,key)){s.busy=false;sync();if(!s.pending)el('query').focus();}}
  }
  const dialog=document.createElement('dialog');dialog.id='lws-dialog';dialog.setAttribute('aria-labelledby','lws-title');dialog.innerHTML=`
    <div class="lws-head"><h2 id="lws-title">라벨 중량분할</h2><div><button id="lws-history-button" type="button">분할이력</button><button id="lws-close" type="button" aria-label="중량분할 닫기" title="닫기">×</button></div></div>
    <form id="lws-search" class="lws-search"><label>재고 지점<select id="lws-location"><option>가공장</option></select></label><label>바코드 끝자리 / 전체번호<input id="lws-query" type="search" autocomplete="off" maxlength="100" placeholder="끝 6자리 이상"></label><label>제품명<input id="lws-product" type="search" autocomplete="off"></label><button id="lws-search-button" type="submit">조회</button></form>
    <div id="lws-message" class="lws-message" role="status" aria-live="polite"></div>
    <section id="lws-results" hidden><div class="lws-table-wrap"><table class="lws-table"><thead><tr><th>선택</th><th>제품 · 이력번호 · 바코드</th><th>중량</th><th>생산일</th></tr></thead><tbody id="lws-rows"></tbody></table></div><div class="lws-pager"><span id="lws-count"></span><div><button id="lws-prev" type="button" aria-label="이전 검색결과" title="이전">←</button><button id="lws-next" type="button" aria-label="다음 검색결과" title="다음">→</button></div></div></section>
    <section id="lws-editor" hidden><div id="lws-selected" class="lws-selected"></div><div id="lws-weights" class="lws-weights"></div><div id="lws-totals" class="lws-totals"></div><div class="lws-actions"><div><button id="lws-add" type="button" title="분할 중량 추가">+ 중량 추가</button><button id="lws-back" type="button">선택 해제</button></div><button id="lws-save" class="primary" type="button">분할 저장</button></div></section>
    <section id="lws-saved" hidden><h3 id="lws-saved-title"></h3><ul id="lws-saved-list" class="lws-result-list"></ul><button id="lws-print" type="button" class="primary" data-print="">분할 라벨 인쇄</button></section><section id="lws-history" hidden></section>`;
  document.body.appendChild(dialog);
  el('search').addEventListener('submit',event=>{event.preventDefault();search();});
  for(const [id,event] of [['query','input'],['product','input'],['location','change']])el(id).addEventListener(event,()=>{
    if(s.saving||s.pending||s.printing)return;s.queryId++;s.selected=null;
    for(const name of ['results','editor','saved','history'])el(name).hidden=true;message('');sync();
  });
  el('rows').addEventListener('click',event=>{const button=event.target.closest('[data-select]');if(button&&!button.disabled)select(s.rows[Number(button.dataset.select)]);});
  el('weights').addEventListener('input',sync);el('weights').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();const inputs=[...el('weights').querySelectorAll('input')],next=inputs[inputs.indexOf(event.target)+1];if(next)next.focus();else el('save').focus();}});
  el('weights').addEventListener('click',event=>{const button=event.target.closest('[data-remove]');if(button&&!button.disabled&&weights().length>2){button.closest('.lws-weight-row').remove();sync();}});
  el('add').addEventListener('click',()=>{if(!el('add').disabled){weightRow().focus();sync();}});
  el('back').addEventListener('click',()=>{s.selected=null;el('editor').hidden=true;el('results').hidden=false;message('');});
  el('save').addEventListener('click',save);el('history-button').addEventListener('click',history);
  el('prev').addEventListener('click',()=>search(Math.max(0,s.offset-50)));el('next').addEventListener('click',()=>search(s.offset+50));
  el('dialog').addEventListener('click',event=>{const button=event.target.closest('[data-print]');if(button&&!button.disabled)print(button.dataset.print||s.last?.requestId);});
  el('close').addEventListener('click',()=>{if(!s.saving&&!s.printing)el('dialog').close();});
  el('dialog').addEventListener('cancel',event=>{if(s.saving||s.printing)event.preventDefault();});
  el('dialog').addEventListener('close',()=>{s.epoch++;s.busy=false;s.opener?.isConnected&&s.opener.focus();});
  global.DBMTLabelWeightSplit={open,applyPermissions,configure(value){options=value;applyPermissions();}};
  document.getElementById('label-weight-open')?.addEventListener('click',open);applyPermissions();
})(window);
