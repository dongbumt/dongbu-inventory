// Exercise the transaction edit handler with fictional data; no server writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/async function addTransaction\([^]*?\n\}/)[0];

async function run(stockRowId, fail = false) {
  const original = {id:'qa-inbound', type:'입고', date:'2026-09-21', product:'QA 이겹살',
    origin:'스페인', storage:'냉동', weight:229.67, price:5100, amount:1171317,
    lot:'QA-LOT', stockRowId, stockLocation:'가공장'};
  const values = {'t-date':'2026-09-21','t-type':'입고','t-trader':'QA 매입처',
    't-lot':'QA-LOT','t-proddate':'','t-weight':'229.67','t-note':'','t-price':'4900'};
  let saved, status, reset = false;
  const ctx = {
    _editTxnId:original.id, userTransactions:[original], EXCEL_TRANSACTIONS:[],
    labelProducts:[{id:'qa-product', name:original.product, origin:original.origin, storage:original.storage}],
    document:{getElementById:id=>({value:values[id] || ''})},
    getTProduct:()=>original.product, getTOrigin:()=>original.origin, getTStorage:()=>original.storage,
    getTPackunit:()=>'', getTLabelProductId:()=> 'qa-product', getTStockLocation:()=> '가공장',
    getTMoveFromLocation:()=>'', getTMoveToLocation:()=>'', getPrice:()=>0,
    getEditingTransaction:()=>original, sameOriginText:(a,b)=>a===b, samePriceText:(a,b)=>a===b,
    nationalPartNameForCode:()=>'', normalizeLabelProductTaxType:()=> '면세',
    makeAppId:()=>{throw new Error('Editing an inbound must not create a new source ID');},
    alert:message=>{throw new Error(message);}, toast(){},
    async saveTransactionRows(row, ids, deleted, options){
      saved = JSON.parse(JSON.stringify(row));
      assert.equal(options.action, '수정');
      if(fail) throw new Error('QA 실제 서버 오류');
    },
    clearTransactionForm(){reset=true;}, renderTransactions(){}, updateProductList(){},
    showTransactionSaveStatus(message, isError){status={message,isError};}
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  await ctx.addTransaction();
  assert.equal(saved.price, 4900);
  assert.equal(saved.amount, 1125383);
  assert.equal(saved.weight, 229.67);
  assert.equal(saved.stockRowId, stockRowId);
  assert.equal(saved.stockTrackingVersion, stockRowId ? '1' : '');
  if(fail){
    assert.equal(reset, false, 'Retain the edit form after failure');
    assert.equal(status.isError, true);
    assert.match(status.message, /QA 실제 서버 오류/);
    assert.doesNotMatch(status.message, /로그인/);
  } else assert.equal(reset, true);
}

(async()=>{
  await run('qa-source');
  await run('');
  await run('qa-source', true);
  console.log('PASS: inbound price edits retain source/quantity, preserve legacy grouping, and expose actual save errors');
})().catch(error=>{console.error(error);process.exitCode=1;});
