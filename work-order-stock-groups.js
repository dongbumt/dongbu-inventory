/* Shared PDA receipt bundles. Ledger sources stay intact. */
(function(global){
  'use strict';
  const text=value=>String(value??'').trim();
  const cents=value=>Math.round(Number(value)*100);
  const boxes=value=>value===null||value===undefined||value===''?null:
    Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):null;
  const members=stock=>stock?stock._workOrderStockRows||[stock]:[];
  const totalBoxes=rows=>rows.some(row=>boxes(row.stockBoxes)===null)?null:rows.reduce((sum,row)=>sum+boxes(row.stockBoxes),0);
  function group(rows,transactions=[],extraIdentity=()=>[]){
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
        receipt.storage,stock.stockNote,receipt.note,...extraIdentity(stock)].map(value=>text(value)));
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
  function workOrderInputs(sources,transactions=[]){
    const stockSources=new Map(sources.filter(source=>source.sourceStock).map(source=>[
      {...source.sourceStock,key:source.sourceStock.key||source.sourceStockKey||''},source]));
    return group([...stockSources.keys()],transactions).map(stock=>{
      if(!stock._workOrderStockRows)return stockSources.get(stock);
      const originals=stock._workOrderStockRows.map(member=>stockSources.get(member));
      return {sourceStockKey:stock.key,sourceStock:stock,
        inputWeight:originals.reduce((sum,row)=>sum+cents(row.inputWeight),0)/100,
        boxCount:totalBoxes(originals.map(row=>({stockBoxes:row.boxCount}))),_workOrderSourceInputs:originals};
    });
  }
  function productionInputs(inputs,transactions=[]){
    const originals=new Map(inputs.map((input,index)=>[{
      ...input,key:input.sourceStockKey||'',stock:input.qty,stockBoxes:input.boxCount,
      proddate:input.proddate||input.stockProddate||'',stockNote:input.stockNote||input.note||''
    },{input,index}]));
    return group([...originals.keys()],transactions,stock=>[
      Number(stock.stockUnitPrice??stock.price),JSON.stringify(stock.samsung??null),stock.note||'',stock._prodId||'',stock.date||''
    ]).map(stock=>{
      if(!stock._workOrderStockRows)return originals.get(stock).input;
      const members=stock._workOrderStockRows.map(member=>originals.get(member));
      return {...members[0].input,qty:stock.stock,boxCount:stock.stockBoxes,
        amount:members.reduce((sum,row)=>sum+(Number(row.input.amount)||0),0),
        proddate:stock.proddate,stockProddate:stock.proddate,stockRowId:'',sourceStockKey:stock.key,
        _receiptInputRows:members.map(row=>row.input),_receiptInputIndexes:members.map(row=>row.index)};
    });
  }
  function productionTransactions(rows,transactions=[]){
    const inputs=rows.filter(row=>row.type==='사용'&&row._isProdUse&&row._prodId).map(row=>({...row,qty:row.weight,_receiptTransaction:row}));
    const mapped=new Map();
    for(const summary of productionInputs(inputs,transactions)){
      const originals=(summary._receiptInputRows||[summary]).map(input=>input._receiptTransaction);
      const display=originals.length===1?originals[0]:{...originals[0],id:'production-input-summary:'+originals[0].id,
        weight:summary.qty,boxCount:summary.boxCount,amount:summary.amount,stockRowId:'',_receiptUseRows:originals};
      originals.forEach(row=>mapped.set(row,display));
    }
    const seen=new Set();
    return rows.flatMap(row=>{const display=mapped.get(row)||row;if(seen.has(display))return [];seen.add(display);return [display];});
  }
  function allocate(stock,weight,boxCount,action='투입'){
    const sources=members(stock).filter(source=>cents(source.stock)>0).sort((a,b)=>text(a.proddate||'9999').localeCompare(text(b.proddate||'9999'))||text(a.key).localeCompare(text(b.key)));
    const target=cents(weight);
    if(!Number.isSafeInteger(target)||target<=0||Math.abs(Number(weight)*100-target)>.000001)
      throw new Error(`${action}량은 0보다 크게, 소수 둘째 자리까지 입력해주세요.`);
    if(boxCount!==null&&boxes(boxCount)===null)throw new Error(`${action} 박스수는 0 이상의 정수로 입력해주세요.`);
    const availableWeight=sources.reduce((sum,source)=>sum+cents(source.stock),0);
    if(!Number.isSafeInteger(availableWeight)||target>availableWeight)
      throw new Error(`묶음 원료육의 사용 가능한 재고보다 ${action}량이 큽니다. 재고를 다시 선택해주세요.`);
    if(boxCount>0){
      let remainingBoxes=boxCount;
      const selected=new Map();
      for(const source of sources){
        const available=boxes(source.stockBoxes);
        if(available===null)throw new Error(`원본 재고의 박스수가 미기록입니다. ${action} 박스수를 비워두거나 원본별로 확인해주세요.`);
        const take=Math.min(remainingBoxes,available);
        if(take){selected.set(source,{stock:source,boxCount:take});remainingBoxes-=take;}
        if(!remainingBoxes)break;
      }
      if(remainingBoxes)throw new Error(`사용 가능한 재고보다 ${action} 박스수가 큽니다. 재고를 다시 선택해주세요.`);
      // Select weight sources independently, including unboxed remainders. A
      // zero-box source must not disappear merely because boxes were entered.
      let remainingWeight=target;
      for(const source of sources){
        if(!selected.has(source))selected.set(source,{stock:source,boxCount:0});
        remainingWeight-=Math.min(remainingWeight,cents(source.stock));
        if(!remainingWeight)break;
      }
      const selectedRows=sources.filter(source=>selected.has(source)).map(source=>selected.get(source));
      // Saved source inputs require positive KG. Reserve one cent of a KG per
      // selected source, then apportion the rest within each source's capacity.
      // Integer cents and largest remainders keep both entered totals exact.
      if(target<selectedRows.length)throw new Error(`선택한 박스수에 비해 ${action} 중량이 작습니다. 중량과 박스수를 확인해주세요.`);
      const remaining=target-selectedRows.length;
      const capacity=selectedRows.reduce((sum,row)=>sum+cents(row.stock.stock)-1,0);
      const parts=selectedRows.map((row,index)=>{
        const numerator=BigInt(remaining)*BigInt(cents(row.stock.stock)-1),divisor=BigInt(capacity||1);
        return {...row,index,cents:1+Number(numerator/divisor),remainder:numerator%divisor};
      });
      const ranked=[...parts].sort((a,b)=>a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1);
      const left=target-parts.reduce((sum,row)=>sum+row.cents,0);
      for(let i=0;i<left;i++)ranked[i].cents++;
      return parts.map(row=>({stock:row.stock,inputWeight:row.cents/100,boxCount:row.boxCount}));
    }
    let remaining=target;
    const allocations=[];
    for(const source of sources){
      const qty=Math.min(remaining,cents(source.stock));
      if(qty>0){allocations.push({stock:source,inputWeight:qty/100,boxCount:null});remaining-=qty;}
      if(!remaining)break;
    }
    if(remaining)throw new Error(`묶음 원료육의 사용 가능한 재고보다 ${action}량이 큽니다. 재고를 다시 선택해주세요.`);
    if(boxCount===0)allocations.forEach(row=>row.boxCount=0);
    return allocations;
  }
  global.DBMTWorkOrderStockGroups={group,members,allocate,workOrderInputs,productionInputs,productionTransactions};
})(window);
