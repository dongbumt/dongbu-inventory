// Fictional receipts model two confirmations and different per-box manufacturing dates.
const quantities=[[338.33,14,'2026-07-30'],[356.62,16,'2026-08-07'],[335.89,15,'2026-07-29'],
  [371.99,16,'2026-07-24'],[256.55,12,'2026-08-07'],[22.72,1,null],
  [132.36,6,'2026-07-29'],[292.48,12,'2026-07-30'],[93.68,4,'2026-07-23'],[113.31,5,'2026-07-24']];
module.exports=quantities.map(([weight,boxCount,proddate],i)=>{
  const cents=Math.round(weight*100),base=Math.floor(cents/boxCount),remainder=cents%boxCount;
  const barcode=j=>`QA-RAW-${i}-${j}`;
  return {id:`qa-receipt-${i}`,date:'2026-10-20',type:'입고',trader:'QA 이유푸드',traderId:'qa-raw-supplier',
    product:'QA 돈등심',labelProductId:'qa-raw-product',lot:'QA-RAW-LOT',origin:'미국산',brand:'SWIFT',storage:'냉동',
    packunit:'',stockLocation:'가공장',stockRowId:`qa-raw-source-${i}`,proddate,mfgdate:proddate,stockProddate:proddate,
    expdate:null,weight,boxCount,price:0,amount:0,note:'',_isUser:true,_pdaRawEditRevision:0,
    _pdaRawRequestId:i%2?'qa-raw-confirmation-A':'qa-raw-confirmation-B',_pdaRawPackageId:`qa-raw-package-${i}`,
    _pdaAction:'receive',_pdaCode:barcode(0),_pdaRawScannedWeight:weight,_pdaRawWeightDelta:0,
    ...(boxCount>1?{_pdaRawBoxes:Array.from({length:boxCount},(_,j)=>({id:`qa-raw-package-${i}-${j}`,barcode:barcode(j),
      weight:(base+(j<remainder?1:0))/100,originalTransactionId:`qa-receipt-${i}`}))}:{})};
});
