(function(){
  'use strict';
  const plan=id=>document.getElementById('mp-'+id),order=id=>document.getElementById('mw-'+id);
  const state={events:[],orders:[],editing:null,selected:'',saving:false,loading:false,orderLoading:false,planRequest:0,orderRequest:0};
  function message(node,value='',error=false){node.textContent=value;node.classList.toggle('error',error);}
  function dates(){
    if(!plan('anchor').value)plan('anchor').value=localDate();
    const first=new Date(plan('anchor').value+'T12:00:00');first.setDate(first.getDate()-first.getDay());
    return Array.from({length:21},(_,i)=>{const day=new Date(first);day.setDate(day.getDate()+i);return localDate(day);});
  }
  function sync(){
    plan('editor').querySelectorAll('input,select,textarea,button').forEach(node=>{node.disabled=state.saving||state.loading;});
    document.querySelectorAll('#view-production-plan .mp-toolbar button,#mp-anchor').forEach(node=>{node.disabled=state.saving;});
    plan('add').disabled=state.saving||state.loading;plan('save').textContent=state.saving?'저장 중…':'저장';
  }
  function closeEditor(){
    if(state.saving)return;
    state.editing=null;plan('editor').reset();plan('editor').classList.add('hidden');plan('delete').classList.add('hidden');
  }
  function reset(){
    state.planRequest++;state.orderRequest++;state.events=[];state.orders=[];state.editing=null;state.selected='';
    state.saving=false;state.loading=false;state.orderLoading=false;closeEditor();sync();
    plan('anchor').value='';order('search').value='';order('from').value='';order('to').value='';
    for(const id of ['grid','list','totals','count','range','selected-label','selected-count'])plan(id).replaceChildren();
    order('list').replaceChildren();order('count').textContent='';message(plan('message'));message(order('message'));
  }
  async function failure(error,token,node){
    if(token!==adminToken)return;
    if(/로그인이 만료/.test(error.message||'')){await logoutAdmin();setMessage(error.message,'error');}
    else message(node,error.message||String(error),true);
  }
  function renderPlans(){
    const range=dates();
    if(!range.includes(state.selected))state.selected=range.includes(plan('anchor').value)?plan('anchor').value:range[0];
    const visible=state.events.filter(row=>range.includes(row.date));
    plan('range').textContent=`${range[0]} ~ ${range[20]} · 3주`;
    plan('count').textContent=`${visible.length}건`;
    plan('grid').innerHTML=range.map((date,index)=>{
      const count=visible.filter(row=>row.date===date).length;
      const classes=['calendar-day',index%7===0?'sunday':'',index%7===6?'saturday':'',date===localDate()?'today':'',date===state.selected?'selected':''].filter(Boolean).join(' ');
      return `<button type="button" class="${classes}" data-plan-date="${date}" aria-label="${date} 생산일정 ${count}건" ${state.saving?'disabled':''}><span class="day-number">${Number(date.slice(5,7))}/${Number(date.slice(8))}</span>${count?`<span class="event-mark"><span class="event-dot"></span>${count}</span>`:''}</button>`;
    }).join('');
    const rows=visible.filter(row=>row.date===state.selected).sort((a,b)=>(a.status==='completed')-(b.status==='completed')||a.product.localeCompare(b.product,'ko'));
    plan('selected-label').textContent=scheduleDayLabel(state.selected);plan('selected-count').textContent=`${rows.length}건`;
    const sum=status=>qty(rows.filter(row=>row.status===status).reduce((total,row)=>total+Number(row.qty||0),0));
    plan('totals').innerHTML=`<span>예정 <strong>${sum('planned')} KG</strong></span><span>완료 <strong>${sum('completed')} KG</strong></span>${rows.some(row=>row.qty===null)?'<span>수량 미정 포함</span>':''}`;
    plan('list').innerHTML=rows.length?rows.map(row=>`<div class="row"><div class="row-top"><div class="row-title">${text(row.product)} <span class="tag">${row.qty===null?'수량 미정':qty(row.qty)+' KG'}</span></div><button type="button" class="agenda-edit" data-plan-edit="${text(row.id)}" ${state.saving||state.loading?'disabled':''}>수정</button></div><div class="meta"><span class="tag">${row.status==='completed'?'완료':'예정'}</span>${row.trader?`<span>${text(row.trader)}</span>`:''}</div>${row.note?`<div class="mp-card-note">${text(row.note)}</div>`:''}</div>`).join(''):state.loading?'<div class="empty">생산일정을 불러오는 중입니다.</div>':empty('선택한 날짜의 생산일정');
    sync();
  }
  async function loadPlans(){
    if(!adminToken||state.saving)return;
    const range=dates(),token=adminToken,request=++state.planRequest;
    state.loading=true;state.events=[];renderPlans();message(plan('message'),'생산일정을 불러오는 중…');
    try{
      const result=await rpc('dbmt_mobile_admin_production_schedule',{p_token:token,p_start:range[0],p_end:range[20]});
      if(token!==adminToken||request!==state.planRequest)return;
      if(!result?.ok)throw new Error(result?.message||'생산일정을 불러오지 못했습니다.');
      state.events=result.events||[];message(plan('message'));return true;
    }catch(error){if(request===state.planRequest)await failure(error,token,plan('message'));return false;}
    finally{if(request===state.planRequest){state.loading=false;renderPlans();}}
  }
  function edit(id=''){
    if(state.saving||state.loading||!adminToken)return;
    const row=id?state.events.find(item=>item.id===id):null;if(id&&!row)return;
    state.editing=row?{...row}:null;
    for(const key of ['date','product','qty','trader','note','status'])plan(key).value=row?.[key]??(key==='date'?state.selected:key==='status'?'planned':'');
    plan('delete').classList.toggle('hidden',!row);plan('editor').classList.remove('hidden');message(plan('message'));sync();
    plan('editor').scrollIntoView({block:'nearest',behavior:'smooth'});plan('product').focus();
  }
  async function save(event){
    event.preventDefault();if(state.saving||state.loading||!adminToken||!plan('editor').reportValidity())return;
    const record={date:plan('date').value,product:plan('product').value.trim(),qty:plan('qty').value===''?null:Number(plan('qty').value),trader:plan('trader').value.trim(),note:plan('note').value.trim(),status:plan('status').value};
    if(!record.product){message(plan('message'),'생산예정 품목을 입력해주세요.',true);return;}
    const previous=state.editing,token=adminToken,request=++state.planRequest;
    state.saving=true;sync();message(plan('message'),'생산일정을 저장하는 중…');
    try{
      const result=await rpc('dbmt_mobile_admin_save_production_schedule',{p_token:token,p_id:previous?.id||null,p_record:record,p_revision:previous?.revision??null});
      if(token!==adminToken||request!==state.planRequest)return;
      if(!result?.ok)throw new Error(result?.message||'생산일정을 저장하지 못했습니다.');
      state.events=state.events.filter(row=>row.id!==result.event.id).concat(result.event);state.selected=record.date;
      state.saving=false;closeEditor();
      if(!dates().includes(record.date)){plan('anchor').value=record.date;if(!await loadPlans())return;}else renderPlans();
      message(plan('message'),'생산일정을 저장했습니다.');
    }catch(error){if(request===state.planRequest)await failure(error,token,plan('message'));}
    finally{if(token===adminToken){state.saving=false;sync();}}
  }
  async function remove(){
    const row=state.editing;if(!row||state.saving||state.loading||!adminToken)return;
    if(!confirm(`${row.date} ${row.product} 생산일정을 삭제할까요?`))return;
    const token=adminToken,request=++state.planRequest;state.saving=true;sync();message(plan('message'),'생산일정을 삭제하는 중…');
    try{
      const result=await rpc('dbmt_mobile_admin_delete_production_schedule',{p_token:token,p_id:row.id,p_revision:row.revision});
      if(token!==adminToken||request!==state.planRequest)return;
      if(!result?.ok)throw new Error(result?.message||'생산일정을 삭제하지 못했습니다.');
      state.events=state.events.filter(item=>item.id!==row.id);state.saving=false;closeEditor();renderPlans();message(plan('message'),'생산일정을 삭제했습니다.');
    }catch(error){if(request===state.planRequest)await failure(error,token,plan('message'));}
    finally{if(token===adminToken){state.saving=false;sync();}}
  }
  function sourceInputs(row){
    return Array.isArray(row.sourceInputs)?row.sourceInputs:row.sourceStock?[{sourceStock:row.sourceStock,inputWeight:row.inputWeight}]:[];
  }
  function renderOrders(){
    const terms=order('search').value.trim().toLocaleLowerCase('ko').split(/\s+/).filter(Boolean);
    const rows=state.orders.filter(row=>{
      const hay=[row.product,row.title,row.origin,row.lot,...sourceInputs(row).flatMap(input=>[input.sourceStock?.product,input.sourceStock?.lot])].join(' ').toLocaleLowerCase('ko');
      return terms.every(term=>hay.includes(term));
    });
    order('count').textContent=`${rows.length}건 / 전체 ${state.orders.length}건`;
    order('list').innerHTML=rows.length?limitedRows(rows,row=>{
      const inputs=sourceInputs(row),total=row.inputWeight??inputs.reduce((sum,input)=>sum+number(input.inputWeight),0);
      return `<div class="row"><div class="row-top"><div class="row-title">${text(row.product||'-')}</div><div class="row-value">${number(total)>0?qty(total)+' KG':'투입량 미정'}</div></div>${row.title?`<div class="mp-card-note">${text(row.title)}</div>`:''}<div class="meta"><span>작업일 ${text(dateValue(row.date))}</span><span>${text(row.origin||'-')}</span><span>LOT ${text(row.lot||'-')}</span></div><details class="mp-order-details"><summary>투입 원료육 ${inputs.length}건 · 상세 보기</summary>${inputs.map(input=>`<div class="mp-source"><strong>${text(input.sourceStock?.product||'-')}</strong> · ${qty(input.inputWeight)} KG<div class="meta"><span>${text(input.sourceStock?.origin||'-')}</span><span>LOT ${text(input.sourceStock?.lot||'-')}</span>${input.sourceStock?.stockNote?`<span>${text(input.sourceStock.stockNote)}</span>`:''}</div></div>`).join('')}<div class="meta"><span>제조일 ${text(dateValue(row.mfgdate)||'-')}</span><span>소비기한 ${text(dateValue(row.expdate)||'-')}</span><span>${text(row.temptype||'-')}</span>${row.packunit?`<span>포장 ${text(row.packunit)}</span>`:''}${row.grade?`<span>등급 ${text(row.grade)}</span>`:''}</div>${row.ingredients?`<div class="mp-card-note">원료 및 함량: ${text(row.ingredients)}</div>`:''}</details></div>`;
    }):state.orderLoading?'<div class="empty">작업지시를 불러오는 중입니다.</div>':empty('조건에 맞는 작업지시');
  }
  async function loadOrders(){
    if(!adminToken)return;
    if(!order('from').value)order('from').value=monthStart();if(!order('to').value)order('to').value=localDate();
    const from=order('from').value,to=order('to').value,token=adminToken,request=++state.orderRequest;
    state.orders=[];
    if(from>to){state.orderLoading=false;message(order('message'),'시작일이 종료일보다 늦습니다.',true);renderOrders();return;}
    state.orderLoading=true;renderOrders();message(order('message'),'작업지시를 불러오는 중…');
    try{
      const result=await rpc('dbmt_mobile_admin_work_orders',{p_token:token,p_start:from,p_end:to});
      if(token!==adminToken||request!==state.orderRequest)return;
      if(!result?.ok)throw new Error(result?.message||'작업지시를 불러오지 못했습니다.');
      state.orders=result.orders||[];message(order('message'));
    }catch(error){if(request===state.orderRequest)await failure(error,token,order('message'));}
    finally{if(request===state.orderRequest){state.orderLoading=false;renderOrders();}}
  }
  function shiftWeek(delta){if(state.saving)return;const day=new Date(plan('anchor').value+'T12:00:00');day.setDate(day.getDate()+delta*7);plan('anchor').value=localDate(day);loadPlans();}
  plan('prev').addEventListener('click',()=>shiftWeek(-1));plan('next').addEventListener('click',()=>shiftWeek(1));
  plan('today').addEventListener('click',()=>{plan('anchor').value=localDate();state.selected=localDate();loadPlans();});
  plan('anchor').addEventListener('change',()=>{state.selected=plan('anchor').value;loadPlans();});
  plan('grid').addEventListener('click',event=>{const button=event.target.closest('[data-plan-date]');if(button&&!state.saving){state.selected=button.dataset.planDate;renderPlans();}});
  plan('list').addEventListener('click',event=>{const button=event.target.closest('[data-plan-edit]');if(button)edit(button.dataset.planEdit);});
  plan('add').addEventListener('click',()=>edit());plan('cancel').addEventListener('click',closeEditor);plan('editor').addEventListener('submit',save);plan('delete').addEventListener('click',remove);
  order('search').addEventListener('input',renderOrders);order('from').addEventListener('change',loadOrders);order('to').addEventListener('change',loadOrders);order('load').addEventListener('click',loadOrders);
  order('today').addEventListener('click',()=>{order('from').value=localDate();order('to').value=localDate();loadOrders();});
  window.DBMTMobileProduction={reset,show(name){if(!adminToken)return;if(name==='production-plan')return loadPlans();if(name==='workorders')return loadOrders();}};
})();
