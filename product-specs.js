(function(){
  'use strict';
  const state={rows:[],editing:null,loading:false,saving:false,token:'',request:0};
  const el=id=>document.getElementById('spec-'+id);
  const can=action=>Boolean(window.DBMTAuth?.isPersonal() && DBMTAuth.can('product_specs',action));
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase('ko-KR').trim();
  const money=value=>value===null || value===undefined?'—':Number(value).toLocaleString('ko-KR',{maximumFractionDigits:2});
  const fields=['trader','material','origin','cutting_spec','packaging_spec','price_kg','price_box','note'];
  const inputs={trader:'trader',material:'material',origin:'origin',cutting_spec:'cutting',packaging_spec:'packaging',price_kg:'price-kg',price_box:'price-box',note:'note'};
  function message(value='',error=false){el('message').textContent=value;el('message').classList.toggle('error',error);}
  function syncControls(){
    const action=state.editing?'update':'create';
    el('editor').hidden=!can(action);
    el('editor-title').textContent=state.editing?'제품스펙 수정':'제품스펙 등록';
    el('save').textContent=state.saving?'저장 중…':state.editing?'수정 저장':'+ 스펙 등록';
    el('editor').querySelectorAll('input,button').forEach(node=>{node.disabled=state.saving||state.loading||!can(action);});
  }
  function reset(){
    if(state.saving)return;
    state.editing=null;el('editor').reset();syncControls();
  }
  function applyPermissions(){
    const token=window.DBMTAuth?.getSessionToken()||'';
    if(token!==state.token || !can('view')){
      state.token=token;state.request++;state.rows=[];state.loading=false;state.saving=false;
      reset();message('');
    }
    if(state.editing&&!can('update'))reset();
    syncControls();render();
  }
  function filteredRows(){
    const filters=Object.fromEntries(fields.map(key=>[key,normalize(el('filter-'+inputs[key]).value).replaceAll(',','')]));
    return state.rows.filter(row=>fields.every(key=>{
      const term=filters[key];
      if(!term)return true;
      const value=key.startsWith('price_') ? row[key]===null?'':String(Number(row[key])) : row[key];
      return normalize(value).includes(term);
    }));
  }
  function render(){
    const rows=filteredRows();
    el('count').textContent=`${rows.length.toLocaleString('ko-KR')}건 / 전체 ${state.rows.length.toLocaleString('ko-KR')}건`;
    el('rows').innerHTML=rows.length?rows.map(row=>`<tr data-id="${esc(row.id)}">
      <td>${esc(row.trader)}</td><td>${esc(row.material)}</td><td>${esc(row.origin)}</td>
      <td>${esc(row.cutting_spec)}</td><td>${esc(row.packaging_spec)}</td>
      <td class="spec-money">${money(row.price_kg)}</td><td class="spec-money">${money(row.price_box)}</td><td>${esc(row.note)}</td>
      <td>${can('update')?`<button type="button" class="btn btn-secondary btn-sm" data-action="edit" data-id="${esc(row.id)}">수정</button>`:''}${can('delete')?`<button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="${esc(row.id)}">삭제</button>`:''}</td>
    </tr>`).join(''):`<tr><td colspan="9" class="spec-empty">${state.loading?'제품스펙을 불러오는 중입니다.':state.rows.length?'검색 조건에 맞는 제품스펙이 없습니다.':'등록된 제품스펙이 없습니다.'}</td></tr>`;
  }
  async function load(){
    if(state.saving)return;
    applyPermissions();
    if(!can('view')){message('제품스펙 조회 권한이 없습니다.',true);return;}
    const request=++state.request,token=state.token;
    state.loading=true;render();message('제품스펙을 불러오는 중입니다…');
    try{
      const result=await sbRpc('dbmt_erp_get_product_specs',{p_token:token});
      if(request!==state.request||token!==DBMTAuth.getSessionToken())return;
      if(!result?.ok)throw new Error(result?.message||'제품스펙을 불러오지 못했습니다.');
      state.rows=result.specs||[];
      if(state.editing){
        const fresh=state.rows.find(row=>row.id===state.editing.id);
        if(fresh)state.editing=fresh;else reset();
      }
      message('');
    }catch(error){if(request===state.request)message(error.message||String(error),true);}
    finally{if(request===state.request){state.loading=false;syncControls();render();}}
  }
  function edit(id){
    if(state.saving||!can('update'))return;
    const row=state.rows.find(item=>item.id===id);
    if(!row)return;
    state.editing={...row};
    fields.forEach(key=>{el(inputs[key]).value=row[key]??'';});
    syncControls();el('editor').scrollIntoView({block:'nearest',behavior:'smooth'});el('trader').focus();
  }
  function readPrice(key){
    const value=el(inputs[key]).value;
    if(value==='')return null;
    const number=Number(value);
    if(!Number.isFinite(number)||number<0||number>999999999||Math.abs(number*100-Math.round(number*100))>0.000001)throw new Error('단가는 0 이상, 소수 둘째 자리까지 입력해주세요.');
    return number;
  }
  async function save(){
    if(state.saving||state.loading||!can(state.editing?'update':'create'))return;
    if(!el('editor').reportValidity())return;
    let record;
    try{
      record=Object.fromEntries(fields.filter(key=>!key.startsWith('price_')).map(key=>[key,el(inputs[key]).value.trim()]));
      record.price_kg=readPrice('price_kg');record.price_box=readPrice('price_box');
    }catch(error){message(error.message,true);return;}
    const previous=state.editing,token=state.token;
    state.saving=true;syncControls();message('제품스펙을 저장하는 중입니다…');
    try{
      const result=await sbRpc('dbmt_erp_save_product_spec',{p_token:token,p_id:previous?.id||null,p_record:record,p_revision:previous?.revision??null});
      if(token!==DBMTAuth.getSessionToken())return;
      if(!result?.ok)throw new Error(result?.message||'제품스펙 저장에 실패했습니다.');
      state.rows=state.rows.filter(row=>row.id!==result.spec.id).concat(result.spec);
      state.rows.sort((a,b)=>a.trader.localeCompare(b.trader,'ko')||a.material.localeCompare(b.material,'ko')||a.id.localeCompare(b.id));
      state.saving=false;reset();render();message('제품스펙을 저장했습니다.');
    }catch(error){if(token===DBMTAuth.getSessionToken())message(error.message||String(error),true);}
    finally{if(token===state.token){state.saving=false;syncControls();}}
  }
  async function remove(id){
    if(state.saving||state.loading||!can('delete'))return;
    const row=state.rows.find(item=>item.id===id);
    if(!row||!confirm(`${row.trader} / ${row.material} 제품스펙을 삭제할까요?`))return;
    const token=state.token;
    state.saving=true;syncControls();message('제품스펙을 삭제하는 중입니다…');
    try{
      const result=await sbRpc('dbmt_erp_delete_product_spec',{p_token:token,p_id:id,p_revision:row.revision});
      if(token!==DBMTAuth.getSessionToken())return;
      if(!result?.ok)throw new Error(result?.message||'제품스펙 삭제에 실패했습니다.');
      state.rows=state.rows.filter(item=>item.id!==id);
      state.saving=false;if(state.editing?.id===id)reset();render();message('제품스펙을 삭제했습니다.');
    }catch(error){if(token===DBMTAuth.getSessionToken())message(error.message||String(error),true);}
    finally{if(token===state.token){state.saving=false;syncControls();}}
  }
  async function init(){
    applyPermissions();
    if(typeof updateTraderList==='function')updateTraderList();
    if(can('view'))await load();
  }
  el('rows').addEventListener('click',event=>{
    const button=event.target.closest('button[data-action]');
    if(!button)return;
    if(button.dataset.action==='edit')edit(button.dataset.id);
    else if(button.dataset.action==='delete')remove(button.dataset.id);
  });
  document.querySelectorAll('#p-product-specs [data-spec-filter]').forEach(input=>input.addEventListener('input',render));
  window.DBMTProductSpecs={init,load,save,reset,applyPermissions,clearFilters(){document.querySelectorAll('#p-product-specs [data-spec-filter]').forEach(input=>input.value='');render();}};
})();
