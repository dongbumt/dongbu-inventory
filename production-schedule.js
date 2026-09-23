(function(){
  'use strict';
  const state = {rows:[], editing:null, saving:false, loading:false, request:0, token:''};
  const el = id => document.getElementById('ps-' + id);
  const can = action => Boolean(window.DBMTAuth?.isPersonal() && DBMTAuth.can('production_schedule',action));
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dateText = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const todayText = () => dateText(new Date());
  const quantity = value => Number(value).toLocaleString('ko-KR',{maximumFractionDigits:2});
  function monthValue(){
    if(!/^\d{4}-\d{2}$/.test(el('month').value)) el('month').value=todayText().slice(0,7);
    return el('month').value;
  }
  function calendarDates(month){
    const [year,mon]=month.split('-').map(Number);
    const first=new Date(year,mon-1,1,12), last=new Date(year,mon,0,12);
    first.setDate(first.getDate()-first.getDay());
    last.setDate(last.getDate()+6-last.getDay());
    const dates=[];
    for(const d=new Date(first);d<=last;d.setDate(d.getDate()+1)) dates.push(dateText(d));
    return dates;
  }
  function message(text='',error=false){
    el('message').textContent=text;
    el('message').classList.toggle('error',error);
  }
  function syncControls(){
    const action=state.editing?'update':'create';
    el('editor').hidden=!can(action);
    el('editor-title').textContent=state.editing?'생산일정 수정':'생산예정 추가';
    el('save').textContent=state.saving?'저장 중…':state.editing?'수정 저장':'+ 일정 추가';
    el('editor').querySelectorAll('input,select,button').forEach(node=>{node.disabled=state.saving || state.loading || !can(action);});
    document.querySelectorAll('#p-production-schedule .ps-toolbar button,#ps-month').forEach(node=>{node.disabled=state.saving;});
  }
  function clearEditor(date=el('date').value || todayText()){
    state.editing=null;
    el('editor').reset();
    el('date').value=date;
    syncControls();
  }
  function applyPermissions(){
    const token=window.DBMTAuth?.getSessionToken() || '';
    if(token!==state.token || !can('view')){
      state.token=token;
      state.request++;
      state.rows=[];state.editing=null;state.loading=false;state.saving=false;
      clearEditor(todayText());
      el('calendar').innerHTML='';el('summary').textContent='';
      el('products').innerHTML='';
      message('');
    }
    syncControls();
    if(can('view') && el('calendar').children.length) render();
  }
  function render(){
    if(!can('view')) return;
    syncControls();
    const month=monthValue(), dates=calendarDates(month), [year,mon]=month.split('-').map(Number);
    el('title').textContent=`${year}년 ${mon}월`;
    const monthly=state.rows.filter(row=>row.date.startsWith(month));
    const pending=monthly.filter(row=>row.status==='planned');
    const unknown=pending.filter(row=>row.qty===null).length;
    el('summary').textContent=`예정 ${pending.length}건 · 완료 ${monthly.length-pending.length}건 · 예정수량 ${quantity(pending.reduce((sum,row)=>sum+Number(row.qty||0),0))} KG${unknown?' · 수량 미정 '+unknown+'건':''}`;
    const byDate=new Map();
    state.rows.forEach(row=>{if(!byDate.has(row.date)) byDate.set(row.date,[]);byDate.get(row.date).push(row);});
    const head=['일','월','화','수','목','금','토'].map((day,i)=>`<div class="ps-weekday ${i===0?'ps-sunday':i===6?'ps-saturday':''}">${day}</div>`).join('');
    el('calendar').innerHTML=head+dates.map((date,i)=>{
      const rows=(byDate.get(date)||[]).slice().sort((a,b)=>(a.status==='completed')-(b.status==='completed')||a.product.localeCompare(b.product,'ko')||a.id.localeCompare(b.id));
      const outside=!date.startsWith(month), holiday=typeof getKoreanHoliday==='function'?getKoreanHoliday(date):'';
      const items=rows.map(row=>`<div class="ps-item ${row.status==='completed'?'completed':''} ${can('delete')?'has-delete':''}" data-plan-id="${esc(row.id)}">
        <button type="button" class="ps-item-main" data-action="edit" data-id="${esc(row.id)}" ${!can('update')||state.saving?'disabled':''} title="생산일정 수정">
          <strong>${esc(row.product)}</strong><span>${row.qty===null?'수량 미정':quantity(row.qty)+' KG'}${row.trader?' · '+esc(row.trader):''}</span>
          ${row.note?`<span>${esc(row.note)}</span>`:''}<span class="ps-item-state">${row.status==='completed'?'✓ 완료':'생산 예정'}</span>
        </button>${can('delete')?`<button type="button" class="ps-item-delete" data-action="delete" data-id="${esc(row.id)}" aria-label="${esc(row.product)} 일정 삭제" title="삭제" ${state.saving?'disabled':''}>×</button>`:''}</div>`).join('');
      const pendingRows=rows.filter(row=>row.status==='planned');
      return `<div class="ps-day ${outside?'outside':''} ${el('date').value===date?'selected':''}" data-date="${date}">
        <div class="ps-day-head"><button type="button" class="ps-date ${date===todayText()?'today':''} ${i%7===0?'ps-sunday':i%7===6?'ps-saturday':''}" data-action="date" data-date="${date}" aria-label="${date} 생산예정 추가" ${!can('create')||state.saving?'disabled':''}>${Number(date.slice(-2))}</button><span class="ps-holiday">${esc(holiday)}</span></div>
        ${items}${pendingRows.some(row=>row.qty!==null)?`<div class="ps-day-total">예정 ${quantity(pendingRows.reduce((sum,row)=>sum+Number(row.qty||0),0))} KG</div>`:''}</div>`;
    }).join('');
  }
  async function load(){
    if(state.saving) return;
    applyPermissions();
    if(!can('view')){message('생산일정 조회 권한이 없습니다.',true);return;}
    const dates=calendarDates(monthValue()), request=++state.request, token=state.token;
    state.loading=true;state.rows=[];render();message('생산일정을 불러오는 중입니다…');
    try{
      const result=await sbRpc('dbmt_erp_get_production_schedule',{p_token:token,p_start:dates[0],p_end:dates[dates.length-1]});
      if(request!==state.request || token!==DBMTAuth.getSessionToken()) return;
      if(!result?.ok) throw new Error(result?.message||'생산일정을 불러오지 못했습니다.');
      state.rows=result.events || [];
      render();message(state.rows.length?'':'등록된 생산일정이 없습니다. 날짜를 선택해 품목을 추가하세요.');
    }catch(error){
      if(request===state.request) message(error.message||String(error),true);
    }finally{if(request===state.request){state.loading=false;syncControls();}}
  }
  function reset(date){
    if(state.saving) return;
    clearEditor(typeof date==='string'?date:undefined);render();
  }
  function edit(id){
    if(state.saving || !can('update')) return;
    const row=state.rows.find(item=>item.id===id);
    if(!row) return;
    state.editing={...row};
    for(const key of ['date','product','qty','trader','note','status']) el(key).value=row[key]??'';
    render();el('product').focus();
    el('editor').scrollIntoView({block:'nearest',behavior:'smooth'});
  }
  async function save(){
    if(state.saving || state.loading || !can(state.editing?'update':'create')) return;
    if(!el('editor').reportValidity()) return;
    const record={date:el('date').value,product:el('product').value.trim(),qty:el('qty').value===''?null:Number(el('qty').value),trader:el('trader').value.trim(),note:el('note').value.trim(),status:el('status').value};
    if(!record.product){message('생산예정 품목을 입력하세요.',true);return;}
    const previous=state.editing, token=state.token;
    state.saving=true;state.request++;syncControls();render();message('생산일정을 저장하는 중입니다…');
    try{
      const result=await sbRpc('dbmt_erp_save_production_schedule',{p_token:token,p_id:previous?.id||null,p_record:record,p_revision:previous?.revision||null});
      if(token!==DBMTAuth.getSessionToken()) return;
      if(!result?.ok) throw new Error(result?.message||'생산일정 저장에 실패했습니다.');
      state.rows=state.rows.filter(row=>row.id!==result.event.id).concat(result.event);
      state.saving=false;
      clearEditor(record.date);
      if(record.date.slice(0,7)!==monthValue()){
        el('month').value=record.date.slice(0,7);await load();
      }else render();
      message('생산일정을 저장했습니다.');
    }catch(error){
      if(token===DBMTAuth.getSessionToken()) message(error.message||String(error),true);
    }finally{if(token===state.token){state.saving=false;syncControls();render();}}
  }
  async function remove(id){
    if(state.saving || !can('delete')) return;
    const row=state.rows.find(item=>item.id===id);
    if(!row || !confirm(`${row.date} ${row.product} 생산일정을 삭제할까요?`)) return;
    const token=state.token;
    state.saving=true;state.request++;render();message('생산일정을 삭제하는 중입니다…');
    try{
      const result=await sbRpc('dbmt_erp_delete_production_schedule',{p_token:token,p_id:id,p_revision:row.revision});
      if(token!==DBMTAuth.getSessionToken()) return;
      if(!result?.ok) throw new Error(result?.message||'생산일정 삭제에 실패했습니다.');
      state.rows=state.rows.filter(item=>item.id!==id);
      if(state.editing?.id===id) clearEditor(row.date);
      message('생산일정을 삭제했습니다.');
    }catch(error){if(token===DBMTAuth.getSessionToken()) message(error.message||String(error),true);}
    finally{if(token===state.token){state.saving=false;render();}}
  }
  function moveMonth(delta){
    if(state.saving) return;
    const [year,mon]=monthValue().split('-').map(Number);
    el('month').value=dateText(new Date(year,mon-1+delta,1,12)).slice(0,7);return load();
  }
  async function init(){
    applyPermissions();
    if(!can('view')) return;
    const names=typeof labelProducts==='undefined'?[]:[...new Set(labelProducts.filter(p=>p.active!==false).map(p=>p.name).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ko'));
    el('products').innerHTML=names.map(name=>`<option value="${esc(name)}"></option>`).join('');
    if(typeof updateTraderList==='function') updateTraderList();
    if(!el('date').value) clearEditor(todayText());
    await load();
  }
  el('calendar').addEventListener('click',event=>{
    const button=event.target.closest('button[data-action]');
    if(!button || button.disabled) return;
    if(button.dataset.action==='date'){reset(button.dataset.date);el('product').focus();}
    if(button.dataset.action==='edit') edit(button.dataset.id);
    if(button.dataset.action==='delete') remove(button.dataset.id);
  });
  window.DBMTProductionSchedule={init,load,save,reset,moveMonth,applyPermissions,
    today(){if(state.saving)return;el('month').value=todayText().slice(0,7);reset(todayText());return load();}};
})();
