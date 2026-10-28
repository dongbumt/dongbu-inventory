(function(){
  'use strict';
  let choices=[],defaultLot='',editing='',legacy=null,changed=false,updating=false;
  const el=id=>document.getElementById(id);
  const key=DBMTLabelLots.key;
  const draft=()=>({sourceInputs:workOrderSourceRows().filter(row=>row._sourceStock).map(row=>({sourceStock:row._sourceStock,inputWeight:Number(row.querySelector('.wo-input-weight')?.value)||0}))});
  function resetState(row){
    editing=String(row?.id||'');legacy=row&&row.outputLotSelectionVersion!==1?row:null;changed=false;
    choices=row?DBMTLabelLots.options(row).map(r=>r.lot):[];
    defaultLot=row?DBMTLabelLots.defaultLot(row):'';
  }
  function refresh(){
    if(updating||!el('wo-output-lots'))return;
    updating=true;
    try{
      const id=el('wo-edit-id')?.value||'';
      if(id!==editing)resetState(workOrders.find(row=>String(row.id)===id));
      const candidates=DBMTLabelLots.candidates(draft());
      if(!legacy||changed){
        choices=choices.filter(lot=>candidates.some(row=>key(row.lot)===key(lot)));
        if(!choices.length&&candidates.length)choices=[candidates[0].lot];
        if(!choices.some(lot=>key(lot)===key(defaultLot)))defaultLot=choices[0]||'';
      }
      const available=candidates.slice();
      if(legacy&&!changed&&choices[0]&&!available.some(row=>key(row.lot)===key(choices[0])))available.unshift({lot:choices[0],inputWeight:null,legacy:true});
      el('wo-lot').value=defaultLot;
      el('wo-output-lot-count').textContent=`${choices.length} / 최대 3개`;
      el('wo-output-lots').innerHTML=choices.map((lot,index)=>{
        const candidate=available.find(row=>key(row.lot)===key(lot));
        return `<div class="wo-output-lot-row"><span>${index+1}</span><select data-wo-output-index="${index}" aria-label="출력 이력번호 ${index+1}">${available.map(row=>`<option value="${htmlEscape(row.lot)}" ${key(row.lot)===key(lot)?'selected':choices.some((value,i)=>i!==index&&key(value)===key(row.lot))?'disabled':''}>${htmlEscape(row.lot)}${row.legacy?' (기존 번호 유지)':''}</option>`).join('')}</select><span class="wo-output-lot-kg">${candidate?.inputWeight==null?'-':Number(candidate.inputWeight).toLocaleString('ko-KR')}</span><label><input type="radio" name="wo-default-output-lot" data-wo-output-default="${index}" ${key(lot)===key(defaultLot)?'checked':''} aria-label="${htmlEscape(lot)} 기본 출력 이력"></label><button type="button" class="btn btn-secondary btn-sm" data-wo-output-remove="${index}" ${choices.length<=1?'disabled':''} aria-label="출력 이력번호 삭제">×</button></div>`;
      }).join('');
      el('wo-output-lot-add').disabled=workOrderSaving||choices.length>=3||!candidates.some(row=>!choices.some(lot=>key(lot)===key(row.lot)));
    }finally{updating=false;}
  }
  function changedSelection(){
    changed=true;
    const candidates=DBMTLabelLots.candidates(draft());
    choices=choices.filter(lot=>candidates.some(row=>key(row.lot)===key(lot)));
    refresh();refreshWorkOrderPreview();
  }
  el('wo-output-lots')?.addEventListener('change',event=>{
    if(event.target.matches('[data-wo-output-index]')){
      const i=Number(event.target.dataset.woOutputIndex),before=choices[i];choices[i]=event.target.value;
      if(key(defaultLot)===key(before))defaultLot=event.target.value;
      changedSelection();
    }
    if(event.target.matches('[data-wo-output-default]')){defaultLot=choices[Number(event.target.dataset.woOutputDefault)];changedSelection();}
  });
  el('wo-output-lots')?.addEventListener('click',event=>{
    const button=event.target.closest('[data-wo-output-remove]');if(!button)return;
    choices.splice(Number(button.dataset.woOutputRemove),1);changedSelection();
  });
  el('wo-output-lot-add')?.addEventListener('click',()=>{
    const next=DBMTLabelLots.candidates(draft()).find(row=>!choices.some(lot=>key(lot)===key(row.lot)));
    if(next&&choices.length<3){choices.push(next.lot);changedSelection();}
  });
  const originalPreview=window.refreshWorkOrderPreview;
  window.refreshWorkOrderPreview=function(){refresh();return originalPreview.apply(this,arguments);};
  const originalTotal=window.updateWorkOrderInputTotal;
  window.updateWorkOrderInputTotal=function(){const result=originalTotal.apply(this,arguments);refresh();return result;};
  const originalReset=window.resetWorkOrderForm;
  window.resetWorkOrderForm=function(){if(workOrderSaving&&!arguments[0])return;resetState(null);return originalReset.apply(this,arguments);};
  const originalEdit=window.editWorkOrder;
  window.editWorkOrder=function(id){
    const result=originalEdit.apply(this,arguments),row=workOrders.find(r=>String(r.id)===String(id));
    if(row&&String(el('wo-edit-id')?.value)===String(id)){resetState(row);refresh();originalPreview();}
    return result;
  };
  const originalCollect=window.collectWorkOrderForm;
  window.collectWorkOrderForm=function(){
    refresh();const row=originalCollect.apply(this,arguments);if(!row)return null;
    if(legacy&&!changed)return row;
    if(!choices.length){alert('제품 라벨에 사용할 이력번호를 하나 이상 선택해주세요.');return null;}
    row.outputLotSelectionVersion=1;row.outputLots=choices.slice();row.defaultOutputLot=defaultLot;row.lot=defaultLot;
    try{DBMTLabelLots.options(row);}catch(error){alert(error.message);return null;}
    return row;
  };
  const previewCollect=window.collectWorkOrderFormForPreview;
  window.collectWorkOrderFormForPreview=function(){
    const row=previewCollect.apply(this,arguments);
    if(row)row.lot=workOrderSourceRows().find(source=>source._sourceStock)?._sourceStock?.lot||'';
    return row;
  };
  window.DBMTWorkOrderOutputLots={refresh};
  refresh();
})();
