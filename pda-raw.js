(function(){
  'use strict';
  const API='https://hdwjwtmbsxfjrlvicgnn.supabase.co/rest/v1/rpc/';
  const KEY='sb_publishable_40Sg1P9a5KKA-2pXtzXJZA_qSXDqPZg';
  const SESSION='dbmt_pda_session_token',PENDING='dbmt_pda_raw_pending_batch_';
  const $=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const kg=value=>Number(value||0).toFixed(2);
  const state={token:'',user:null,epoch:0,mode:'inbound',products:[],partners:[],sources:[],items:[],queue:[],busy:false,saving:false,pending:null,canSave:false,sourceRequest:0};
  const storage={get(key){try{return sessionStorage.getItem(key)||'';}catch(_){return '';}},set(key,value){sessionStorage.setItem(key,value);},remove(key){try{sessionStorage.removeItem(key);}catch(_){}}};
  const today=()=>{const parts=Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));return `${parts.year}-${parts.month}-${parts.day}`;};
  function uuid(){const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const s=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');return s.slice(0,8)+'-'+s.slice(8,12)+'-'+s.slice(12,16)+'-'+s.slice(16,20)+'-'+s.slice(20);}
  function status(message,kind=''){ $('status').textContent=message;$('status').className=kind; }
  function sound(kind){window.DBMTPdaSound?.play(kind);}
  async function rpc(name,params){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try{
      const response=await fetch(API+name,{method:'POST',headers:{apikey:KEY,'Content-Type':'application/json'},body:JSON.stringify(params||{}),signal:controller.signal});
      const data=await response.json();
      if(!response.ok||data?.ok===false){const error=Error(data.message||'요청을 처리하지 못했습니다.');error.session=data.code==='28000';error.definite=Boolean(data.code&&(/^[0-9A-Z]{5}$/.test(data.code)||data.code.startsWith('PGRST')));throw error;}
      return data;
    }catch(error){if(error.name==='AbortError')throw Error('응답 시간이 초과되었습니다.');throw error;}
    finally{clearTimeout(timer);}
  }
  function focusScan(){if(!state.pending&&!state.saving&&!document.querySelector('dialog[open]')&&!$('workspace').hidden)$('barcode').focus({preventScroll:true});}
  function selectedProduct(){return state.products.find(p=>String(p.id)===$('product').value);}
  function renderProducts(){
    const selected=$('product').value,q=$('product-search').value.trim().toLowerCase();
    $('product').innerHTML='<option value="">품목 선택</option>'+state.products.filter(p=>String(p.id)===selected||!q||[p.name,p.productCode,p.brand,p.factoryNo,p.origin].join(' ').toLowerCase().includes(q)).map(p=>`<option value="${esc(p.id)}">${esc([p.productCode,p.name,p.brand,p.factoryNo,p.origin,p.storage,p.packunit].filter(Boolean).join(' · '))}</option>`).join('');
    $('product').value=selected;renderProductMeta();
  }
  function renderProductMeta(){const p=selectedProduct();$('product-meta').textContent=p?[p.name,p.brand||'브랜드 -',p.factoryNo||'공장번호 -',p.origin,p.storage,p.packunit].filter(Boolean).join(' · '):'';}
  function renderPartners(){
    const selected=$('partner').value,q=$('partner-search').value.trim().toLowerCase(),kind=state.mode==='outbound'?'매출':'매입';
    $('partner').innerHTML='<option value="">거래처 선택</option>'+state.partners.filter(p=>[kind,'매입/매출'].includes(p.tradeType)&&(!q||p.name.toLowerCase().includes(q)||p.id===selected)).map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');$('partner').value=selected;
  }
  async function loadSources(){
    const request=++state.sourceRequest,epoch=state.epoch;state.sources=[];$('source').innerHTML='<option value="">재고 선택</option>';
    if(!$('product').value||$('receive-kind').value!=='bind'||state.mode!=='inbound')return;
    try{
      const data=await rpc('dbmt_pda_raw_sources',{p_token:state.token,p_product_id:$('product').value,p_location:$('location').value});
      if(request!==state.sourceRequest||epoch!==state.epoch)return;
      state.sources=data.rows||[];$('source').innerHTML='<option value="">재고 선택</option>'+state.sources.map(row=>`<option value="${esc(row.id)}">${esc(row.date)} · LOT ${esc(row.lot)} · 미연결 ${kg(row.available)}KG</option>`).join('');
    }catch(error){if(epoch===state.epoch)status(error.message,'error');}
  }
  function render(){
    const locked=state.saving||!!state.pending,busy=locked||state.busy||state.queue.length>0;
    $('items').innerHTML=state.items.map((item,index)=>`<li><div class="scan-product">${esc(item.product)}</div><strong class="scan-weight">${kg(item.labelWeight)} KG</strong><div class="scan-meta">이력번호 ${esc(item.lot)} · ${esc(item.origin||'')}<br>${esc(item.rule)}${item.labelWeight!==item.calculatedWeight?` · 계산 ${kg(item.calculatedWeight)}KG / 라벨 대조`:''}</div><div class="scan-code">${esc(item.code.replaceAll(String.fromCharCode(29),'|'))}</div><button class="scan-remove" type="button" data-remove="${index}" aria-label="목록에서 제외" ${busy?'disabled':''}>×</button></li>`).join('');
    $('item-count').textContent=state.items.length;$('total').textContent=`${state.items.length}박스 · ${kg(state.items.reduce((sum,item)=>sum+item.labelWeight,0))} KG`;
    $('save-detail').textContent=state.pending?'저장 응답 확인 필요':state.busy?'바코드 조회 중':'';
    $('save').textContent=state.saving?'저장 확인 중':state.pending?'같은 요청 재시도':state.mode==='outbound'?'출고 확인':$('receive-kind').value==='bind'?'재고 연결 확인':'입고 확인';
    $('save').disabled=!state.canSave||state.saving||(!state.pending&&(busy||!state.items.length))||!navigator.onLine;
    for(const el of document.querySelectorAll('.settings input,.settings select,.mode-tabs input'))el.disabled=busy||state.items.length>0;
    for(const id of ['barcode','scan-submit','manual-entry','note'])$(id).disabled=locked;
    $('clear-items').disabled=busy||!state.items.length;$('logout').disabled=state.saving||state.busy;$('inbound-fields').hidden=state.mode!=='inbound';
    $('partner-fields').hidden=state.mode==='inbound'&&$('receive-kind').value==='bind';$('partner-label').textContent=state.mode==='outbound'?'출고 거래처':'입고 거래처';
    $('source-field').hidden=$('receive-kind').value!=='bind';$('price-field').hidden=$('receive-kind').value==='bind';
    document.querySelector(`input[name="mode"][value="${state.mode}"]`).checked=true;
    $('settings-summary').textContent=[$('work-date').value,$('location').value,state.mode==='outbound'?'원료육 출고':$('receive-kind').value==='bind'?'기존 재고 연결':'신규 원료육 입고'].filter(Boolean).join(' · ');
  }
  async function openWorkspace(session){
    const epoch=++state.epoch;state.user=session.user;state.token=storage.get(SESSION);
    const data=await rpc('dbmt_pda_raw_bootstrap',{p_token:state.token});if(epoch!==state.epoch)return;
    state.products=data.products||[];state.partners=data.partners||[];state.canSave=data.canSave===true;
    $('location').innerHTML=(data.locations||[]).map(name=>`<option>${esc(name)}</option>`).join('');$('location').value='가공장';
    $('rule').innerHTML='<option value="">GS1·사진 검증 국내산 자동</option>'+ (data.rules||[]).map(rule=>`<option value="${esc(rule.key)}">${rule.length}자리 · ${esc(rule.label)} [${esc(rule.key)}]</option>`).join('');
    renderProducts();renderPartners();$('work-date').value=today();$('work-date').max=today();
    $('user-name').textContent=state.user.displayName||state.user.loginId;$('login-form').hidden=true;$('workspace').hidden=false;$('save-bar').hidden=false;$('history-open').hidden=false;$('logout').hidden=false;
    const saved=storage.get(PENDING+state.user.id);
    if(saved){
      try{const pending=JSON.parse(saved);if(pending.userId!==state.user.id||!pending.body||!Array.isArray(pending.items))throw Error();
        state.pending=pending.body;state.items=pending.items;state.mode=pending.body.p_mode;
        $('location').value=pending.body.p_location;$('work-date').value=pending.body.p_date;$('receive-kind').value=pending.body.p_source_id?'bind':'new';
        $('product').value=pending.body.p_product_id||'';$('lot').value=pending.body.p_lot||'';$('unit-price').value=pending.body.p_price||0;$('note').value=pending.body.p_note||'';
        renderPartners();$('partner').value=pending.body.p_trader_id||'';renderProductMeta();status('이전 저장의 응답을 확인하지 못했습니다. 같은 요청 재시도로 결과를 확인해주세요.','error');
      }catch(_){state.canSave=false;status('임시 저장 정보를 확인할 수 없습니다. 사무실에서 처리이력을 확인해주세요.','error');}
    }else status(state.canSave?'':'PDA 등록 권한이 없어 조회만 가능합니다.',state.canSave?'':'error');
    render();focusScan();
  }
  $('login-form').addEventListener('submit',async event=>{
    event.preventDefault();$('login-submit').disabled=true;
    try{const session=await rpc('dbmt_erp_login',{p_login_id:$('login-id').value.trim(),p_login_password:$('login-password').value});if(!session.token||!session.user)throw Error('로그인 응답을 확인해주세요.');storage.set(SESSION,session.token);$('login-password').value='';await openWorkspace(session);}
    catch(error){status(error.message,'error');}finally{$('login-submit').disabled=false;}
  });
  $('logout').addEventListener('click',async()=>{
    if((state.pending||state.items.length)&&!confirm('저장 여부가 불명확한 요청은 같은 계정의 처리이력에서 확인해주세요. 로그아웃할까요?'))return;
    const token=state.token;state.epoch++;state.token='';state.user=null;state.items=[];state.queue=[];state.pending=null;
    storage.remove(SESSION);$('workspace').hidden=true;$('save-bar').hidden=true;$('login-form').hidden=false;$('history-open').hidden=true;$('logout').hidden=true;status('');
    rpc('dbmt_erp_logout',{p_token:token}).catch(()=>{});
  });
  for(const link of document.querySelectorAll('.pda-kind-mini a'))link.addEventListener('click',event=>{
    if(state.saving||state.busy||(state.items.length||state.pending)&&!confirm('스캔 목록을 남겨둔 채 화면을 이동할까요? 저장 응답 확인 중인 요청은 같은 계정으로 이 화면에서 재시도해주세요.'))event.preventDefault();
  });
  for(const radio of document.querySelectorAll('[name="mode"]'))radio.addEventListener('change',event=>{state.mode=event.target.value;renderPartners();render();focusScan();});
  $('product-search').addEventListener('input',renderProducts);$('partner-search').addEventListener('input',renderPartners);
  $('product').addEventListener('change',()=>{renderProductMeta();loadSources();});
  $('receive-kind').addEventListener('change',()=>{render();loadSources();});
  $('location').addEventListener('change',()=>{render();loadSources();});$('work-date').addEventListener('change',render);
  $('source').addEventListener('change',()=>{const src=state.sources.find(row=>row.id===$('source').value);if(src)$('lot').value=src.lot||'';});
  $('lot').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();focusScan();}});
  $('manual-entry').addEventListener('change',()=>{$('barcode').inputMode=$('manual-entry').checked?'text':'none';focusScan();});
  function confirmationWeights(){
    return state.items.map((item,index)=>{
      const input=$('confirm-items').querySelector(`[data-weight="${index}"]`),weight=input?Number(input.value):item.labelWeight;
      if(input&&(!Number.isFinite(weight)||weight<=0||weight>1000||Math.abs(weight*100-Math.round(weight*100))>.00001||Math.abs(weight-item.calculatedWeight)>.020001)){
        const error=Error(`${index+1}번째 박스 중량을 확인해주세요. 계산 ${kg(item.calculatedWeight)}KG과 차이가 0.02KG 이내여야 합니다.`);error.input=input;throw error;
      }
      return weight;
    });
  }
  function updateConfirmationSummary(){
    let total='중량 확인 필요';
    try{total=`${kg(confirmationWeights().reduce((sum,weight)=>sum+weight,0))} KG`;}catch(_){}
    $('confirm-summary').textContent=`${$('work-date').value} · ${$('location').value}\n${$('partner').selectedOptions[0]?.textContent||''}\n${state.items.length}박스 · ${total}`;
  }
  async function scanLoop(){
    if(state.busy)return;state.busy=true;const epoch=state.epoch;render();
    try{while(state.queue.length&&epoch===state.epoch){
      const code=state.queue.shift();
      try{
        const data=await rpc('dbmt_pda_raw_lookup',{p_token:state.token,p_code:code,p_rule:$('rule').value||null});if(epoch!==state.epoch)return;
        const item=data.item;if(state.items.some(row=>row.id===item.id))throw Error('이미 목록에 있는 박스입니다.');
        if(state.items.length>=200)throw Error('200박스까지 처리할 수 있습니다. 먼저 저장해주세요.');
        if(state.mode==='outbound'&&!item.registered)throw Error('원료육 입고 또는 기존 재고 연결을 먼저 해주세요.');
        if(state.mode==='outbound'&&item.state!=='in_stock')throw Error('이미 출고된 원료육 박스입니다.');
        if(state.mode==='inbound'&&item.registered)throw Error('이미 등록한 원료육 바코드입니다. 중복 입고하지 않습니다.');
        if(item.registered&&item.location!==$('location').value)throw Error(`현재 재고 지점은 ${item.location}입니다.`);
        if(item.ruleKey==='gs1'){
          const parsed=parseBarcode(item.code).parsedCodeItems,weights=parsed.filter(part=>/^(310|320)[0-5]$/.test(part.ai));
          if(weights.length!==1||Math.abs(Math.round(Number(weights[0].data)*(weights[0].ai.startsWith('320')?.45359237:1)*100)/100-item.calculatedWeight)>.001)throw Error('GS1 중량 판독 결과를 다시 확인해주세요.');
        }
        if(state.mode==='inbound'){
          if(!$('product').value&&item.productId){$('product-search').value='';renderProducts();$('product').value=item.productId;renderProductMeta();await loadSources();}
          const product=selectedProduct();if(!product)throw Error('입고할 원료육 품목을 먼저 선택해주세요.');
          if(item.productId&&String(item.productId)!==String(product.id))throw Error('GTIN에 연결된 품목과 선택한 품목이 다릅니다.');
          item.product=product.name;item.origin=product.origin;item.lot=$('lot').value.trim();
          if(!item.lot)throw Error('제품 바코드와 별도로 이력번호 바코드를 읽거나 이력번호를 입력해주세요.');
          if($('receive-kind').value==='bind'&&!$('source').value)throw Error('연결할 기존 입고 재고를 선택해주세요.');
        }
        item.labelWeight=Number(item.weight);
        if(epoch!==state.epoch)return;state.items.push(item);$('settings-panel').open=false;status(`${item.product} · 이력번호 ${item.lot} · ${kg(item.labelWeight)}KG`,'ok');sound('success');
      }catch(error){if(epoch===state.epoch){status(error.message,'error');sound('error');}}
    }}finally{state.busy=false;render();focusScan();}
  }
  function enqueue(value){
    if(state.pending||state.saving||document.querySelector('dialog[open]'))return;const code=String(value||'').trim();
    if(!code){status('원료육 박스 바코드를 읽어주세요.','error');sound('error');return;}
    if(!navigator.onLine){status('인터넷 연결 후 다시 읽어주세요.','error');sound('error');return;}
    $('barcode').value='';state.queue.push(code);scanLoop();
  }
  $('scan-form').addEventListener('submit',event=>{event.preventDefault();enqueue($('barcode').value);});
  $('barcode').addEventListener('paste',event=>{const code=event.clipboardData?.getData('text');if(code){event.preventDefault();enqueue(code);}});
  $('barcode').addEventListener('keydown',event=>{if(event.ctrlKey&&event.key===']'){event.preventDefault();$('barcode').setRangeText('|',$('barcode').selectionStart,$('barcode').selectionEnd,'end');}});
  $('items').addEventListener('click',event=>{const button=event.target.closest('[data-remove]');if(button&&!button.disabled){state.items.splice(Number(button.dataset.remove),1);render();focusScan();}});
  $('clear-items').addEventListener('click',()=>{if(confirm('저장하지 않은 스캔 목록을 비울까요?')){state.items=[];render();focusScan();}});
  $('save').addEventListener('click',()=>{
    if(state.pending){savePending();return;}if(!state.canSave||state.busy||!state.items.length)return;
    const bind=state.mode==='inbound'&&$('receive-kind').value==='bind';
    if(!bind&&!$('partner').value){status('거래처를 선택해주세요.','error');return;}
    if(!$('work-date').value){status('작업일을 선택해주세요.','error');return;}
    if(state.mode==='inbound'&&(!selectedProduct()||(bind&&!$('source').value))){status('입고 품목과 연결 재고를 선택해주세요.','error');return;}
    if(state.mode==='inbound'&&!$('lot').value.trim()){status('제품 바코드와 별도로 이력번호 바코드를 읽거나 이력번호를 입력해주세요.','error');return;}
    const price=Number($('unit-price').value);if(!Number.isFinite(price)||price<0||price>1000000000){status('입고 단가를 확인해주세요.','error');return;}
    $('confirm-title').textContent=state.mode==='outbound'?'원료육 출고 확정':bind?'기존 재고 연결 · 중량 증가 없음':'원료육 신규 입고 · 재고 증가';
    $('confirm-items').innerHTML=state.items.map((item,index)=>`<li><div>${esc(item.product)} · 이력번호 ${esc(item.lot)}</div><div class="scan-code">${esc(item.code.replaceAll(String.fromCharCode(29),'|'))}</div><div class="raw-confirm-line">${state.mode==='inbound'&&Number(item.conversion)!==1?`<label>라벨 중량(KG)<input type="number" data-weight="${index}" aria-label="${index+1}번째 박스 라벨 중량" min="0.01" max="1000" step="0.01" inputmode="decimal" value="${kg(item.labelWeight)}"></label><span>계산 ${kg(item.calculatedWeight)}KG<br>${esc(item.rule)}</span>`:`<strong>${kg(item.labelWeight)} KG</strong><span>${esc(item.rule)}</span>`}</div></li>`).join('');
    updateConfirmationSummary();$('confirm-error').hidden=true;
    $('confirm-checked').checked=false;$('confirm-save').disabled=true;$('confirm-dialog').showModal();
  });
  $('confirm-items').addEventListener('input',()=>{$('confirm-checked').checked=false;$('confirm-save').disabled=true;$('confirm-error').hidden=true;updateConfirmationSummary();});
  $('confirm-checked').addEventListener('change',()=>{$('confirm-save').disabled=!$('confirm-checked').checked;});
  $('confirm-cancel').addEventListener('click',()=>{$('confirm-dialog').close();focusScan();});
  $('confirm-dialog').addEventListener('close',focusScan);
  $('confirm-save').addEventListener('click',()=>{
    if(state.saving||state.pending||!$('confirm-checked').checked)return;
    let weights;
    try{weights=confirmationWeights();}
    catch(error){$('confirm-error').textContent=error.message;$('confirm-error').hidden=false;error.input?.focus();return;}
    state.items.forEach((item,index)=>{item.labelWeight=weights[index];});
    $('confirm-dialog').close();
    state.pending={p_token:state.token,p_request_id:uuid(),p_mode:state.mode,p_location:$('location').value,p_trader_id:$('partner').value||null,p_date:$('work-date').value,
      p_items:state.items.map(item=>({barcode:item.code,revision:item.revision,rule:item.ruleKey,labelWeight:item.labelWeight,checked:true})),
      p_product_id:state.mode==='inbound'?$('product').value:null,p_lot:state.mode==='inbound'?$('lot').value.trim():'',
      p_source_id:state.mode==='inbound'&&$('receive-kind').value==='bind'?$('source').value:null,p_price:Number($('unit-price').value)||0,p_note:$('note').value};
    try{const body={...state.pending};delete body.p_token;storage.set(PENDING+state.user.id,JSON.stringify({userId:state.user.id,body,items:state.items}));savePending();}
    catch(error){state.pending=null;status('임시 저장을 사용할 수 없어 저장하지 않았습니다. 브라우저 저장 권한을 확인해주세요.','error');render();}
  });
  async function savePending(){
    if(state.saving||!state.pending||!state.canSave)return;state.saving=true;render();
    try{
      const result=await rpc('dbmt_pda_raw_commit',{...state.pending,p_token:state.token});
      if(result.requestId!==state.pending.p_request_id||result.count!==state.items.length)throw Error('저장 응답을 확인할 수 없습니다.');
      storage.remove(PENDING+state.user.id);state.pending=null;state.items=[];$('settings-panel').open=true;status(`${result.count}박스 · ${kg(result.weight)}KG 처리 완료`,'ok');sound('success');await loadSources();
    }catch(error){
      if(error.definite&&!error.session){storage.remove(PENDING+state.user.id);state.pending=null;}
      status(`${error.message}${state.pending?'\n같은 요청 재시도로 결과를 확인해주세요.':''}`,'error');sound('error');
    }finally{state.saving=false;render();focusScan();}
  }
  $('history-open').addEventListener('click',async()=>{
    $('history-dialog').showModal();$('history-list').textContent='조회 중';
    try{const data=await rpc('dbmt_pda_raw_history',{p_token:state.token});$('history-list').innerHTML=(data.rows||[]).map(row=>`<details class="history-row"><summary>${esc(row.request.date)} · ${row.request.mode==='outbound'?'출고':row.request.sourceId?'기존 재고 연결':'입고'} · ${row.result.count}박스 · ${kg(row.result.weight)}KG</summary><small>${esc(row.id)} · ${esc(row.request.location)}</small><ul>${(row.result.items||[]).map(item=>`<li>${esc(item.product)} · LOT ${esc(item.lot)} · ${kg(item.weight)}KG</li>`).join('')}</ul></details>`).join('')||'처리이력이 없습니다.';}
    catch(error){$('history-list').textContent=error.message;}
  });
  $('history-close').addEventListener('click',()=>$('history-dialog').close());
  window.addEventListener('online',render);window.addEventListener('offline',()=>{status('인터넷 연결이 끊겼습니다. 저장 응답 확인이 필요한 요청은 연결 후 같은 요청으로 재시도해주세요.','error');render();});
  const token=storage.get(SESSION);
  if(token){state.token=token;rpc('dbmt_erp_session',{p_token:token}).then(session=>{if(!session.user)throw Error('다시 로그인해주세요.');return openWorkspace(session);}).catch(error=>{status(error.message,'error');});}
})();
