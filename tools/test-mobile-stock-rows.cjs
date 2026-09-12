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
const balance = (id, place='가공장') => results.find(r => r.stockRowId === id && r.stockLocation === place)?.stock;
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
console.log('PASS: mobile separate rows, identical notes, legacy consumption, moves, adjustments, reused inputs, latest/cleared notes, syntax and Apps Script fields');
