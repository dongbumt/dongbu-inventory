/* Fictional in-memory transactions; no browser storage or network writes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'mobile-admin.html'), 'utf8');
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
new vm.Script(fs.readFileSync(path.join(root, 'Code.gs'), 'utf8'));
const helpers = ['number', 'dateValue', 'norm', 'productNorm', 'unitPrice', 'stockDate', 'stockLocation', 'stockKey', 'sameStock'];
const source = helpers.map(name => html.match(new RegExp(`    function ${name}\\([^]*?(?=\\r?\\n)`))[0]).join('\n');
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
assert.equal(results.find(r=>!r.stockRowId&&r.price===0).stock,-20,'Unspecified stock cost stays unknown, not the sale price');
assert.equal(balance('A'), 50);
assert.equal(balance('B'), 35);
assert.match(html, /row\.stockNote/);
assert.match(fs.readFileSync(path.join(root,'Code.gs'),'utf8'), /'stockRowId','stockNote'/);
const dated = {product:'가상 설깃',origin:'호주산',lot:'QA-DATE',packunit:'5KG',stockLocation:'가공장'};
const aug = {...dated,date:'2026-08-18',type:'생산입고',weight:290.34,price:13839};
const augOut = {...dated,date:'2026-08-19',type:'출고',weight:290,price:16000,stockUnitPrice:13839,stockProddate:'2026-08-18'};
const sep = {...dated,date:'2026-09-03',type:'생산입고',weight:7.8,price:14238};
const sepOut = {...dated,date:'2026-09-03',type:'출고',weight:7.8,price:16000,stockUnitPrice:14238,stockProddate:'2026-09-03'};
const approx = (rows,date,price,expected) => assert(Math.abs(rows.find(r=>r.proddate===date&&r.price===price).stock-expected)<1e-8);
const permutations = rows => rows.length ? rows.flatMap((r,i)=>permutations(rows.filter((_,j)=>i!==j)).map(rest=>[r,...rest])) : [[]];
for(const rows of permutations([aug,augOut,sepOut,sep])){
  const before=JSON.stringify(rows),out=calculate(rows);
  approx(out,'2026-08-18',13839,.34);approx(out,'2026-09-03',14238,0);
  assert.equal(JSON.stringify(rows),before);
}
for(const type of ['출고','사용','재고이동']){
  const out=calculate([aug,augOut,{...sepOut,type,weight:8.8,price:99999,fromLocation:'가공장',toLocation:'외부창고'},sep]);
  approx(out,'2026-08-18',13839,.34);approx(out,'2026-09-03',14238,-1);
}
const retained=calculate([aug,augOut,sepOut,sep,{...sepOut,date:'2026-09-16',type:'사용',weight:.34,price:14238}]);
approx(retained,'2026-08-18',13839,.34);approx(retained,'2026-09-03',14238,-.34);
const noCost=calculate([{...dated,type:'입고',date:'2026-09-01',weight:10,price:1000},{...dated,type:'출고',date:'2026-09-02',weight:3,price:9999}]);
assert.equal(noCost.length,1);assert.equal(noCost[0].stock,7,'Sales price is not an inventory-cost selector');
console.log('PASS: mobile separate rows, identical notes, legacy consumption, moves, adjustments, reused inputs, latest/cleared notes, syntax and Apps Script fields');
console.log('PASS: mobile same-day receipts, 24 order permutations, exact date/cost shortages, original stored selections unchanged');
