/* Fictional in-memory transactions; no browser storage or network writes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'mobile-admin.html'), 'utf8');
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
new vm.Script(fs.readFileSync(path.join(root, 'Code.gs'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'stock-ledger.js'), 'utf8');
const build = html.slice(html.indexOf('    function buildStockRows('), html.indexOf('    function renderStock('));
const context = vm.createContext({});
vm.runInContext(source + '\n' + build, context);
const row = {product:'같은 생산품', lot:'SAME', origin:'국내산', packunit:'5KG', proddate:'2026-09-13',
  stockLocation:'가공장', stockNote:'같은 비고', date:'2026-09-13', price:1000};
const transactions = [
  {...row, type:'입고', weight:30},
  {...row, type:'생산입고', weight:100, stockRowId:'A'},
  {...row, type:'생산입고', weight:60, stockRowId:'B'},
  {...row, type:'출고', weight:10},
  {...row, type:'출고', weight:20, stockRowId:'B'},
  {...row, type:'사용', weight:30, stockRowId:'A'},
  {...row, type:'재고이동', weight:20, stockRowId:'A', fromLocation:'가공장', toLocation:'외부창고'},
  {...row, type:'재고조정', weight:-5, stockRowId:'B'},
];
const calculate = data => context.buildStockRows(data);
let results = calculate(transactions);
const balance = (id, place='가공장') => results.filter(r => r.stockRowId === id && r.stockLocation === place).reduce((sum,r)=>sum+r.stock,0);
assert.equal(results.length, 4);
assert.equal(balance(''), 20);
assert.equal(balance('A'), 50);
assert.equal(balance('A', '외부창고'), 20);
assert.equal(balance('B'), 35);
transactions[1].stockNote = '수정된 생산품 비고';
results = calculate(transactions);
assert.ok(results.filter(r=>r.stockRowId==='A').every(r=>r.stockNote==='수정된 생산품 비고'));
transactions[1].stockNote = '';
results = calculate(transactions);
assert.ok(results.filter(r=>r.stockRowId==='A').every(r=>r.stockNote===''));
// A missing selection cannot silently use one of the identified production rows.
results = calculate([...transactions, {...row, type:'출고', weight:40}]);
assert.equal(balance(''), -20);
assert.equal(balance('A'), 50);
assert.equal(balance('B'), 35);
assert.match(html, /row\.stockNote/);
assert.match(fs.readFileSync(path.join(root,'Code.gs'),'utf8'), /'stockRowId','stockNote'/);
// Historical origin aliases must debit the original inbound balance.
results = calculate([
  {...row,type:'입고',origin:'미국',weight:100},
  {...row,type:'출고',origin:'미국산',weight:25,price:9000},
]);
assert.equal(results.length,1);
assert.equal(results[0].stock,75);
assert.equal(results[0].price,1000,'Sales prices never revalue remaining inbound stock');
// Missing adjustment pack units use the uniquely matching existing stock row.
results = calculate([{...row,type:'입고',weight:100},{...row,type:'재고조정',weight:-5,packunit:''}]);
assert.equal(results.length,1);
assert.equal(results[0].stock,95);
// Corrected source prices apply at every location, including historical moves.
results = calculate([{...row,type:'입고',stockRowId:'cost',weight:100,price:4900,boxCount:10},
  {...row,type:'재고이동',stockRowId:'cost',weight:20,stockUnitPrice:5100,fromLocation:'가공장',toLocation:'물류창고',boxCount:2}]);
assert.ok(results.every(r=>r.price===4900));
assert.equal(results.find(r=>r.stockLocation==='가공장').stockBoxes,8);
assert.equal(results.find(r=>r.stockLocation==='물류창고').stockBoxes,2);
results = calculate([{...row,type:'입고',stockRowId:'old',weight:100},
  {...row,type:'박스기준',stockRowId:'old',weight:0,boxCountAfter:10},
  {...row,type:'출고',stockRowId:'old',weight:20,boxCount:2}]);
assert.equal(results[0].stock,80);
assert.equal(results[0].stockBoxes,8);
const ledger=context.DBMTStockLedger;
const filterRows=[{product:'양수',stock:5,price:1000},{product:'마이너스',stock:-2,price:1000},{product:'소진',stock:0.009,price:1000}];
const normalized=ledger.rows(Object.fromEntries(filterRows.map((r,i)=>[i,r])));
assert.equal(ledger.filterRows(normalized).length,2,'Default filter includes negative balances like the web');
assert.equal(ledger.filterRows(normalized,{status:'소진'}).length,1);
assert.equal(ledger.summarize(ledger.filterRows(normalized)).totalWeight,3);
assert.equal(ledger.summarize([{stock:0.25,price:1},{stock:0.25,price:1}]).totalAmount,0,'Round each row before summing, like the web');
assert.match(fs.readFileSync(path.join(root,'index.html'),'utf8'),/DBMTStockLedger\.calculate\(userTransactions/);
for(const page of ['index.html','mobile-admin.html'])assert.match(fs.readFileSync(path.join(root,page),'utf8'),/src="stock-ledger\.js\?v=20261015shared1"/);
console.log('PASS: shared web/mobile ledger, origin aliases, sale/corrected costs, inferred pack units, boxes/baselines, negative/default filters, row-rounded totals, permanent identities and latest notes');
