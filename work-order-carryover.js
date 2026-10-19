(function(global){
  'use strict';
  let dialog,active=null,seq=0,busy=false;
  const pending=new Map();
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function canCarry(){return typeof DBMTAuth==='object'&&DBMTAuth.isPersonal()&&['view','create','update'].every(a=>DBMTAuth.can('workorders',a));}
  function buttonHtml(row){
    const buttons=[];
    if(canCarry()&&(!row._carryoverTo||pending.has(String(row.id))))buttons.push(`<button class="btn btn-secondary btn-sm" onclick="DBMTWorkOrderCarryover.open(${jsArg(row.id)})">${pending.has(String(row.id))?'이월 저장 확인':'잔량 이월'}</button>`);
    if(row._carryoverFrom&&!row._carryoverTo&&typeof DBMTAuth==='object'&&DBMTAuth.can('workorders','update')&&DBMTAuth.can('workorders','delete'))buttons.push(`<button class="btn btn-secondary btn-sm" onclick="DBMTWorkOrderCarryover.cancel(${jsArg(row.id)})">이월 취소</button>`);
    return buttons.join('');
  }
  async function cancel(id){
    if(busy||!confirm('라벨 출력 전의 이월 작업을 취소하고 원 작업지시로 되돌릴까요? 생산일보와 재고는 변경하지 않습니다.'))return;
    const version=DBMTWorkOrders.versionFor(id);if(!version){toast('최신 작업지시 목록을 확인해주세요.');return;}
    busy=true;const parent=workOrders.find(row=>String(row.id)===String(id))?._carryoverFrom?.id;
    try{await DBMTWorkOrders.cancelCarry(id,version);if(parent)pending.delete(String(parent));renderWorkOrders();toast('이월을 취소하고 원 작업지시로 되돌렸습니다.');}
    catch(error){alert('이월 취소를 완료하지 못했습니다.\n'+(error.message||error));}
    finally{busy=false;}
  }
  function link(id,date,label){return `<button class="wo-carry-nav" onclick="DBMTWorkOrderCarryover.navigate(${jsArg(id)},${jsArg(date)})">${esc(date)} ${esc(label)}</button>`;}
  function relationHtml(row){
    const parts=[];
    if(row._carryoverFrom)parts.push(link(row._carryoverFrom.id,row._carryoverFrom.date,'작업에서 이월'));
    if(row._carryoverTo)parts.push(`${row._carryoverTo.productionId?'부분 완료 · ':''}${link(row._carryoverTo.id,row._carryoverTo.date,'작업으로 이월')}`);
    return parts.length?`<span class="wo-carry-link">${parts.join('<br>')}</span>`:'';
  }
  function navigate(id,date){
    const dateEl=document.getElementById('wo-list-date');if(dateEl)dateEl.value=date;
    const search=document.getElementById('wo-list-search');if(search)search.value='';
    renderWorkOrders();
    document.getElementById('wo-list-wrap')?.scrollIntoView({block:'nearest'});
  }
  function ensure(){
    if(dialog)return;
    dialog=document.createElement('dialog');dialog.id='wo-carry-dialog';dialog.setAttribute('aria-labelledby','wo-carry-title');
    dialog.innerHTML='<h3 id="wo-carry-title">잔량 이월</h3><div id="wo-carry-body"></div><div id="wo-carry-message" role="status"></div><div class="wc-actions"><button class="btn btn-secondary" id="wo-carry-close">닫기</button><button class="btn btn-primary" id="wo-carry-save">이월 저장</button></div>';
    document.body.append(dialog);
    dialog.querySelector('#wo-carry-close').onclick=()=>{if(!busy)dialog.close();};
    dialog.querySelector('#wo-carry-save').onclick=submit;
    dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
    dialog.addEventListener('close',()=>{if(!dialog.open){seq++;active=null;}});
  }
  function message(text){dialog.querySelector('#wo-carry-message').textContent=text;}
  function nextDate(date){const d=new Date((date||localDateString())+'T12:00:00');d.setDate(d.getDate()+1);return localDateString(d);}
  function applyEditor(row){
    const locked=!!row?._carryoverFrom;
    document.querySelectorAll('#wo-source-rows input,#wo-source-rows button').forEach(el=>{el.disabled=locked;});
    const add=document.getElementById('wo-add-source');if(add)add.disabled=locked;
    const note=document.getElementById('wo-carry-note');if(note)note.textContent=locked?'이월 작업입니다. 원료·이월 중량·박스수는 이월 등록값을 유지합니다.':'';
  }
  function draw(){
    const s=active.context.state,order=s.order,values=active.args||active.values;
    dialog.querySelector('#wo-carry-body').innerHTML=`<strong>${esc(order.title||order.product)}</strong>
      <div class="wc-info">원 작업일 ${esc(order.date)} · 출력 라벨 ${Number(s.labelKg).toLocaleString()} KG / ${s.labelBoxes}박스<br>오늘 생산일보·재고·기존 라벨은 변경하지 않습니다. 넘길 원료 중량과 박스수를 직접 입력해주세요.</div>
      <label for="wo-carry-date">다음 작업일</label><input id="wo-carry-date" type="date" value="${esc(values?.p_date||[nextDate(order.date),nextDate(localDateString())].sort().at(-1))}" min="${esc(nextDate(order.date))}">
      <div class="wc-table"><table><thead><tr><th>원료 / 이력번호</th><th>원 투입량</th><th>기록 투입량</th><th>이월 상한</th><th>이월 박스수</th><th>이월 중량(KG)</th></tr></thead><tbody>${s.sources.map(source=>{
        const saved=values?.p_sources.find(x=>x.index===source.index);
        return `<tr data-source="${source.index}"><td data-label="원료 / 이력번호">${esc(source.product)}<br><small>${esc(source.lot)}</small></td><td data-label="원 투입량">${source.originalKg} KG</td><td data-label="기록 투입량">${source.usedKg??'-'} KG</td><td data-label="이월 상한">${source.maxKg} KG${source.maxBoxes===null?'':'<br>'+source.maxBoxes+'박스'}</td><td data-label="이월 박스수"><input class="wc-boxes" type="number" min="0" step="1" placeholder="미기록" value="${saved?.boxCount??''}"></td><td data-label="이월 중량(KG)"><input class="wc-weight" type="number" min="0" step="0.01" max="${source.maxKg}" placeholder="0.00" value="${saved?.qty??''}"></td></tr>`;
      }).join('')}</tbody></table></div>`;
    const retry=!!active.args;
    dialog.querySelectorAll('input').forEach(el=>{el.disabled=retry||!s.canCarry;});
    dialog.querySelector('#wo-carry-save').disabled=!s.canCarry&&!retry;
    dialog.querySelector('#wo-carry-save').textContent=retry?'같은 요청 다시 확인':'이월 저장';
    message(retry?'저장 결과를 다시 확인할 수 있습니다. 중복 작업지시는 생성되지 않습니다.':s.reason||'이월량을 입력한 원료만 다음 작업지시로 연결됩니다. 박스수는 공란으로 둘 수 있습니다.');
  }
  async function open(id){
    if(busy||!canCarry())return;
    ensure();const request=++seq,token=getSupabasePassword();
    active=null;dialog.querySelector('#wo-carry-body').textContent='이월할 작업지시를 불러오는 중입니다.';message('');
    dialog.querySelector('#wo-carry-save').disabled=true;if(!dialog.open)dialog.showModal();
    if(pending.has(String(id))){
      if(pending.get(String(id)).token===token){active=pending.get(String(id));draw();return;}
      pending.delete(String(id));
    }
    try{
      const context=await DBMTWorkOrders.getCarryState(String(id));
      if(seq!==request||!dialog.open||getSupabasePassword()!==token||!canCarry())return;
      active={id:String(id),context,token,args:null};draw();
    }catch(error){if(seq===request&&dialog.open)message(error.message||String(error));}
  }
  async function submit(){
    if(busy||!active||!canCarry())return;
    if(getSupabasePassword()!==active.token){message('로그인 상태가 변경되었습니다. 이월 창을 다시 열어주세요.');return;}
    if(!active.args){
      const date=dialog.querySelector('#wo-carry-date').value;
      if(!date||date<=active.context.state.order.date){message('다음 작업일은 원래 작업일 이후로 선택해주세요.');return;}
      const sources=[];
      for(const row of dialog.querySelectorAll('tr[data-source]')){
        const text=row.querySelector('.wc-weight').value,boxText=row.querySelector('.wc-boxes').value;
        if(!text||Number(text)===0){if(boxText&&Number(boxText)>0){message('박스수를 입력한 원료의 이월 중량도 입력해주세요.');return;}continue;}
        const qty=Number(text),index=Number(row.dataset.source),limit=active.context.state.sources.find(s=>s.index===index);
        const boxes=boxText===''?null:Number(boxText);
        if(!Number.isFinite(qty)||qty<=0||qty>limit.maxKg||Math.abs(qty*100-Math.round(qty*100))>0.000001){message('이월 중량은 원료별 이월 상한 이내로, 소수 둘째 자리까지 입력해주세요.');return;}
        if(boxes!==null&&(!Number.isSafeInteger(boxes)||boxes<0||boxes>999999999||(limit.maxBoxes!==null&&boxes>limit.maxBoxes))){message('이월 박스수는 상한 이내의 0 이상 정수로 입력하거나 공란으로 두세요.');return;}
        sources.push({index,qty,boxCount:boxes});
      }
      if(!sources.length){message('이월할 원료 중량을 하나 이상 입력해주세요.');return;}
      active.args={p_id:active.id,p_date:date,p_sources:sources,p_state_version:active.context.stateVersion,p_request_id:crypto.randomUUID()};
      active.values={p_date:date,p_sources:sources};
      pending.set(active.id,active);
    }
    busy=true;dialog.querySelectorAll('input,button').forEach(el=>{el.disabled=true;});message('이월 작업지시를 저장하는 중입니다…');
    const operation=active;
    try{
      await DBMTWorkOrders.carry(operation.args);
      pending.delete(operation.id);busy=false;dialog.close();
      if(document.getElementById('p-workorders')?.classList.contains('active'))renderWorkOrders();
      toast('잔량 이월 작업지시가 저장됐습니다.');
    }catch(error){
      if(error.status&&error.status<500){pending.delete(operation.id);operation.args=null;}
      draw();message((error.status&&error.status<500?'':'저장 결과가 확인되지 않았습니다. 같은 요청으로 다시 확인해주세요.\n')+(error.message||error));
    }finally{busy=false;dialog.querySelector('#wo-carry-close').disabled=false;}
  }
  global.DBMTWorkOrderCarryover={open,buttonHtml,relationHtml,navigate,applyEditor,cancel};
})(window);
