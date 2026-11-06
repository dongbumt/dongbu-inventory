/* Shared catalog only: never reload transactions, production entries or drafts. */
(function(global){
  'use strict';
  const POLL_MS=5000;
  let running=false,ready=false,revision=null,token='',epoch=0,timer=null,read=null,controller=null,writes=0;
  const allowed=()=>Boolean(global.DBMTAuth?.isPersonal() && DBMTAuth.getSessionToken());
  const visible=()=>!document.hidden;
  const active=id=>document.getElementById(id)?.classList.contains('active');
  const modalOpen=id=>{const el=document.getElementById(id);return el && !el.classList.contains('hidden');};
  function status(message){const el=document.getElementById('lp-sync-status');if(el)el.textContent=message;}
  function cancelRead(){epoch++;controller?.abort();controller=null;read=null;}
  function keepFilters(ids,render){
    const values=ids.map(id=>[document.getElementById(id),document.getElementById(id)?.value]);
    render();
    values.forEach(([el,value])=>{
      if(!el || value===undefined)return;
      if(el.tagName==='SELECT' && !Array.from(el.options).some(option=>option.value===value))el.add(new Option(value,value));
      el.value=value;
    });
  }
  function refreshSurfaces(refreshStock=false){
    if(active('p-labelproducts'))renderLabelProducts({preserveDraft:true});
    if(modalOpen('txn-product-picker-modal')){
      keepFilters(['tpp-search-brand','tpp-search-origin','tpp-search-storage'],()=>refreshTxnProductPickerFilterOptions());
      renderTxnProductPicker(false);
    }
    if(modalOpen('txn-stock-picker-modal')){
      keepFilters(['tsp-search-origin','tsp-search-location'],()=>refreshTxnStockPickerFilterOptions());
      renderTxnStockPicker(false);
    }
    if(active('p-prices') && document.getElementById('pr-product-results')?.style.display==='block')renderPriceProductSuggestions();
    if(active('p-transactions'))document.querySelectorAll('.bulk-in-product,#bulk-in-product-common').forEach(input=>{
      if(bulkProductWrap(input)?.querySelector('.bulk-in-product-results')?.style.display==='block')onBulkProductSearch(input,false);
    });
    if(active('p-production'))document.querySelectorAll('[id^="prod-out-product-results-"]').forEach(box=>{
      if(box.style.display==='block')renderProdOutProductSuggestions(box.id.slice('prod-out-product-results-'.length));
    });
    if(refreshStock && active('p-stock'))renderStock();
    document.dispatchEvent(new Event('dbmt-product-catalog-changed'));
  }
  function apply(data){
    if(!data?.ok || typeof data.revision!=='string')throw new Error('품목 목록을 불러오지 못했습니다.');
    if(!data.unchanged){
      if(!Array.isArray(data.products))throw new Error('품목 목록 형식을 확인해주세요.');
      const refreshStock=active('p-stock') && stockSearchActivated && !stockSearchDirty;
      const select=document.getElementById('lbl-product-select');
      const selectedId=select && select.value!=='' ? labelProducts[Number(select.value)]?.id : null;
      labelProducts=data.products;
      invalidateStockMap();
      if(select){
        refreshLabelProductSelect();
        select.value=selectedId==null?'':String(labelProducts.findIndex(row=>String(row.id)===String(selectedId)));
      }
      refreshSurfaces(refreshStock);
    }
    revision=data.revision;ready=true;
    status('품목 자동 갱신 중 · 5초 간격');
  }
  function stop(){
    running=false;ready=false;revision=null;token='';writes=0;cancelRead();clearInterval(timer);timer=null;
    status('로그인 후 품목을 자동 갱신합니다.');
  }
  function refresh(force=false){
    if(!running || !allowed()){if(running)stop();return Promise.resolve(false);}
    if(token!==DBMTAuth.getSessionToken()){stop();return Promise.resolve(false);}
    if(writes)return Promise.resolve(false);
    if(read)return read;
    const requestEpoch=epoch,requestToken=token,requestController=new AbortController();controller=requestController;
    const timeout=setTimeout(()=>requestController.abort(),30000);
    const task=(async()=>{
      try{
        const data=await sbRpc('dbmt_erp_get_label_products',{p_token:requestToken,p_revision:force?null:revision},{signal:requestController.signal});
        if(!running || epoch!==requestEpoch || !allowed() || DBMTAuth.getSessionToken()!==requestToken)return false;
        apply(data);return true;
      }catch(error){
        if(running && epoch===requestEpoch)status('품목 자동 갱신 대기 · 연결 후 다시 확인합니다.');
        return false;
      }finally{clearTimeout(timeout);if(controller===requestController)controller=null;}
    })();
    read=task;task.finally(()=>{if(read===task)read=null;});return task;
  }
  function start(){
    if(!allowed())return Promise.resolve(false);
    const next=DBMTAuth.getSessionToken();
    if(token!==next){stop();token=next;}
    running=true;
    if(!timer)timer=setInterval(()=>{if(visible())void refresh();},POLL_MS);
    return refresh(true);
  }
  function beginWrite(){
    const writeToken=token;
    writes++;cancelRead();let finished=false;
    return ()=>{
      if(finished)return;finished=true;
      if(token!==writeToken)return;
      writes=Math.max(0,writes-1);
      if(running && !writes)void refresh(true);
    };
  }
  function changedLocally(){
    cancelRead();revision=null;
    if(running && allowed())ready=true;
    refreshSurfaces();
  }
  function applyPermissions(){if(running && (!allowed() || token!==DBMTAuth.getSessionToken()))stop();}
  global.DBMTProductCatalog={start,stop,refresh,beginWrite,changedLocally,applyPermissions,isReady:()=>ready};
  global.addEventListener('focus',()=>{if(visible())void refresh();});
  global.addEventListener('online',()=>{if(visible())void refresh();});
  document.addEventListener('visibilitychange',()=>{if(visible())void refresh();});
})(window);
