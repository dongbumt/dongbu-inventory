/* Output LOT selection and a separate inner-label ledger. No inventory writes here. */
(function(){
  'use strict';
  const selections=new Map(),inner=new Map();
  let signature='',read=null,readKey='',pinSeen='',history={order:'',lot:'',before:null,pages:[],data:null},lastFocus=null;
  const byId=id=>document.getElementById(id);
  const key=DBMTLabelLots.key;
  const fmt=n=>Number(n||0).toLocaleString('ko-KR',{maximumFractionDigits:2});
  function selectedLot(order){
    if(!order)return '';
    const options=DBMTLabelLots.options(order),id=String(order.id),old=selections.get(id);
    const lot=options.find(row=>key(row.lot)===key(old))?.lot||DBMTLabelLots.defaultLot(order);
    selections.set(id,lot);return lot;
  }
  function apply(order){return order?DBMTLabelLots.apply(order,selectedLot(order)):null;}
  function error(order){try{if(order)DBMTLabelLots.options(order);return '';}catch(e){return e.message;}}
  function ensure(){
    if(byId('output-lot-panel')||!document.querySelector('.touch-pack-area'))return;
    const panel=document.createElement('section');panel.id='output-lot-panel';panel.className='panel output-lot-panel';
    panel.innerHTML='<div class="output-lot-heading">이력번호별 출력 현황 <span id="output-lot-status"></span></div><table><thead><tr><th>이력번호</th><th>투입량</th><th>내포장 출력</th><th>외포장 출력</th><th></th></tr></thead><tbody id="output-lot-rows"></tbody></table><div class="output-lot-caption">내포장: 적용 후 출력분 · 생산집계 제외 / 외포장: 1장 = 1박스</div>';
    document.querySelector('.touch-pack-area').before(panel);
    panel.addEventListener('click',event=>{
      const select=event.target.closest('[data-output-lot]'),detail=event.target.closest('[data-inner-detail]'),order=selectedOrder();
      if(!order||state.loading)return;
      if(select){
        selections.set(String(order.id),select.dataset.outputLot);signature='';DBMTLabelTouch.sync();
        setStatus(`다음 출력부터 LOT ${select.dataset.outputLot||'(없음)'} 적용 · 기존 라벨은 유지됩니다.`,'ok');
        byId('output-lot-rows').querySelector('[aria-pressed="true"]')?.focus({preventScroll:true});
      }
      if(detail)void openHistory(order,detail.dataset.innerDetail);
    });
    document.body.insertAdjacentHTML('beforeend','<dialog id="inner-lot-history" class="touch-dialog inner-lot-history"><h2>내포장 출력이력</h2><p id="inner-lot-history-meta"></p><div id="inner-lot-history-rows"></div><footer><button type="button" id="inner-lot-prev">이전</button><button type="button" id="inner-lot-close">닫기</button><button type="button" id="inner-lot-next">다음</button></footer><p id="inner-lot-history-status" role="status"></p></dialog>');
    byId('inner-lot-close').onclick=()=>{byId('inner-lot-history').close();lastFocus?.focus({preventScroll:true});};
    byId('inner-lot-next').onclick=()=>{if(history.data?.nextBeforeId){history.pages.push(history.before);history.before=history.data.nextBeforeId;void readHistory();}};
    byId('inner-lot-prev').onclick=()=>{if(history.pages.length){history.before=history.pages.pop();void readHistory();}};
    byId('inner-lot-history-rows').onclick=async event=>{
      const button=event.target.closest('[data-inner-action]');if(!button||state.loading)return;
      const log=history.data?.logs.find(row=>row.id===button.dataset.innerId);if(!log)return;
      if(button.dataset.innerAction==='void'&&!confirm('이 내포장 라벨을 삭제 처리하고 집계에서 제외할까요?'))return;
      setLoading(true);
      try{
        if(button.dataset.innerAction==='reprint'){
          await saveInner([{...log,reprintCount:(Number(log.reprintCount)||0)+1,lastReprintedAt:new Date().toISOString()}]);
          await writePrintDocument(null,[{...log,untrackedLabel:true}],log.sizeKey||'7x10');
          byId('inner-lot-history-status').textContent='재출력 요청 완료 · 집계 수량은 늘어나지 않습니다.';
        }else{
          await saveInner([{...log,status:'void',voidedAt:new Date().toISOString(),voidReason:'내포장 출력이력 삭제'}]);
          byId('inner-lot-history-status').textContent='내포장 집계에서 제외했습니다.';
        }
        await readHistory();
      }catch(e){byId('inner-lot-history-status').textContent=e.message||String(e);}
      finally{setLoading(false);signature='';DBMTLabelTouch.sync();}
    };
  }
  async function fetchInner(order,force=false){
    if(!order||!state.pin)return;
    const id=String(order.id),pin=state.pin,requestKey=pin+':'+id;
    if(pinSeen!==pin){inner.clear();pinSeen=pin;}
    if(!force&&inner.has(id))return;
    if(read&&readKey===requestKey)return read;
    inner.set(id,{loading:true});signature='';
    readKey=requestKey;
    const task=(async()=>{
      try{
        const data=await sbRpc('dbmt_label_inner_prints',{p_pin:pin,p_work_order_id:id});
        if(state.pin!==pin)return;
        if(!data?.ok||!Array.isArray(data.totals))throw new Error('내포장 출력 집계를 확인할 수 없습니다.');
        inner.set(id,data);
      }catch(e){if(state.pin===pin)inner.set(id,{error:e.message||String(e)});}
      finally{if(readKey===requestKey){read=null;readKey='';}signature='';if(window.DBMTLabelTouch?.ready)DBMTLabelTouch.sync();}
    })();
    read=task;return task;
  }
  function sync(order){
    ensure();if(!byId('output-lot-panel'))return;
    if(order&&state.pin)void fetchInner(order);
    let options=[],failure='';try{options=DBMTLabelLots.options(order);}catch(e){failure=e.message;}
    const id=String(order?.id||''),data=inner.get(id),lot=error(order)?'':selectedLot(order);
    const outer=order?activeLogsForOrder(order.id):[];
    const model=options.map(row=>{
      const logs=outer.filter(log=>key(log.workOrderSnapshot?.lot??log.lot)===key(row.lot));
      const totals=(data?.totals||[]).filter(total=>key(total.lot)===key(row.lot));
      return {...row,outerCount:logs.length,outerWeight:logs.reduce((sum,log)=>sum+Number(log.labelWeight||0),0),
        innerCount:totals.reduce((sum,total)=>sum+Number(total.count||0),0),innerWeight:totals.reduce((sum,total)=>sum+Number(total.weight||0),0)};
    });
    const next=JSON.stringify([id,model,lot,failure,data?.loading,data?.error,state.loading]);if(next===signature)return;signature=next;
    byId('output-lot-status').textContent=failure||(!order?'작업지시 선택':`${options.length}개 · 현재 LOT ${lot||'-'}`);
    byId('output-lot-rows').innerHTML=model.map(row=>`<tr class="${key(row.lot)===key(lot)?'is-selected':''}"><td>${html(row.lot||'이력번호 없음')}</td><td>${fmt(row.inputWeight)} KG</td><td><button type="button" class="inner-detail" data-inner-detail="${html(row.lot)}" ${data?.loading||data?.error?'disabled':''}>${data?.error?'조회 실패':!data||data.loading?'조회 중…':`${fmt(row.innerCount)}장 / ${fmt(row.innerWeight)} KG`}</button></td><td>${fmt(row.outerCount)}장 · ${fmt(row.outerWeight)} KG</td><td><button type="button" data-output-lot="${html(row.lot)}" aria-pressed="${key(row.lot)===key(lot)}" ${state.loading?'disabled':''}>${key(row.lot)===key(lot)?'선택 중':'선택'}</button></td></tr>`).join('');
  }
  async function saveInner(logs){
    const pin=state.pin,result=await sbRpc('dbmt_label_save_inner_prints',{p_pin:pin,p_logs:logs});
    if(!result?.ok)throw new Error(result?.message||'내포장 출력이력을 저장하지 못했습니다.');
    if(state.pin===pin){inner.set(String(result.workOrderId),result);signature='';DBMTLabelTouch.sync();}
    return result;
  }
  async function openHistory(order,lot){
    lastFocus=document.activeElement;history={order:String(order.id),lot,before:null,pages:[],data:null};
    byId('inner-lot-history-meta').textContent=`LOT ${lot||'-'} · 내포장 출력분 / 재출력은 수량 중복 제외`;
    byId('inner-lot-history-status').textContent='';byId('inner-lot-history').showModal();await readHistory();
  }
  async function readHistory(){
    const ticket={...history},pin=state.pin;
    byId('inner-lot-history-rows').textContent='불러오는 중…';
    try{
      const limit=Math.max(1,Math.min(6,Math.floor((window.innerHeight*.94-240)/100)));
      const data=await sbRpc('dbmt_label_inner_prints',{p_pin:pin,p_work_order_id:ticket.order,p_before_id:ticket.before,p_lot:ticket.lot,p_limit:limit});
      if(history.order!==ticket.order||history.before!==ticket.before||state.pin!==pin)return;
      if(!data?.ok||!Array.isArray(data.logs)||!Array.isArray(data.totals))throw new Error('내포장 출력이력을 확인할 수 없습니다. 다시 열어주세요.');
      history.data=data;inner.set(ticket.order,data);
      byId('inner-lot-history-rows').innerHTML=data.logs.map(log=>`<div class="inner-history-row"><span><strong>${html(log.product||'')}</strong><small>${html(log.code)} · ${log.weightOmitted?'중량 미표기':fmt(log.labelWeight)+' KG'} · ${log.status==='void'?'삭제됨':formatTime(log.printedAt)}</small></span><button type="button" data-inner-action="reprint" data-inner-id="${html(log.id)}" ${log.status==='void'?'disabled':''}>재출력</button><button type="button" data-inner-action="void" data-inner-id="${html(log.id)}" ${log.status==='void'?'disabled':''}>삭제</button></div>`).join('')||'<p>기록된 내포장 출력이력이 없습니다.</p>';
      byId('inner-lot-prev').disabled=!history.pages.length;byId('inner-lot-next').disabled=!data.nextBeforeId;
    }catch(e){byId('inner-lot-history-rows').textContent=e.message||String(e);}
    signature='';DBMTLabelTouch.sync();
  }
  window.DBMTLabelLotUI={apply,error,sync,saveInner,refresh:()=>fetchInner(selectedOrder(),true)};
})();
