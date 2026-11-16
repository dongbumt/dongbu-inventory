/* Display-only aggregation. Original box transactions remain the stock ledger. */
(function(global){
  'use strict';
  const fields=['date','type','traderId','trader','product','labelProductId','packunit','lot','origin','storage','brand','factoryNo','grade','note','_productionCostStatus'];
  const number=value=>Number.isFinite(Number(value))?Number(value):0;
  function identity(row){
    if(row._pdaRequestId&&row._pdaLabelId)return ['product',row._pdaRequestId];
    if(row._pdaRawRequestId&&row._pdaRawPackageId)return ['raw',row._pdaRawRequestId];
    return null;
  }
  function isOutboundBox(row){return row.type==='출고'&&Boolean(identity(row));}
  function stockIdentity(row){
    // Pending labels have a temporary source per box, not real inventory rows yet.
    if(row._pdaRequestId&&(row._pdaProvisional||row._productionCostStatus==='pending'||String(row.stockRowId||'').startsWith('stock_pending_')))return ['pending'];
    if(row.stockRowId)return ['row',String(row.stockRowId)];
    return ['legacy',String(row.sourceStockKey||''),String(row.stockProddate||row.proddate||''),number(row.stockUnitPrice)];
  }
  function sourceNote(row){
    let value=String(row.stockNote||'').trim();
    [row.samsung?.vendorName||row.samsungVendorName,row.samsung?.spec||row.samsungSpec].forEach(part=>{
      part=String(part||'').trim();if(part&&!value.includes(part))value=[value,part].filter(Boolean).join(' / ');
    });
    return value;
  }
  function note(row){return [...new Set([row.note,row._pdaStockNote??row.stockNote].map(value=>String(value||'').trim()).filter(Boolean))].join(' / ');}
  function group(rows,locationForRow=row=>row.stockLocation||'가공장',sourceRows=rows){
    const groups=new Map(),result=[];
    const notes=new Map();
    for(const row of sourceRows){
      if(!row.stockRowId||!['입고','생산입고'].includes(row.type))continue;
      const value=sourceNote(row);
      if(row.type==='생산입고'||value)notes.set(String(row.stockRowId),value);
    }
    for(const row of rows){
      if(!isOutboundBox(row)){result.push(row);continue;}
      const key=JSON.stringify([...identity(row),stockIdentity(row),...fields.map(field=>String(row[field]??'')),locationForRow(row),number(row.price)]);
      let summary=groups.get(key);
      if(!summary){
        summary={...row,id:'pda-summary:'+row.id,weight:0,boxCount:0,amount:0,_pdaSummaryRows:[],
          _pdaStockNote:notes.has(String(row.stockRowId))?notes.get(String(row.stockRowId)):sourceNote(row)};
        groups.set(key,summary);result.push(summary);
      }
      summary._pdaSummaryRows.push(row);
      summary.weight=(Math.round(summary.weight*100)+Math.round(number(row.weight)*100))/100;
      summary.boxCount+=row.boxCount==null||row.boxCount===''?1:number(row.boxCount);
      // Sum the saved per-box amounts; rounding the combined weight can differ.
      summary.amount+=number(row.amount);
    }
    return result.map(row=>row._pdaSummaryRows?.length===1
      ? (row._pdaStockNote?{...row._pdaSummaryRows[0],_pdaStockNote:row._pdaStockNote}:row._pdaSummaryRows[0]):row);
  }
  global.DBMTPdaTransactionSummary={group,isOutboundBox,note};
})(window);
