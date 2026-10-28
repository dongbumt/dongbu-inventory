/* Work-order output trace choices. Legacy orders keep their recorded common LOT. */
(function(root){
  'use strict';
  const text=value=>String(value??'').trim();
  const key=value=>text(value).replace(/\s+/g,'').toUpperCase();
  function sources(order){
    return Array.isArray(order?.sourceInputs)&&order.sourceInputs.length?order.sourceInputs:
      order?.sourceStock?[{sourceStock:order.sourceStock,inputWeight:order.inputWeight,boxCount:order.inputBoxCount}]:[];
  }
  function candidates(order){
    const rows=new Map();
    for(const input of sources(order)){
      const source=input.sourceStock||{},lot=text(source.lot),id=key(lot);
      if(!id)continue;
      if(!rows.has(id))rows.set(id,{lot,inputWeight:0,sourceKeys:[]});
      const row=rows.get(id);row.inputWeight=Math.round((row.inputWeight+(Number(input.inputWeight)||0))*100)/100;
      row.sourceKeys.push(source.stockRowId||source.key||input.sourceStockKey||'');
    }
    return [...rows.values()];
  }
  function options(order){
    if(!order)return [];
    if(order.outputLotSelectionVersion===1){
      if(!Array.isArray(order.outputLots)||order.outputLots.length<1||order.outputLots.length>3)throw new Error('작업지시의 출력 이력번호를 확인해주세요.');
      const available=candidates(order),seen=new Set();
      return order.outputLots.map(lot=>{
        const id=key(lot),found=available.find(row=>key(row.lot)===id);
        if(!found||seen.has(id))throw new Error('선택한 출력 이력번호가 원료 목록과 다릅니다. 작업지시를 확인해주세요.');
        seen.add(id);return {...found,lot:text(lot)};
      });
    }
    const lot=text(order.lot||order.sourceStock?.lot||sources(order)[0]?.sourceStock?.lot);
    return [{lot,inputWeight:Number(order.inputWeight)||0,sourceKeys:sources(order).map(s=>s.sourceStock?.stockRowId||s.sourceStock?.key||'')}];
  }
  function apply(order,lot){
    if(!order)return null;
    const rows=options(order),selected=rows.find(row=>key(row.lot)===key(lot));
    if(!selected)throw new Error('라벨에 사용할 이력번호를 선택해주세요.');
    return {...order,lot:selected.lot};
  }
  function defaultLot(order){
    const rows=options(order);
    return rows.find(row=>key(row.lot)===key(order?.defaultOutputLot))?.lot||rows[0]?.lot||'';
  }
  root.DBMTLabelLots={key,sources,candidates,options,apply,defaultLot};
})(window);
