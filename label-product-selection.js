/* Selected output product only: never changes the work order or printed logs.
 * compose() is mirrored by dbmt_label_selected_product_order (schema 42).
 */
(function(root){
  'use strict';
  function compose(order,product){
    if(!order)return null;
    if(!product)return {...order};
    const mfgdate=order.mfgdate||order.date||'';
    const date=new Date(mfgdate+'T00:00:00Z');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(mfgdate)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==mfgdate)throw new Error('작업지시의 생산일을 확인해주세요.');
    const storage=product.storage==='냉장'?'냉장':'냉동';
    const fallback=product.kind==='제품'?(storage==='냉장'?30:365):(storage==='냉장'?60:730);
    const days=/^\d{1,4}$/.test(String(product.shelfdays||''))&&Number(product.shelfdays)>0?Number(product.shelfdays):fallback;
    date.setUTCDate(date.getUTCDate()+days-1);
    const result={...order,productSelectionVersion:1,product:product.name||'',labelProductId:String(product.id||''),
      taxType:product.taxType==='과세'?'과세':'면세',mfgdate,expdate:date.toISOString().slice(0,10),
      ingredients:product.meattype?`${product.meattype} 100%`:(order.ingredients||''),temptype:storage};
    for(const key of ['productCode','brand','factoryNo','nationalPartCode','nationalPartName','packunit','itemno'])result[key]=product[key]||'';
    return result;
  }
  function group(logs){
    const groups=new Map();
    for(const log of logs){
      if(log.status==='void')continue;
      const row=log.workOrderSnapshot||{},name=row.product||log.product||'품목 없음';
      const key=JSON.stringify([row.labelProductId||'',name,row.packunit||'',row.origin||'',row.lot||log.lot||'']);
      if(!groups.has(key))groups.set(key,{key,productId:row.labelProductId||'',name,packunit:row.packunit||'',code:row.productCode||'',lot:row.lot||log.lot||'',origin:row.origin||'',count:0,cents:0});
      const g=groups.get(key);g.count++;g.cents+=Math.round(Number(log.labelWeight||0)*100);
    }
    return [...groups.values()].map(g=>({...g,weight:g.cents/100})).sort((a,b)=>a.name.localeCompare(b.name,'ko')||a.packunit.localeCompare(b.packunit,'ko'));
  }
  root.DBMTLabelProducts={compose,group};
})(window);
