/* Separate label-only master; never writes labelProducts, transactions or stock. */
(function(global){
  'use strict';
  const fields=['name','itemno','origin','brand','grade','packunit','meattype','ingredientDetails','storage','shelfdays'];
  const state={token:'',epoch:0,products:[],editing:null,pending:false,read:null};
  const el=id=>document.getElementById('dist-'+id);
  const token=()=>global.DBMTAuth?.getSessionToken()||'';
  const can=action=>Boolean(token()&&DBMTAuth.can('distribution_products','view')&&DBMTAuth.can('distribution_products',action));
  const readable=()=>Boolean(token()&&(DBMTAuth.can('distribution_products','view')||DBMTAuth.can('label','view')));
  const esc=value=>htmlEscape(String(value??''));
  function message(text,error=false){el('status').textContent=text;el('status').classList.toggle('error',error);}
  function clearForm(){state.editing=null;el('form').reset();el('title').textContent='동부축산유통 품목 등록';}
  function reset(){if(state.pending)return;clearForm();applyPermissions();}
  function catalogProducts(){return state.token===token()&&readable()?state.products:[];}
  function publish(){document.dispatchEvent(new Event('dbmt-distribution-products-changed'));}
  function applyPermissions(){
    if(state.token!==token()||!readable()){
      state.epoch++;state.token=token();state.products=[];state.read=null;state.pending=false;clearForm();
    }
    el('fields').disabled=state.pending||!can(state.editing?'update':'create');
    el('save').classList.toggle('hidden',!can(state.editing?'update':'create'));
    el('save').disabled=state.pending;el('new').classList.toggle('hidden',!can('create'));
    el('new').disabled=state.pending;el('reset').disabled=state.pending;el('refresh').disabled=state.pending;
    el('save').textContent=state.pending?'저장 중…':state.editing?'수정 저장':'+ 품목 등록';
    render();
  }
  function render(){
    const q=el('search').value.trim().toLowerCase();
    const rows=can('view')?state.products.filter(row=>[row.name,row.brand,row.origin,row.itemno,row.packunit].join(' ').toLowerCase().includes(q)):[];
    el('count').textContent=`${rows.length}건 / 전체 ${can('view')?state.products.length:0}건`;
    el('body').innerHTML=rows.map(row=>`<tr><td><strong>${esc(row.name)}</strong></td><td>${esc(row.brand||'-')}</td>
      <td>${esc(row.origin||'-')}</td><td>${esc(row.itemno||'-')}</td><td>${esc(row.storage)}</td><td>${Number(row.shelfdays)}일</td>
      <td>${esc(row.packunit||'-')}</td><td class="dist-details">${esc(row.meattype)} 100%${row.ingredientDetails?` (${esc(row.ingredientDetails)})`:''}</td>
      <td class="dist-actions">${can('update')?`<button type="button" class="btn btn-sm btn-secondary" data-dist-edit="${esc(row.id)}" ${state.pending?'disabled':''}>수정</button>`:''}
      ${can('delete')?`<button type="button" class="btn btn-sm btn-danger" data-dist-delete="${esc(row.id)}" ${state.pending?'disabled':''}>삭제</button>`:''}</td></tr>`).join('')||'<tr><td colspan="9" class="dist-empty">등록된 품목이 없거나 검색 결과가 없습니다.</td></tr>';
  }
  async function refresh(){
    applyPermissions();if(!readable())throw Error('품목을 조회할 권한이 없습니다.');
    if(state.pending)throw Error('품목을 저장하는 중입니다. 잠시 후 다시 선택해주세요.');
    if(state.read)return state.read;
    const expected=state.epoch,session=token();
    const request=(async()=>{
      const result=await sbRpc('dbmt_erp_get_distribution_products',{p_token:session});
      if(expected!==state.epoch||session!==token())return false;
      if(!result?.ok||!Array.isArray(result.products))throw Error(result?.message||'동부축산유통 품목을 불러오지 못했습니다.');
      state.products=result.products;render();publish();return true;
    })();
    state.read=request;
    try{return await request}finally{if(state.read===request)state.read=null}
  }
  async function init(){
    applyPermissions();if(!can('view'))return;
    message('품목 목록을 불러오는 중입니다.');
    try{if(await refresh())message('동부축산유통 라벨용 품목 목록입니다.');}catch(error){message(error.message,true)}
  }
  function edit(id){
    if(state.pending||!can('update'))return;
    const row=state.products.find(row=>row.id===id);if(!row)return;
    state.editing=row;for(const field of fields)el(field).value=row[field]??'';
    el('title').textContent='동부축산유통 품목 수정';applyPermissions();el('name').focus();
  }
  async function save(){
    if(state.pending||!can(state.editing?'update':'create'))return;
    if(!el('form').reportValidity())return;
    const record=Object.fromEntries(fields.map(field=>[field,field==='shelfdays'?Number(el(field).value):el(field).value.trim()]));
    state.epoch++;state.read=null;
    const session=token(),expected=state.epoch,editing=state.editing;
    state.pending=true;applyPermissions();
    try{
      const result=await sbRpc('dbmt_erp_save_distribution_product',{p_token:session,p_id:editing?.id||null,p_record:record,p_revision:editing?.revision??null});
      if(expected!==state.epoch||session!==token())return;
      if(!result?.ok||!result.product?.id)throw Error(result?.message||'품목을 저장하지 못했습니다.');
      state.products=state.products.filter(row=>row.id!==result.product.id).concat(result.product).sort((a,b)=>a.name.localeCompare(b.name,'ko'));
      clearForm();publish();message('품목을 저장했습니다.');toast('동부축산유통 품목을 저장했습니다.');
    }catch(error){if(expected===state.epoch)message(error.message,true)}
    finally{if(expected===state.epoch){state.pending=false;applyPermissions()}}
  }
  async function remove(id){
    if(state.pending||!can('delete'))return;
    const row=state.products.find(row=>row.id===id);if(!row||!confirm(`'${row.name}' 품목을 삭제할까요?`))return;
    state.epoch++;state.read=null;
    const session=token(),expected=state.epoch;state.pending=true;applyPermissions();
    try{
      const result=await sbRpc('dbmt_erp_delete_distribution_product',{p_token:session,p_id:id,p_revision:row.revision});
      if(expected!==state.epoch||session!==token())return;
      if(!result?.ok)throw Error(result?.message||'품목을 삭제하지 못했습니다.');
      state.products=state.products.filter(item=>item.id!==id);if(state.editing?.id===id)clearForm();publish();message('품목을 삭제했습니다.');
    }catch(error){if(expected===state.epoch)message(error.message,true)}
    finally{if(expected===state.epoch){state.pending=false;applyPermissions()}}
  }
  el('form').addEventListener('submit',event=>{event.preventDefault();save()});
  el('body').addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.dataset.distEdit)edit(button.dataset.distEdit);if(button.dataset.distDelete)remove(button.dataset.distDelete);
  });
  global.DBMTDistributionProducts={init,refresh,reset,edit,save,remove,render,catalogProducts,applyPermissions};
})(window);
