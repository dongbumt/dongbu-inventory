// Receives a database snapshot through stdin; never saves operating data.
const assert=require('node:assert/strict'),fs=require('node:fs');
require('../stock-ledger.js');const M=require('../ledger-model.js');
const snapshot=JSON.parse(fs.readFileSync(0,'utf8')),ctx=M.prepare(snapshot),events=M.movements(ctx);
const sum=(a,f)=>a.reduce((s,r)=>s+f(r),0),active=ctx.transactions.filter(t=>t.date&&!t._pdaProvisional);
for(const [kind,type] of [['생입','생산입고'],['생출','사용']]){
 const expected=active.filter(t=>t.type===type),actual=events.filter(e=>e.kind===kind);
 assert.equal(actual.length,expected.length,kind+' posting count');
 assert(Math.abs(sum(actual,r=>r.weight)-sum(expected,r=>Number(r.weight)))<0.01,kind+' quantities must not duplicate production entries');
}
const latest=ctx.transactions.map(t=>t.date).filter(Boolean).sort().at(-1),from=latest.slice(0,7)+'-01';
const stock=global.DBMTStockLedger.rows(global.DBMTStockLedger.calculate(ctx.transactions.filter(t=>t.date&&t.date<=latest),{products:ctx.products,openingStock:[]}));
const picks=[...new Set([...active].reverse().filter(t=>['생산입고','입고','사용'].includes(t.type)).map(t=>M.productFor(t,ctx)?.id).filter(Boolean))].slice(0,5);
let compared=0,warnings=0;
for(const productId of picks){
 const r=M.product(ctx,{productId,from,to:latest}),buckets=stock.filter(b=>M.productFor(b,ctx)?.id===productId),expected=sum(buckets,b=>b.stock);
 if(r.notice)warnings++;
 assert(Math.abs(r.closing.weight-expected)<0.011,`Product ${productId}: ledger ${r.closing.weight}, existing stock ${expected}`);compared++;
}
assert(compared>0,'At least one unambiguous registered product must reconcile');
const partyIds=[...new Set(active.filter(t=>['입고','출고'].includes(t.type)&&!t._prodId).map(t=>M.partnerFor(t,ctx)?.id).filter(Boolean))].slice(0,4);
for(const partnerId of partyIds){
 const r=M.customer(ctx,{partnerId,from,to:latest});assert(Number.isFinite(r.closing));
 if(!r.account)assert.equal(r.configured,false,'Never invent opening balances or monthly receipts');
}
console.log(`PASS: operating snapshot ${ctx.transactions.length} postings / ${ctx.production.size} production journals; ${compared} registered stock balances reconciled, ${warnings} historical-identity warnings preserved, ${partyIds.length} party reports checked; no business writes`);
