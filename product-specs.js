(function(){
  'use strict';
  const state={rows:[],editing:null,loading:false,saving:false,token:'',request:0,sortKey:'trader',sortDirection:1};
  const el=id=>document.getElementById('spec-'+id);
  const can=action=>Boolean(window.DBMTAuth?.isPersonal() && DBMTAuth.can('product_specs',action));
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase('ko-KR').trim();
  const money=value=>value===null || value===undefined?'—':Number(value).toLocaleString('ko-KR',{maximumFractionDigits:2});
  const fields=['trader','distribution','material','origin','cutting_spec','inner_packaging_spec','outer_packaging_spec','price_kg','price_box','note'];
  const collator=new Intl.Collator('ko',{numeric:true,sensitivity:'base'});
  const inputs={trader:'trader',distribution:'distribution',material:'material',origin:'origin',cutting_spec:'cutting',inner_packaging_spec:'inner-packaging',outer_packaging_spec:'outer-packaging',price_kg:'price-kg',price_box:'price-box',note:'note'};
  const distributions=new Set(['삼성웰스토리','동원홈푸드','CJ프레시웨이','동부축산유통','직납']);
  function setDistribution(value=''){
    const text=String(value??'');
    const custom=Boolean(text&&!distributions.has(text));
    el('distribution-choice').value=custom?'__custom__':text;
    el('distribution').value=text;
    el('distribution').hidden=!custom;
  }
  function changeDistribution(){
    const choice=el('distribution-choice').value,custom=choice==='__custom__';
    el('distribution').value=custom?'':choice;
    el('distribution').hidden=!custom;
    if(custom)el('distribution').focus();
  }
  function message(value='',error=false){el('message').textContent=value;el('message').classList.toggle('error',error);}
  function syncControls(){
    const action=state.editing?'update':'create';
    el('editor').hidden=!can(action);
    el('editor-title').textContent=state.editing?'제품스펙 수정':'제품스펙 등록';
    el('save').textContent=state.saving?'저장 중…':state.editing?'수정 저장':'+ 스펙 등록';
    el('editor').querySelectorAll('input,select,button').forEach(node=>{node.disabled=state.saving||state.loading||!can(action);});
  }
  function reset(){
    if(state.saving)return;
    state.editing=null;el('editor').reset();setDistribution();syncControls();
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
    const terms=normalize(el('search').value).split(/\s+/).filter(Boolean);
    return state.rows.filter(row=>{
      const values=[row.trader,row.distribution,row.material,row.origin].map(normalize);
      return terms.every(term=>values.some(value=>value.includes(term)));
    }).sort((a,b)=>compareRows(a,b)||collator.compare(a.trader??'',b.trader??'')||collator.compare(a.material??'',b.material??'')||collator.compare(a.id,b.id));
  }
  function compareRows(a,b){
    const key=state.sortKey,numeric=key==='price_kg'||key==='price_box';
    const value=row=>key==='inner_packaging_spec'?(row[key]??row.packaging_spec):row[key];
    const left=value(a),right=value(b);
    const empty=item=>item===null||item===undefined||normalize(item)===''||(numeric&&!Number.isFinite(Number(item)));
    const leftEmpty=empty(left),rightEmpty=empty(right);
    if(leftEmpty||rightEmpty)return Number(leftEmpty)-Number(rightEmpty);
    return (numeric?Number(left)-Number(right):collator.compare(normalize(left),normalize(right)))*state.sortDirection;
  }
  function sortBy(key){
    if(!fields.includes(key))return;
    state.sortDirection=state.sortKey===key?-state.sortDirection:1;
    state.sortKey=key;render();
  }
  function render(){
    const rows=filteredRows();
    document.querySelectorAll('.spec-sort').forEach(button=>{
      const active=button.dataset.sort===state.sortKey;
      button.closest('th').setAttribute('aria-sort',active?(state.sortDirection===1?'ascending':'descending'):'none');
      button.querySelector('.spec-sort-indicator').textContent=active?(state.sortDirection===1?'▲':'▼'):'↕';
      button.title=`${button.dataset.label} ${active&&state.sortDirection===1?'내림차순':'오름차순'} 정렬`;
    });
    el('count').textContent=`${rows.length.toLocaleString('ko-KR')}건 / 전체 ${state.rows.length.toLocaleString('ko-KR')}건`;
    el('rows').innerHTML=rows.length?rows.map(row=>`<tr data-id="${esc(row.id)}">
      <td>${esc(row.trader)}</td><td>${esc(row.distribution)}</td><td>${esc(row.material)}</td><td>${esc(row.origin)}</td>
      <td>${esc(row.cutting_spec)}</td><td>${esc(row.inner_packaging_spec??row.packaging_spec)}</td><td>${esc(row.outer_packaging_spec)}</td>
      <td class="spec-money">${money(row.price_kg)}</td><td class="spec-money">${money(row.price_box)}</td><td>${esc(row.note)}</td>
      <td>${can('update')?`<button type="button" class="btn btn-secondary btn-sm" data-action="edit" data-id="${esc(row.id)}">수정</button>`:''}${can('delete')?`<button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="${esc(row.id)}">삭제</button>`:''}</td>
    </tr>`).join(''):`<tr><td colspan="11" class="spec-empty">${state.loading?'제품스펙을 불러오는 중입니다.':state.rows.length?'검색 조건에 맞는 제품스펙이 없습니다.':'등록된 제품스펙이 없습니다.'}</td></tr>`;
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
    fields.forEach(key=>{el(inputs[key]).value=key==='inner_packaging_spec'?(row[key]??row.packaging_spec??''):(row[key]??'');});
    setDistribution(row.distribution);
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
  el('search').addEventListener('input',render);
  document.querySelector('.spec-table thead').addEventListener('click',event=>{
    const button=event.target.closest('button[data-sort]');
    if(button)sortBy(button.dataset.sort);
  });
  el('distribution-choice').addEventListener('change',changeDistribution);
  window.DBMTProductSpecs={init,load,save,reset,applyPermissions,clearFilters(){el('search').value='';render();}};
})();
