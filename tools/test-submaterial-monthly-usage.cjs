/* Monthly submaterial report regression checks with fictional records only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
for(const [i, match] of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries()){
  new vm.Script(match[1], {filename:`index-inline-${i}`});
}
for(const id of ['sm-monthly-month', 'sm-monthly-search', 'sm-monthly-count', 'sm-monthly-summary',
  'sm-monthly-body', 'sm-monthly-qty-total', 'sm-monthly-amount-total']){
  assert.ok(html.includes(`id="${id}"`), id);
}
assert.match(html, /function renderSubMaterials\(\)[\s\S]*?renderSubMaterialMonthlyUsage\(\);/);

const names = ['getSubMaterialMonthlyUsage', 'renderSubMaterialMonthlyUsage', 'exportSubMaterialMonthlyUsageCSV'];
const functions = names.map(name => {
  const match = html.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}).join('\n');
const elements = Object.fromEntries(['sm-monthly-month', 'sm-monthly-search', 'sm-monthly-count',
  'sm-monthly-summary', 'sm-monthly-body', 'sm-monthly-qty-total', 'sm-monthly-amount-total']
  .map(id => [id, {value:'', textContent:'', innerHTML:''}]));
const context = {
  subMaterialItems: [
    {id:'a',code:'B001',name:'포장지',spec:'100×200',unit:'장',unitPrice:10},
    {id:'b',code:'B002',name:'포장지',spec:'100×200',unit:'장',unitPrice:12},
    {id:'c',code:'B003',name:'포장지',spec:'200×300',unit:'장',unitPrice:20},
    {id:'d',code:'B004',name:'라벨',spec:'50×70',unit:'롤',unitPrice:''}
  ],
  subMaterialUsages: [
    {itemId:'a',itemName:'포장지',itemSpec:'100×200',unit:'장',workDate:'2026-09-01',qty:2},
    {itemId:'b',itemName:'포장지',itemSpec:'100×200',unit:'장',workDate:'2026-09-02',qty:3},
    {itemId:'c',itemName:'포장지',itemSpec:'200×300',unit:'장',workDate:'2026-09-03',qty:0.125},
    {itemId:'d',itemName:'라벨',itemSpec:'50×70',unit:'롤',workDate:'2026-09-04',qty:1},
    {itemId:'a',itemName:'포장지',itemSpec:'100×200',unit:'BOX',workDate:'2026-09-05',qty:1},
    {itemId:'a',itemName:'포장지',itemSpec:'100×200',unit:'장',workDate:'2026-10-01',qty:100}
  ],
  document:{getElementById:id => elements[id]},
  localDateString:() => '2026-09-30',
  parseAppNumber:value => Number(String(value ?? '').replace(/,/g,'')) || 0,
  htmlEscape:value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),
  downloadCSV:(rows,filename) => { context.csv = {rows, filename}; }
};
vm.createContext(context);
vm.runInContext(functions, context);

const report = context.getSubMaterialMonthlyUsage('2026-09');
assert.equal(report.rows.length, 4);
assert.equal(report.totalAmount, 69);
assert.equal(report.missingPriceCount, 1);
const combined = report.rows.find(row => row.spec === '100×200' && row.unit === '장');
assert.equal(combined.qty, 5);
assert.equal(combined.amount, 56);
assert.equal(report.rows.find(row => row.spec === '200×300').amount, 3);
assert.equal(report.rows.find(row => row.unit === 'BOX').qty, 1);
assert.equal(report.rows.find(row => row.unit === '롤').pricedCount, 0);
assert.equal(context.getSubMaterialMonthlyUsage('2026-10').totalAmount, 1000);

context.renderSubMaterialMonthlyUsage();
assert.equal(elements['sm-monthly-month'].value, '2026-09');
assert.match(elements['sm-monthly-summary'].textContent, /단가 미등록 1건/);
assert.match(elements['sm-monthly-amount-total'].textContent, /69원.*미산정 제외/);
assert.match(elements['sm-monthly-qty-total'].textContent, /5\.125 장/);
elements['sm-monthly-search'].value = '라벨';
context.renderSubMaterialMonthlyUsage();
assert.equal(elements['sm-monthly-count'].textContent, '(1품목·규격)');
assert.equal(elements['sm-monthly-amount-total'].textContent, '0원 (미산정 제외)');
context.exportSubMaterialMonthlyUsageCSV();
assert.equal(context.csv.filename, '부자재_월별_사용집계_2026-09.csv');
assert.equal(context.csv.rows[1][1], '라벨');
assert.equal(context.csv.rows[1][5], '');
assert.equal(context.csv.rows[2][1], '월 합계');

context.subMaterialItems[0].unitPrice = 11;
assert.equal(context.getSubMaterialMonthlyUsage('2026-09').totalAmount, 72);
context.subMaterialUsages.push({itemId:'deleted',itemName:'포장지',itemSpec:'100×200',unit:'장',workDate:'2026-09-06',qty:1});
const partial = context.getSubMaterialMonthlyUsage('2026-09');
assert.equal(partial.rows.find(row => row.spec === '100×200' && row.unit === '장').qty, 6);
assert.equal(partial.rows.find(row => row.spec === '100×200' && row.unit === '장').missingPriceCount, 1);
assert.equal(partial.totalAmount, 72, 'Unpriced usage must not be silently valued at zero');
console.log('Submaterial monthly usage report checks passed.');
