/* Display-only aggregation. Original box transactions remain the stock ledger. */
(function(global){
  'use strict';
  const fields=['date','type','traderId','trader','product','labelProductId','packunit','lot','origin','storage','brand','factoryNo','grade','note'];
  const number=value=>Number.isFinite(Number(value))?Number(value):0;
  function group(rows,locationForRow=row=>row.stockLocation||'가공장'){
    const groups=new Map(),result=[];
    for(const row of rows){
      if(row.type!=='출고'||!row._pdaRequestId||!row._pdaLabelId){result.push(row);continue;}
      const key=JSON.stringify([row._pdaRequestId,...fields.map(field=>String(row[field]??'')),locationForRow(row),number(row.price)]);
      let summary=groups.get(key);
      if(!summary){
        summary={...row,id:'pda-summary:'+row.id,weight:0,boxCount:0,amount:0,_pdaSummaryRows:[]};
        groups.set(key,summary);result.push(summary);
      }
      summary._pdaSummaryRows.push(row);
      summary.weight=(Math.round(summary.weight*100)+Math.round(number(row.weight)*100))/100;
      summary.boxCount+=row.boxCount==null||row.boxCount===''?1:number(row.boxCount);
      // Sum the saved per-box amounts; rounding the combined weight can differ.
      summary.amount+=number(row.amount);
    }
    return result.map(row=>row._pdaSummaryRows?.length===1?row._pdaSummaryRows[0]:row);
  }
  global.DBMTPdaTransactionSummary={group};
})(window);
