const assert=require('node:assert/strict');
require('../stock-ledger.js');
const M=require('../ledger-model.js');
const products=[{id:'raw',name:'원료',brand:'A',origin:'미국산',productCode:'1'},
  {id:'out-a',name:'생산품',brand:'A',origin:'미국산',packunit:'5KG'},
  {id:'out-b',name:'생산품',brand:'B',origin:'미국산',packunit:'5KG'}];
const partners=[{id:'party',name:'새 거래처',aliases:['옛 거래처']},{id:'other',name:'다른 거래처'}];
const t=(id,type,product,weight,boxCount,price,extra={})=>({id,date:'2026-11-02',type,product,weight,boxCount,price,amount:Math.round(weight*price),origin:'미국산',stockLocation:'가공장',...extra});
const tx=[
 t('in','입고','원료',100,null,10,{date:'2026-11-01',labelProductId:'raw',stockRowId:'raw-stock',trader:'옛 거래처'}),
 t('baseline','박스기준','원료',0,null,10,{date:'2026-11-01',labelProductId:'raw',stockRowId:'raw-stock',boxCountAfter:10}),
 t('use','사용','원료',20,2,10,{stockRowId:'raw-stock',_prodId:'p'}),
 t('prod','생산입고','생산품',8,2,100,{stockRowId:'finished',labelProductId:'out-a',packunit:'5KG',_prodId:'p'}),
 t('out','출고','생산품',2,1,750,{stockRowId:'finished',labelProductId:'out-a',packunit:'5KG',trader:'새 거래처'}),
 t('move','재고이동','생산품',1,0,100,{stockRowId:'finished',labelProductId:'out-a',packunit:'5KG',fromLocation:'가공장',toLocation:'물류창고'}),
 t('free','출고','원료',0,0,0,{labelProductId:'raw',trader:'새 거래처'}),
 t('wrong-partner','출고','원료',1,0,999,{labelProductId:'raw',stockRowId:'raw-stock',trader:'새 거래처',businessPartnerId:'other'}),
 t('ambiguous','입고','생산품',100,10,100,{packunit:'5KG',lot:'ambiguous'}),
 t('brand-b','입고','생산품',10,1,100,{labelProductId:'out-b',packunit:'5KG'})
];
const snapshot={products,partners,transactions:tx,production:[{id:'p',job_no:9,note:'실제 생산일보',outputs:[{product:'생산품',qty:8}]}],
 accounts:[{partner_id:'party',opening_date:'2026-11-01',opening_ar:500,opening_ap:200}],
 entries:[{id:'receipt',partner_id:'party',date:'2026-11-02',kind:'receipt',amount:300},{id:'payment',partner_id:'party',date:'2026-11-02',kind:'payment',amount:100}]};
const original=JSON.stringify(snapshot),ctx=M.prepare(snapshot),filters={from:'2026-11-01',to:'2026-11-30'};
const customer=M.customer(ctx,{...filters,partnerId:'party'});
assert.equal(customer.opening,300);assert.equal(customer.closing,600);assert.equal(customer.rows.length,5);assert.equal(customer.sums.출고,1500);assert.equal(customer.sums.입고,1000);
assert.equal(M.customer(ctx,{...filters,partnerId:'party',mode:'매출'}).closing,1700);
assert.equal(M.customer(ctx,{...filters,partnerId:'party',mode:'매입'}).closing,-1100);
assert.equal(customer.rows.find(r=>r.id==='free').amount,0);
assert.equal(M.customer(M.prepare({...snapshot,accounts:[]}),{...filters,partnerId:'party'}).configured,false);
assert.equal(M.customer(ctx,{...filters,from:'2026-11-02',partnerId:'party'}).opening,-700);
assert.equal(M.partnerFor(tx.find(t=>t.id==='wrong-partner'),ctx).id,'other');
const output=M.product(ctx,{...filters,productId:'out-a'});
assert.equal(output.closing.weight,6);assert.equal(output.closing.boxes,1);assert.equal(output.rows.filter(r=>r.kind==='생입').length,1);
assert.equal(output.rows.filter(r=>r.kind==='생입').reduce((s,r)=>s+r.weight,0),8,'never add production journal quantities twice');
assert.equal(output.incoming.weight,9);assert.equal(output.outgoing.weight,3);assert.match(output.notice,/1건/);
assert.equal(output.rows.find(r=>r.kind==='생입').name,'생산 작업 9');
assert.equal(M.product(ctx,{...filters,productId:'out-b'}).closing.weight,10,'same name, different registered brand');
assert.equal(M.product(ctx,{...filters,productId:'out-a',lot:'ambiguous'}).rows.length,0);
const raw=M.product(ctx,{...filters,productId:'raw'});assert.equal(raw.closing.weight,79);assert.equal(raw.closing.boxes,8);
assert.equal(M.product(ctx,{...filters,from:'2026-11-02',productId:'raw'}).opening.boxes,10,'box baseline restores known count');
assert.equal(M.date('2026-13-01'),'');assert.equal(M.date('2026-02-30'),'');assert.equal(M.date('2026/1/2'),'2026-01-02');
assert.equal(M.boxes(''),null);assert.equal(M.boxes(0),0);assert.equal(M.boxes(-1),null);
assert.equal(M.prepare({...snapshot,transactions:[...tx,tx[0]]}).transactions.length,tx.length,'posting id deduplication');
assert.equal(M.productFor({product:'원료',origin:'미국산',packunit:'5KG'},ctx).id,'raw','unique registered item keeps historical packing');
assert.equal(M.productFor({product:'생산품',origin:'미국산',packunit:'5KG'},ctx),null,'packing must not merge distinct brands');
assert.equal(JSON.stringify(snapshot),original,'reports never modify ERP source data');
console.log('PASS: registered IDs/aliases/brands, actual cash balances, free sales, date carry, production posting deduplication, transfers, optional boxes/baselines, invalid dates and source immutability');
