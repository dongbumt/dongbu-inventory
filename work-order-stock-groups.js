/* Work-order choices only. Never replace the original stock ledger identities. */
(function(global){
  'use strict';
  const text=value=>String(value??'').trim();
  const cents=value=>Math.round(Number(value)*100);
  const boxes=value=>value===null||value===undefined||value===''?null:
    Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):null;
  const members=stock=>stock?stock._workOrderStockRows||[stock]:[];
  const totalBoxes=rows=>rows.some(row=>boxes(row.stockBoxes)===null)?null:rows.reduce((sum,row)=>sum+boxes(row.stockBoxes),0);
  function group(rows,transactions=[]){
    const receipts=new Map(),result=[],groups=new Map();
    for(const row of transactions){
      if(row.type!=='입고'||!row.stockRowId)continue;
      const id=text(row.stockRowId);
      receipts.set(id,receipts.has(id)?null:row);
    }
    for(const stock of rows){
      const receipt=receipts.get(text(stock.stockRowId));
      if(!receipt?._pdaRawRequestId||receipt._pdaAction!=='receive'||stock.source==='생산입고'){
        result.push(stock);continue;
      }
      const key=JSON.stringify([receipt.date,receipt.traderId,receipt.trader,receipt.labelProductId||receipt.productId,
        stock.product,stock.lot,Number(stock.price),Number(receipt.price),stock.stockLocation||'가공장',stock.origin,
        stock.packunit,stock.brand||receipt.brand,stock.factoryNo||receipt.factoryNo,stock.grade||receipt.grade,
        receipt.storage,stock.stockNote,receipt.note].map(value=>text(value)));
      let summary=groups.get(key);
      if(!summary){
        summary={...stock,key:'wo-receipt:'+encodeURIComponent(key),stockRowId:'',stock:0,stockBoxes:0,
          proddate:'',inboundDate:receipt.date||stock.inboundDate||'',_workOrderStockRows:[]};
        groups.set(key,summary);result.push(summary);
      }
      summary._workOrderStockRows.push(stock);
      summary.stock=(cents(summary.stock)+cents(stock.stock))/100;
    }
    return result.map(stock=>{
      if(!stock._workOrderStockRows)return stock;
      if(stock._workOrderStockRows.length===1)return stock._workOrderStockRows[0];
      stock.stockBoxes=totalBoxes(stock._workOrderStockRows);
      const dates=[...new Set(stock._workOrderStockRows.map(row=>row.proddate||''))];
      stock.proddate=dates.length===1?dates[0]:'';
      return stock;
    });
  }
  function allocate(stock,weight,boxCount){
    const sources=[...members(stock)].sort((a,b)=>text(a.proddate||'9999').localeCompare(text(b.proddate||'9999'))||text(a.key).localeCompare(text(b.key)));
    const target=cents(weight);
    if(!Number.isSafeInteger(target)||target<=0||Math.abs(Number(weight)*100-target)>.000001)
      throw new Error('투입량은 0보다 크게, 소수 둘째 자리까지 입력해주세요.');
    if(boxCount!==null&&boxes(boxCount)===null)throw new Error('투입 박스수는 0 이상의 정수로 입력해주세요.');
    if(boxCount>0){
      let remainingBoxes=boxCount;
      const selected=[];
      for(const source of sources){
        const available=boxes(source.stockBoxes);
        if(available===null)throw new Error('원본 재고의 박스수가 미기록입니다. 투입 박스수를 비워두거나 원본별로 확인해주세요.');
        const take=Math.min(remainingBoxes,available);
        if(take){selected.push({stock:source,boxCount:take});remainingBoxes-=take;}
        if(!remainingBoxes)break;
      }
      if(remainingBoxes)throw new Error('현재 재고보다 투입 박스수가 큽니다. 재고를 다시 선택해주세요.');
      const total=selected.reduce((sum,row)=>sum+cents(row.stock.stock),0);
      if(target>total)throw new Error('선택한 박스수에 연결된 원본 재고보다 투입 중량이 큽니다. 박스수를 확인하거나 비워두세요.');
      // KG and boxes are independent: allocate the entered KG, never infer it from box counts.
      const parts=selected.map((row,index)=>{
        const numerator=BigInt(target)*BigInt(cents(row.stock.stock)),divisor=BigInt(total);
        return {...row,index,cents:Number(numerator/divisor),remainder:numerator%divisor};
      });
      const ranked=[...parts].sort((a,b)=>a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1);
      const left=target-parts.reduce((sum,row)=>sum+row.cents,0);
      for(let i=0;i<left;i++)ranked[i].cents++;
      if(parts.some(row=>!row.cents))throw new Error('선택한 박스수에 비해 투입 중량이 작습니다. 중량과 박스수를 확인해주세요.');
      return parts.map(row=>({stock:row.stock,inputWeight:row.cents/100,boxCount:row.boxCount}));
    }
    let remaining=target;
    const allocations=[];
    for(const source of sources){
      const qty=Math.min(remaining,cents(source.stock));
      if(qty>0){allocations.push({stock:source,inputWeight:qty/100,boxCount:null});remaining-=qty;}
      if(!remaining)break;
    }
    if(remaining)throw new Error('묶음 원료육의 현재 재고보다 투입량이 큽니다. 재고를 다시 선택해주세요.');
    if(boxCount===0)allocations.forEach(row=>row.boxCount=0);
    return allocations;
  }
  global.DBMTWorkOrderStockGroups={group,members,allocate};
})(window);
