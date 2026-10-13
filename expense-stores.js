(function(){
  'use strict';
  const input=document.getElementById('exp-store');
  const wrapper=document.getElementById('exp-store-picker');
  const popup=document.getElementById('exp-store-popup');
  const options=document.getElementById('exp-store-options');
  const toggle=document.getElementById('exp-store-toggle');
  const status=document.getElementById('exp-store-status');
  const state={token:'',excluded:new Set(),loaded:false,loading:false,saving:false,opened:false,error:'',request:0};
  const can=action=>Boolean(window.DBMTAuth?.isPersonal()&&DBMTAuth.can('expenses',action));
  const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase('ko-KR').trim();
  function close(){
    state.opened=false;popup.hidden=true;
    input.setAttribute('aria-expanded','false');toggle.setAttribute('aria-expanded','false');
  }
  function applyPermissions(){
    const token=window.DBMTAuth?.getSessionToken()||'';
    if(token!==state.token||!can('view')){
      state.token=token;state.excluded=new Set();state.loaded=false;state.loading=false;state.saving=false;state.error='';state.request++;
      close();options.replaceChildren();status.textContent='';
    }
    if(state.opened)render();
  }
  function render(){
    if(!state.opened)return;
    const focused=document.activeElement;
    const restoreFocus=options.contains(focused)?{action:focused.dataset.action,store:focused.dataset.store}:null;
    options.replaceChildren();
    const terms=normalize(input.value).split(/\s+/).filter(Boolean);
    const stores=state.loaded?[...new Set(expenseList.map(row=>String(row.store??'').trim()).filter(Boolean))]
      .filter(name=>!state.excluded.has(name)&&terms.every(term=>normalize(name).includes(term)))
      .sort((a,b)=>a.localeCompare(b,'ko',{numeric:true})):[];
    status.textContent=state.error||(state.loading?'구매처 후보를 불러오는 중…':stores.length?`구매처 후보 ${stores.length}개 · 삭제해도 지출내역은 유지됩니다.`:'일치하는 후보가 없습니다. 직접 입력할 수 있습니다.');
    if(state.error){
      const retry=document.createElement('button');retry.type='button';retry.className='exp-store-retry';retry.textContent='다시 불러오기';
      retry.addEventListener('click',load);options.append(retry);
    }
    for(const name of stores){
      const row=document.createElement('div');row.className='exp-store-option';
      const select=document.createElement('button');select.type='button';select.className='exp-store-select';select.textContent=name;
      select.dataset.store=name;select.dataset.action='select';
      row.append(select);
      if(can('delete')){
        const remove=document.createElement('button');remove.type='button';remove.className='exp-store-delete';remove.textContent=state.saving===name?'저장 중…':'삭제';
        remove.setAttribute('aria-label',`${name} 후보 삭제`);remove.dataset.store=name;remove.dataset.action='delete';remove.disabled=Boolean(state.saving);
        row.append(remove);
      }
      options.append(row);
    }
    options.style.maxHeight=Math.max(80,Math.min(280,innerHeight-input.getBoundingClientRect().bottom-90))+'px';
    if(restoreFocus){
      const target=[...options.querySelectorAll('button[data-action]')].find(button=>button.dataset.action===restoreFocus.action&&button.dataset.store===restoreFocus.store&&!button.disabled);
      (target||input).focus();
    }
  }
  async function load(){
    applyPermissions();
    if(!can('view')||state.loading||state.saving)return;
    const token=state.token,request=++state.request;
    state.loading=true;state.error='';render();
    try{
      const result=await sbRpc('dbmt_erp_get_expense_store_exclusions',{p_token:token});
      if(request!==state.request||token!==DBMTAuth.getSessionToken())return;
      if(!result?.ok)throw new Error(result?.message||'구매처 후보를 불러오지 못했습니다.');
      state.excluded=new Set(result.stores||[]);state.loaded=true;
    }catch(error){if(request===state.request)state.error=error.message||String(error);}
    finally{if(request===state.request){state.loading=false;render();}}
  }
  function open(){
    applyPermissions();if(!can('view'))return;
    state.opened=true;popup.hidden=false;input.setAttribute('aria-expanded','true');toggle.setAttribute('aria-expanded','true');
    render();if(!state.loaded&&!state.loading)load();
  }
  async function remove(name){
    applyPermissions();if(!can('delete')||state.saving||!state.loaded)return;
    const token=state.token,request=++state.request;
    state.loading=false;state.saving=name;state.error='';render();
    try{
      const result=await sbRpc('dbmt_erp_hide_expense_store',{p_token:token,p_store:name});
      if(request!==state.request||token!==DBMTAuth.getSessionToken())return;
      if(!result?.ok)throw new Error(result?.message||'구매처 후보 삭제에 실패했습니다.');
      state.excluded=new Set(result.stores||[]);
      if(typeof toast==='function')toast('구매처 후보를 삭제했습니다.');
    }catch(error){if(request===state.request)state.error=error.message||String(error);}
    finally{if(request===state.request){state.saving=false;render();}}
  }
  input.addEventListener('focus',open);
  input.addEventListener('click',open);
  input.addEventListener('input',open);
  input.addEventListener('keydown',event=>{
    if(event.key==='ArrowDown'){event.preventDefault();open();options.querySelector('.exp-store-select')?.focus();}
  });
  toggle.addEventListener('click',()=>{
    if(state.opened){input.focus();close();}else{input.focus();open();}
  });
  popup.addEventListener('click',event=>{
    const button=event.target.closest('button[data-action]');if(!button)return;
    if(button.dataset.action==='delete')remove(button.dataset.store);
    else{input.value=button.dataset.store;input.focus();close();input.dispatchEvent(new Event('change',{bubbles:true}));}
  });
  wrapper.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();input.focus();close();}
  });
  wrapper.addEventListener('focusout',()=>setTimeout(()=>{if(!wrapper.contains(document.activeElement))close();},0));
  document.addEventListener('pointerdown',event=>{if(!wrapper.contains(event.target))close();});
  window.addEventListener('resize',render);
  window.DBMTExpenseStores={load,close,applyPermissions};
})();
