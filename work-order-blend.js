(function(root){
  'use strict';
  const blendRecipe=Object.freeze({
    ingredients:Object.freeze([
      Object.freeze({role:'chuck',name:'미국산 전각',percent:85}),
      Object.freeze({role:'fat',name:'한우지방',percent:15})
    ])
  });
  const compact=value=>String(value??'').normalize('NFKC').replace(/\s+/g,'');
  const traceKey=value=>compact(value).replace(/-/g,'').toUpperCase();
  function recipe(productName){
    return compact(productName)==='우민찌(지방15%)' ? blendRecipe : null;
  }

  function matchesStock(role,stock,labelProducts=[]){
    if(!stock || stock.factoryProductionDate || stock.source==='생산입고') return false;
    const productId=stock.labelProductId||stock.productId;
    const master=productId && labelProducts.find(row=>String(row.id)===String(productId));
    const kind=compact(master?.kind||stock.kind);
    const meat=compact(master?.meattype||stock.meattype);
    if((kind && kind!=='원료육') || (meat && meat!=='소고기')) return false;
    const name=compact(master?.name||stock.product||stock.name);
    const origin=compact(stock.origin||master?.origin).toUpperCase();
    if(role==='chuck') return /^(미국산?)?(볼라)?전각$/.test(name) && /^(미국산?|USA|UNITEDSTATES)$/.test(origin);
    if(role==='fat') return name==='한우지방' && /^(국내산|국산|한국산?|대한민국|KOREA)$/.test(origin);
    return false;
  }

  function targets(totalKg){
    const total=Number(String(totalKg??'').replaceAll(',',''));
    const cents=Math.round(total*100);
    if(!Number.isFinite(total)||total<=0||total>999999999||Math.abs(total-cents/100)>1e-9) return null;
    const fat=Math.round(cents*blendRecipe.ingredients[1].percent/100);
    return {chuck:(cents-fat)/100,fat:fat/100};
  }

  function normalizeSlaughterhouses(value){
    const values=Array.isArray(value)?value:String(value??'').split(/\s+\/\s+|[\r\n]+/);
    return [...new Set(values.filter(name=>typeof name==='string').map(name=>name.trim().replace(/\s+/g,' ')).filter(Boolean))];
  }

  function findSavedSlaughterhouses(stock,transactions=[]){
    const lot=traceKey(stock?.lot);
    const members=stock?._workOrderStockRows||[stock];
    const ids=new Set(members.map(member=>String(member?.stockRowId||'')));
    if(!lot||ids.has('')) return [];
    const receipts=transactions.filter(txn=>txn.type==='입고'&&txn._pdaProvisional!==true&&
      traceKey(txn.lot)===lot&&ids.has(String(txn.stockRowId||'')));
    const results=receipts.map(txn=>normalizeSlaughterhouses(txn.livestockSlaughterHouses));
    if(new Set(receipts.map(txn=>String(txn.stockRowId))).size!==ids.size || results.some(names=>!names.length)) return [];
    return normalizeSlaughterhouses(results.flat());
  }

  root.DBMTWorkOrderBlend={recipe,matchesStock,targets,normalizeSlaughterhouses,findSavedSlaughterhouses};
})(globalThis);
