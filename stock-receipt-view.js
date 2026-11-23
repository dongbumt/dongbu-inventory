/* Display-only PDA receipt totals. Original stock rows remain the targets of writes. */
(function(root){
  'use strict';
  const members=row=>row._inventoryStockRows||[row];
  const displayDate=row=>row.factoryProductionDate||row.inboundDate||'';
  const amount=row=>Number.isFinite(row._inventoryAmount)?row._inventoryAmount:
    Math.round((Number(row.stock)||0)*(Number(row.price)||0));
  const hasNegative=row=>members(row).some(source=>source.stock<-.005 || source.stockBoxes<0);
  const boxText=(value,missing='박스 미기록')=>value===null||value===undefined||value===''||!Number.isSafeInteger(Number(value))?
    missing:Number(value).toLocaleString('ko-KR');
  function groupRows(rows,transactions=[]){
    return root.DBMTWorkOrderStockGroups.group(rows,transactions).map(row=>{
      if(!row._workOrderStockRows)return row;
      const sources=row._workOrderStockRows;
      const summary={...row,inboundDate:sources[0].inboundDate||'',_inventoryStockRows:sources,
        _inventoryAmount:sources.reduce((sum,source)=>sum+amount(source),0)};
      for(const field of ['total_in','total_use','total_out','total_adjust','stock']){
        summary[field]=sources.reduce((sum,source)=>sum+Math.round((Number(source[field])||0)*100),0)/100;
      }
      // Signed box balances must stay visible, including production/PDA shortages.
      summary.stockBoxes=sources.some(source=>boxText(source.stockBoxes,'')==='')?null:
        sources.reduce((sum,source)=>sum+Number(source.stockBoxes),0);
      return summary;
    });
  }
  function filterRows(rows,filters={}){
    const ledger=globalThis.DBMTStockLedger;
    const query=String(filters.query||'').trim();
    const candidates=ledger.filterRows(rows,{...filters,status:'',query:''});
    return candidates.filter(row=>{
      const available=row.stock>.01||hasNegative(row);
      if(filters.status==='재고'&&!available)return false;
      if(filters.status==='소진'&&available)return false;
      return !query||displayDate(row).includes(query)||ledger.filterRows(members(row),{query,status:''}).length>0;
    });
  }
  function summarize(rows){
    return {count:rows.length,totalWeight:rows.reduce((sum,row)=>sum+Math.round((Number(row.stock)||0)*100),0)/100,
      totalAmount:rows.reduce((sum,row)=>sum+amount(row),0)};
  }
  root.DBMTStockReceiptView={groupRows,members,displayDate,filterRows,summarize,amount,hasNegative,boxText};
})(window);
