(function(){
  'use strict';
  const API='https://hdwjwtmbsxfjrlvicgnn.supabase.co/rest/v1/rpc/';
  const KEY='sb_publishable_40Sg1P9a5KKA-2pXtzXJZA_qSXDqPZg';
  const SESSION='dbmt_pda_session_token',PENDING='dbmt_pda_pending_batch';
  const $=id=>document.getElementById(id);
  const state={token:'',user:null,mode:'inbound',items:[],partners:[],canSave:false,scans:[],scanning:false,saving:false,pending:null};
  const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const kg=value=>Number(value||0).toFixed(2);
  const today=()=>{const parts=Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));return `${parts.year}-${parts.month}-${parts.day}`;};
  const action=item=>state.mode==='outbound'?'출고':item.state==='shipped'?'반입':'생산입고 확인';
  const storage={get(key){try{return sessionStorage.getItem(key)||'';}catch(_){return '';}},set(key,value){try{sessionStorage.setItem(key,value);}catch(_){throw Error('임시 저장을 사용할 수 없습니다. 브라우저 저장 권한을 확인해주세요.');}},remove(key){try{sessionStorage.removeItem(key);}catch(_){}}};
  function status(message,kind=''){ $('status').textContent=message;$('status').className=kind; }
  function uuid(){const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const s=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');return s.slice(0,8)+'-'+s.slice(8,12)+'-'+s.slice(12,16)+'-'+s.slice(16,20)+'-'+s.slice(20);}
  async function rpc(name,params={}){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try{
      const response=await fetch(API+name,{method:'POST',headers:{apikey:KEY,'Content-Type':'application/json'},body:JSON.stringify(params),signal:controller.signal});
      let data;try{data=await response.json();}catch(_){throw Error('서버 응답을 확인할 수 없습니다.');}
      if(!response.ok||data?.ok===false){
        const error=Error(data.message||'요청을 처리하지 못했습니다.');
        error.code=data.code;
        error.definite=Boolean(data.code&&(/^[0-9A-Z]{5}$/.test(data.code)||data.code.startsWith('PGRST')))||data.ok===false;
        error.session=data.code==='28000'||data.code==='session_expired';throw error;
      }
      return data;
    }catch(error){if(error.name==='AbortError')throw Error('응답 시간이 초과되었습니다.');throw error;}
    finally{clearTimeout(timer);}
  }
  function focusScan(){if(!state.pending&&!state.saving&&!$('workspace').hidden)$('barcode').focus({preventScroll:true});}
  function pendingStore(){const key=PENDING+'_'+state.user.id;if(state.pending)storage.set(key,JSON.stringify({userId:state.user.id,body:state.pending,items:state.items}));else storage.remove(key);}
  function renderPartners(){
    const selected=$('partner').value,query=$('partner-search').value.trim().toLocaleLowerCase();
    $('partner').innerHTML='<option value="">거래처 선택</option>'+state.partners.filter(p=>!query||p.name.toLocaleLowerCase().includes(query)||p.id===selected).map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    $('partner').value=selected;
  }
  function render(){
    const locked=state.saving||Boolean(state.pending),busy=locked||state.scanning||state.scans.length>0;
    $('items').innerHTML=state.items.map((item,index)=>`<li><div class="scan-product">${esc(item.product)}</div><strong class="scan-weight">${kg(item.weight)} KG</strong><div class="scan-meta"><span class="scan-action">${action(item)}</span> · ${esc(item.origin)} · ${esc(item.storage)}<br>LOT ${esc(item.lot)} · 소비기한 ${esc(item.expdate)}</div><div class="scan-code">${esc(item.code)}</div><button class="scan-remove" type="button" data-remove="${index}" aria-label="${esc(item.product)} 목록에서 제외" title="목록에서 제외" ${busy?'disabled':''}>×</button></li>`).join('');
    $('item-count').textContent=state.items.length;
    $('total').textContent=`${state.items.length}개 · ${kg(state.items.reduce((sum,item)=>sum+Number(item.weight),0))} KG`;
    $('save-detail').textContent=state.pending?'저장 응답 확인 필요':state.scanning?'바코드 조회 중':'';
    $('save').textContent=state.saving?'저장 확인 중':state.pending?'같은 요청 재시도':state.mode==='outbound'?'출고 확인':'입고 확인';
    $('save').disabled=!state.canSave||busy&&!state.pending||state.saving||!state.items.length||!navigator.onLine;
    for(const el of document.querySelectorAll('.settings input,.settings select,.mode-tabs input,#note,#manual-entry,#scan-submit,#barcode'))el.disabled=locked;
    $('clear-items').disabled=busy||!state.items.length;$('refresh-items').disabled=busy||!state.items.length;$('logout').disabled=state.saving;
    $('partner-fields').hidden=state.mode!=='outbound';
    $('settings-summary').textContent=[$('work-date').value,$('location').value,state.mode==='outbound'?$('partner').selectedOptions[0]?.textContent:''].filter(Boolean).join(' · ');
    document.querySelector(`input[name="mode"][value="${state.mode}"]`).checked=true;
  }
  async function openWorkspace(session){
    state.user=session.user;state.token=storage.get(SESSION);
    const data=await rpc('dbmt_pda_bootstrap',{p_token:state.token});
    state.canSave=data.canSave===true;state.partners=data.partners||[];
    $('location').innerHTML=(data.locations||[]).map(name=>`<option>${esc(name)}</option>`).join('');$('location').value='가공장';renderPartners();
    $('work-date').value=today();$('work-date').max=today();
    $('login-form').hidden=true;$('workspace').hidden=false;$('save-bar').hidden=false;$('history-open').hidden=false;$('logout').hidden=false;
    $('user-name').textContent=state.user.displayName||state.user.loginId;
    try{
      const saved=JSON.parse(storage.get(PENDING+'_'+state.user.id)||'null');
      if(saved?.userId===state.user.id&&saved.body&&Array.isArray(saved.items)){
        state.pending=saved.body;state.items=saved.items;state.mode=saved.body.p_mode;
        $('location').value=saved.body.p_location;$('work-date').value=saved.body.p_date;$('partner').value=saved.body.p_trader_id||'';$('note').value=saved.body.p_note||'';
        $('settings-panel').open=false;
        status('이전 저장의 응답을 확인하지 못했습니다. 같은 요청 재시도로 처리 결과를 확인해주세요.','error');
      }else status(state.canSave?'':'PDA 입출고 등록 권한이 없어 조회만 가능합니다.',state.canSave?'':'error');
    }catch(_){status('이전 임시 저장 정보를 확인할 수 없습니다. 사무실에서 최근 처리이력을 확인해주세요.','error');state.canSave=false;}
    render();focusScan();
  }
  $('login-form').addEventListener('submit',async event=>{
    event.preventDefault();$('login-submit').disabled=true;
    try{
      const session=await rpc('dbmt_erp_login',{p_login_id:$('login-id').value.trim(),p_login_password:$('login-password').value});
      if(!session.token||!session.user)throw Error('로그인 응답을 확인할 수 없습니다.');
      storage.set(SESSION,session.token);$('login-password').value='';await openWorkspace(session);
    }catch(error){status(error.message,'error');}finally{$('login-submit').disabled=false;}
  });
  $('logout').addEventListener('click',async()=>{
    if(state.pending&&!confirm('저장 응답 확인이 필요한 요청이 남아 있습니다. 같은 계정으로 로그인하면 다시 확인할 수 있습니다. 로그아웃할까요?'))return;
    if(!state.pending&&state.items.length&&!confirm('저장하지 않은 스캔 목록을 비우고 로그아웃할까요?'))return;
    try{await rpc('dbmt_erp_logout',{p_token:state.token});}catch(_){}
    storage.remove(SESSION);state.token='';state.user=null;state.items=[];state.pending=null;state.scans=[];
    $('workspace').hidden=true;$('save-bar').hidden=true;$('login-form').hidden=false;$('history-open').hidden=true;$('logout').hidden=true;$('user-name').textContent='';status('');$('login-id').focus();
  });
  for(const radio of document.querySelectorAll('[name="mode"]'))radio.addEventListener('change',event=>{
    if(state.scanning||state.scans.length||state.items.length&&!confirm('스캔 목록을 비우고 작업구분을 바꿀까요?')){render();return;}
    state.mode=event.target.value;state.items=[];$('settings-panel').open=true;status('');render();focusScan();
  });
  $('partner-search').addEventListener('input',renderPartners);
  for(const id of ['work-date','location','partner'])$(id).addEventListener('change',render);
  $('manual-entry').addEventListener('change',()=>{$('barcode').inputMode=$('manual-entry').checked?'text':'none';focusScan();});
  async function scanLoop(){
    if(state.scanning)return;state.scanning=true;render();
    while(state.scans.length){
      const code=state.scans.shift();
      try{
        const result=await rpc('dbmt_pda_lookup',{p_token:state.token,p_code:code});const item=result.item;
        if(state.items.some(row=>row.labelId===item.labelId))throw Error('이미 목록에 있는 라벨입니다.');
        if(state.items.length>=200)throw Error('200개까지 처리할 수 있습니다. 먼저 저장해주세요.');
        if(state.mode==='outbound'&&item.state==='shipped')throw Error('이미 출고된 라벨입니다.');
        if(state.mode==='inbound'&&item.registered&&item.state==='in_stock')throw Error('이미 입고 확인된 라벨입니다. 중복 입고하지 않습니다.');
        if(item.state==='in_stock'&&item.location!==$('location').value)throw Error(`현재 재고 지점은 ${item.location}입니다.`);
        state.items.push(item);$('settings-panel').open=false;status(`${item.product} · ${kg(item.weight)} KG · ${action(item)}`,'ok');
        window.DBMTPdaSound?.play('success');
      }catch(error){status(error.message,'error');window.DBMTPdaSound?.play('error');try{navigator.vibrate?.([80,40,80]);}catch(_){} }
      render();
    }
    state.scanning=false;render();
  }
  function enqueue(code){
    if(state.pending||state.saving)return;
    code=String(code||'').trim();if(!code){status('제품 고유바코드를 읽어주세요.','error');window.DBMTPdaSound?.play('error');return;}
    if(!navigator.onLine){status('인터넷 연결이 없어 바코드를 확인하지 못했습니다. 연결 후 다시 읽어주세요.','error');window.DBMTPdaSound?.play('error');return;}
    $('barcode').value='';state.scans.push(code);focusScan();scanLoop();
  }
  $('scan-form').addEventListener('submit',event=>{event.preventDefault();enqueue($('barcode').value);});
  $('barcode').addEventListener('paste',event=>{const code=event.clipboardData?.getData('text');if(code){event.preventDefault();enqueue(code);}});
  $('items').addEventListener('click',event=>{const button=event.target.closest('[data-remove]');if(button&&!button.disabled){state.items.splice(Number(button.dataset.remove),1);render();focusScan();}});
  $('clear-items').addEventListener('click',()=>{if(confirm('스캔 목록을 비울까요?')){state.items=[];status('');render();focusScan();}});
  $('refresh-items').addEventListener('click',async()=>{
    state.scanning=true;render();
    try{const refreshed=[];for(const item of state.items)refreshed.push((await rpc('dbmt_pda_lookup',{p_token:state.token,p_code:item.code})).item);state.items=refreshed;status('현재 처리 상태를 다시 조회했습니다.','ok');}
    catch(error){status(error.message,'error');}finally{state.scanning=false;render();focusScan();}
  });
  $('save').addEventListener('click',()=>{
    if(state.pending){savePending();return;}
    if(state.mode==='outbound'&&!$('partner').value){status('출고 거래처를 선택해주세요.','error');$('partner').focus();return;}
    if(!$('work-date').value){status('작업일을 선택해주세요.','error');return;}
    $('confirm-title').textContent=state.mode==='outbound'?'출고 확정':'입고·반입 확정';
    const received=state.items.filter(item=>action(item)==='생산입고 확인').length,returned=state.items.filter(item=>action(item)==='반입').length;
    $('confirm-summary').textContent=`${$('work-date').value} · ${$('location').value}\n${$('total').textContent}`+(state.mode==='outbound'?`\n${$('partner').selectedOptions[0]?.textContent||''}`:`\n생산입고 확인 ${received}개 · 반입 ${returned}개`);
    $('confirm-items').innerHTML=state.items.map(item=>`<li>${esc(item.product)} · ${kg(item.weight)} KG · ${action(item)}<br>${esc(item.code)}</li>`).join('');
    $('confirm-dialog').showModal();
  });
  $('confirm-cancel').addEventListener('click',()=>{$('confirm-dialog').close();focusScan();});
  $('confirm-save').addEventListener('click',()=>{
    if(state.saving||state.pending)return;
    $('confirm-dialog').close();
    state.pending={p_request_id:uuid(),p_mode:state.mode,p_location:$('location').value,p_trader_id:state.mode==='outbound'?$('partner').value:null,
      p_date:$('work-date').value,p_items:state.items.map(item=>({barcode:item.code,revision:item.revision})),p_note:$('note').value};
    try{pendingStore();savePending();}catch(error){state.pending=null;status(error.message,'error');render();}
  });
  async function savePending(){
    if(state.saving||!state.pending)return;state.saving=true;render();
    try{
      pendingStore();const result=await rpc('dbmt_pda_commit',{p_token:state.token,...state.pending});
      state.pending=null;pendingStore();state.items=[];
      status(`저장 완료 · ${result.count}개 / ${kg(result.weight)} KG\n생산입고 확인 ${result.received}개 · 반입 ${result.returned}개 · 출고 ${result.shipped}개`,'ok');
    }catch(error){
      if(error.definite&&!error.session&&error.code!=='42501'){state.pending=null;pendingStore();status(`저장되지 않았습니다. ${error.message}`,'error');}
      else status(`${error.message}\n저장 여부가 불확실합니다. 같은 요청 재시도로 결과를 확인해주세요.`,'error');
    }finally{state.saving=false;render();focusScan();}
  }
  $('history-open').addEventListener('click',async()=>{
    $('history-list').textContent='조회 중';$('history-dialog').showModal();
    try{
      const data=await rpc('dbmt_pda_history',{p_token:state.token});
      $('history-list').innerHTML=data.rows.map(row=>`<details class="history-row"><summary>${esc(new Date(row.created_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))} · ${row.request.mode==='outbound'?'출고':'입고·반입'}<br>${esc(row.request.location)} · ${row.result.count}개 / ${kg(row.result.weight)} KG</summary><small>${esc(row.id)}<br>${esc(row.request.note)}</small><ul>${row.result.items.map(item=>`<li>${esc(item.product)} · ${kg(item.weight)} KG<br>${esc(item.code)} · ${item.action==='ship'?'출고':item.action==='return'?'반입':'생산입고 확인'}</li>`).join('')}</ul></details>`).join('')||'처리이력이 없습니다.';
    }catch(error){$('history-list').textContent=error.message;}
  });
  $('history-close').addEventListener('click',()=>{$('history-dialog').close();focusScan();});
  window.addEventListener('offline',()=>{status('인터넷 연결이 끊겼습니다. 목록은 유지되며 저장은 연결 후 가능합니다.','error');render();});
  window.addEventListener('online',()=>{status(state.pending?'연결되었습니다. 같은 요청 재시도로 저장 여부를 확인해주세요.':'인터넷이 연결되었습니다.','ok');render();});
  (async()=>{
    state.token=storage.get(SESSION);if(!state.token)return;
    try{const session=await rpc('dbmt_erp_session',{p_token:state.token});if(!session.user)throw Error('로그인이 만료되었습니다.');await openWorkspace(session);}
    catch(error){storage.remove(SESSION);status(error.message,'error');}
  })();
})();
