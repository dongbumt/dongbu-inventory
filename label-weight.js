/* Shared per-label weight selection. Never modifies a saved work order. */
(function(root){
  'use strict';
  const controls=new WeakMap(),presets=[1,2,3,5,10,15,20];
  function valid(value){
    const n=Number(value);
    return String(value??'').trim()!=='' && Number.isFinite(n) && n>0 && Math.abs(n*100-Math.round(n*100))<0.000001;
  }
  function value(prefix){
    const select=document.getElementById(prefix),input=document.getElementById(prefix+'-custom');
    const raw=select?.value==='custom'?input?.value:select?.value;
    return valid(raw)?Number(raw):0;
  }
  function sync(prefix,row,onChange){
    const select=document.getElementById(prefix),input=document.getElementById(prefix+'-custom');
    if(!select||!input)return;
    let state=controls.get(select);
    if(!state){
      state={id:null,onChange};controls.set(select,state);
      select.addEventListener('change',()=>{
        input.hidden=select.value!=='custom';input.disabled=select.disabled||input.hidden;
        if(!input.hidden)input.focus();state.onChange?.();
      });
      input.addEventListener('input',()=>state.onChange?.());
    }
    state.onChange=onChange;
    const id=row?String(row.id):'';
    if(state.id===id)return;
    state.id=id;
    const initial=valid(row?.weight)?Number(row.weight):0;
    const choices=[...new Set([...presets,...(initial?[initial]:[])])].sort((a,b)=>a-b);
    select.replaceChildren(new Option('중량 선택',''),...choices.map(n=>new Option(n.toFixed(2)+' KG',String(n))),new Option('직접 입력','custom'));
    select.value=initial?String(initial):'';select.disabled=!row;input.value='';input.hidden=true;input.disabled=true;
  }
  root.DBMTLabelWeight={sync,value,valid};
})(window);
