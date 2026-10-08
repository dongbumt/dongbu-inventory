const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
const source = name => {
  const match = html.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert(match, `Missing ${name}`);
  return match[0];
};
const elements = new Map();
const field = (id, value = '') => {
  const element = {value, style: {}, title: '', textContent: '', innerHTML: ''};
  elements.set(id, element);
  return element;
};
for(const id of [
  'tsp-result-body','tsp-result-count','tsp-selected-summary','tsp-confirm',
  'tsp-search-all','tsp-search-name','tsp-search-lot','tsp-search-origin','tsp-search-location',
  't-stock-search','t-product-input','t-packunit','t-origin-display','t-origin-input',
  't-lot','t-proddate','t-stock-key','t-stock-price','t-stock-location','t-weight',
  't-box-count','t-note','lot-match-area'
]) field(id);
field('t-type', '출고');
const modal = field('txn-stock-picker-modal');
modal.classList = {contains: () => false};
const table = {classList: {toggle: () => {}}};
field('tsp-result-head').closest = () => table;

const stockA = {key:'A',product:'돈등심',lot:'LOT-A',origin:'국내산',packunit:'5KG',
  proddate:'2026-10-08',price:1000,stockLocation:'가공장',stock:100,stockBoxes:12};
const stockB = {...stockA,key:'B',lot:'LOT-B',stock:45,stockBoxes:null};
const context = {
  document:{getElementById:id=>elements.get(id)||null,querySelectorAll:()=>[],querySelector:()=>null},
  stocks:[stockA,stockB],editTxn:null,txnStockPickerRows:[],txnStockPickerIndex:-1,
  txnStockPickerTargetInput:null,labelProducts:[],
  getEditingTransaction:()=>context.editTxn,
  outboundStockOptionsForEdit:()=>context.stocks,
  bulkOutboundStockOptions:()=>context.stocks,
  stockOptionFromTransaction:t=>t?{key:t.stockKey}:null,
  sameBulkOutboundStockOption:(a,b)=>a.key===b.key,
  parseAppNumber:value=>Number(value)||0,
  normalizeOriginName:value=>value||'',normalizeStockLocation:value=>value||'가공장',
  stockLocationKey:value=>value||'',sameOriginText:(a,b)=>a===b,
  bulkOutboundSearchKey:value=>String(value||'').toLowerCase(),
  bulkOutboundSearchText:s=>s.product+' '+s.lot,
  txnStockPickerProductMeta:()=>({brand:'',grade:'',factoryNo:''}),
  htmlEscape:value=>String(value),
  isProductionInputStockPicker:()=>context.txnStockPickerTargetInput?.dataset?.pickerContext==='production-input',
  getTxnStockPickerOptions:()=>context.txnStockPickerTargetInput ? context.stocks : context.getTxnStockSearchOptions(),
  ensureOutProductOption:()=>{},bulkOutboundStockLabel:s=>s.product+' / '+s.lot,
  autoFillTxnPrice:()=>{},toast:()=>{},refreshBulkOutboundPrice:()=>{},updateBulkOutboundAmount:()=>{}
};
vm.createContext(context);
for(const name of [
  'parseOptionalBoxCount','boxCountDisplay','availableStockForEdit','availableBoxesForEdit',
  'getTxnStockSearchOptions','stockPickerBoxLabel','refreshTxnStockPickerColumns',
  'renderTxnStockPicker','syncTxnStockPickerSelection','selectTxnStock','selectBulkOutboundStock'
]) vm.runInContext(source(name),context);

context.refreshTxnStockPickerColumns();
assert.match(elements.get('tsp-result-head').innerHTML, /<th>현재고<\/th><th>박스수<\/th>/);
context.renderTxnStockPicker();
assert.match(elements.get('tsp-result-body').innerHTML, /12 박스/);
assert.match(elements.get('tsp-result-body').innerHTML, /미기록/);
assert.match(elements.get('tsp-selected-summary').textContent, /100\.00 KG · 12 박스/);

context.selectTxnStock('A');
assert.equal(elements.get('t-weight').value, '100.00');
assert.equal(elements.get('t-box-count').value, '12');
elements.get('t-box-count').value = '5';
context.selectTxnStock('A');
assert.equal(elements.get('t-box-count').value, '5', 'Keep a manually changed box count');
context.selectTxnStock('B');
assert.equal(elements.get('t-box-count').value, '', 'Unknown box stock stays unrecorded');
const stockC = {...stockA,key:'C',lot:'LOT-C',stock:8,stockBoxes:0};
context.stocks.push(stockC);
context.selectTxnStock('C');
assert.equal(elements.get('t-box-count').value, '0', 'Recorded zero must not become blank');
context.editTxn = {stockKey:'A',weight:10,boxCount:2};
const editable = context.getTxnStockSearchOptions().find(s=>s.key==='A');
assert.equal(editable.stock, 110);
assert.equal(editable.stockBoxes, 14);
context.renderTxnStockPicker(true);
assert.match(elements.get('tsp-result-body').innerHTML, /14 박스/);

const rowFields = new Map();
for(const cls of ['.bulk-out-key','.bulk-out-box-count','.bulk-out-weight','.bulk-out-product',
  '.bulk-out-origin','.bulk-out-lot','.bulk-out-packunit','.bulk-out-proddate',
  '.bulk-out-stock','.bulk-out-stock-price','.bulk-out-location',
  '.bulk-out-origin-cell','.bulk-out-lot-cell','.bulk-out-stock-cell']) rowFields.set(cls,{value:'',textContent:'',title:''});
const row = {querySelector:cls=>rowFields.get(cls)||null};
const input = {value:'',closest:()=>row};
context.selectBulkOutboundStock(input,'A');
assert.equal(rowFields.get('.bulk-out-weight').value,'100.00');
assert.equal(rowFields.get('.bulk-out-box-count').value,'12');
context.selectBulkOutboundStock(input,'B');
assert.equal(rowFields.get('.bulk-out-box-count').value,'');

context.txnStockPickerTargetInput = {dataset:{pickerContext:'production-input'}};
context.refreshTxnStockPickerColumns();
assert.match(elements.get('tsp-result-head').innerHTML, /<th>현재고<\/th><th>박스수<\/th>/);
context.renderTxnStockPicker(true);
assert.match(elements.get('tsp-result-body').innerHTML, /12 박스/);

console.log('PASS: stock picker box display, edit availability, single and bulk outbound autofill, unknown and manual counts');
