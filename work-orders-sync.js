(function(global){
  'use strict';
  const POLL_MS=5000;
  let running=false,ready=false,revision=null,versions={},timer=null,read=null,busy=false,epoch=0;
  function allowed(){
    return typeof DBMTAuth==='object' && DBMTAuth.isPersonal() && DBMTAuth.can('workorders','view') && !!getSupabasePassword();
  }
  function visible(){
    return !document.hidden && ['p-workorders','p-label'].some(id=>document.getElementById(id)?.classList.contains('active'));
  }
  function status(message){
    const el=document.getElementById('wo-sync-status');
    if(el) el.textContent=message;
  }
  async function rpc(name,args){
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),30000);
    try{return await sbRpc(name,args,{signal:controller.signal});}
    finally{clearTimeout(timeout);}
  }
  function apply(data){
    if(!data?.ok) throw new Error(data?.message || '작업지시를 불러오지 못했습니다.');
    if(!data.unchanged){
      if(!Array.isArray(data.rows)||!data.versions) throw new Error('작업지시 응답 형식을 확인해주세요.');
      versions=data.versions;
      workOrders=data.rows;
      try{localStorage.setItem('dbmt_work_orders',JSON.stringify(workOrders));}catch(_){}
      // Refresh only the list, never initialize or reset the draft form.
      if(document.getElementById('p-workorders')?.classList.contains('active')) renderWorkOrders();
      if(document.getElementById('p-label')?.classList.contains('active')) refreshLabelWorkOrderSelect();
    }
    revision=data.revision;ready=true;
    status('자동 갱신 중 · 5초 간격');
    const editing=document.getElementById('wo-edit-id')?.value;
    if(editing && global.workOrderEditVersion && versions[editing]!==global.workOrderEditVersion){
      status('편집 중인 작업지시가 다른 PC에서 변경되었습니다. 작성 내용은 유지됩니다.');
    }
  }
  function refresh(force=false){
    if(!running||!allowed()||busy) return Promise.resolve(false);
    if(read) return read;
    const token=getSupabasePassword(),requestEpoch=epoch;
    const task=(async()=>{
      try{
        const data=await rpc('dbmt_erp_get_work_orders',{p_token:token,p_revision:force?null:revision});
        if(!running||epoch!==requestEpoch||getSupabasePassword()!==token) return false;
        apply(data);return true;
      }catch(error){
        if(running&&epoch===requestEpoch) status('자동 갱신 대기 · 연결을 확인하고 다시 불러옵니다.');
        return false;
      }
    })();
    read=task;
    task.finally(()=>{if(read===task)read=null;});
    return task;
  }
  function start(){
    if(!allowed()) return Promise.resolve(false);
    running=true;
    if(!timer) timer=setInterval(()=>{if(visible())void refresh();},POLL_MS);
    return refresh(true);
  }
  function stop(){
    running=false;ready=false;revision=null;versions={};epoch++;read=null;
    clearInterval(timer);timer=null;status('로그인 후 자동 갱신됩니다.');
  }
  async function mutate(name,args,remove=false){
    if(!allowed()) throw new Error('작업지시 권한 또는 로그인 상태를 확인해주세요.');
    if(!ready) throw new Error('서버의 작업지시 목록을 불러온 후 다시 저장해주세요.');
    if(busy) throw new Error('작업지시 저장을 처리하고 있습니다. 잠시 기다려주세요.');
    busy=true;epoch++;read=null;
    const requestEpoch=epoch,token=getSupabasePassword();
    status(remove?'삭제 중…':'저장 중…');
    try{
      const data=await rpc(name,{...args,p_token:token});
      if(!running||epoch!==requestEpoch||getSupabasePassword()!==token) throw new Error('로그인 상태가 변경되었습니다. 다시 확인해주세요.');
      if(!data?.ok) throw new Error(data?.message || '서버 저장에 실패했습니다.');
      apply(data);return data;
    }catch(error){
      status('저장 확인 필요 · 입력 내용은 유지됩니다.');
      throw error;
    }finally{
      busy=false;
      if(running)void refresh(true);
    }
  }
  function write(row,expectedVersion,remove=false){
    return mutate('dbmt_erp_write_work_order',{p_row:row,p_expected_version:expectedVersion??null,p_delete:remove},remove);
  }
  async function getCarryState(id){
    if(!allowed())throw new Error('작업지시 조회 권한 또는 로그인 상태를 확인해주세요.');
    return rpc('dbmt_erp_get_work_order_carryover',{p_token:getSupabasePassword(),p_id:id});
  }
  function carry(args){return mutate('dbmt_erp_carry_work_order',args);}
  function cancelCarry(id,version){return mutate('dbmt_erp_cancel_work_order_carryover',{p_id:id,p_expected_version:version},true);}
  function versionFor(id){return ready&&Object.prototype.hasOwnProperty.call(versions,String(id))?versions[String(id)]:null;}
  global.DBMTWorkOrders={start,stop,refresh,write,versionFor,isReady:()=>ready,getCarryState,carry,cancelCarry};
  global.addEventListener('focus',()=>{if(visible())void refresh();});
  global.addEventListener('online',()=>{if(visible())void refresh(true);});
  document.addEventListener('visibilitychange',()=>{if(visible())void refresh();});
})(window);
