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
assert.match(html, /<details class="card sm-history-card" id="sm-inbound-history">/);
assert.match(html, /<details class="card sm-history-card" id="sm-usage-history">/);

const elements = new Map();
for(const id of ['sm-inbound-from','sm-inbound-to','sm-inbound-search','sm-inbound-count','sm-inbound-body']){
  elements.set(id,{value:'',textContent:'',innerHTML:''});
}
let csv = null;
const context = {
  document:{getElementById:id=>elements.get(id)||null},
  subMaterialItems:[{id:'item-1',code:'B001',name:'포장지',spec:'30cm',unit:'매'}],
  subMaterialLots:[
    {id:'lot-old',date:'2026-09-10',lot:'B001-20260910-001',itemId:'item-1',qty:100,trader:'오래된 거래처',note:'소진된 LOT'},
    {id:'lot-new',date:'2026-10-12',lot:'B001-20261012-001',itemId:'item-1',qty:25,trader:'새 거래처',note:'<검사>'}
  ],
  subMaterialUsages:[{lotId:'lot-old',qty:100}],
  parseAppNumber:value=>Number(value)||0,
  htmlEscape:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),
  downloadCSV:(rows,name)=>{csv={rows,name};}
};
vm.createContext(context);
for(const name of ['getFilteredSubMaterialInbounds','renderSubMaterialInboundHistory',
  'clearSubMaterialInboundFilters','exportSubMaterialInboundCSV']) vm.runInContext(source(name),context);

context.renderSubMaterialInboundHistory();
assert.equal(elements.get('sm-inbound-count').textContent,'(2건)');
assert.match(elements.get('sm-inbound-body').innerHTML,/소진된 LOT/);
assert.match(elements.get('sm-inbound-body').innerHTML,/&lt;검사&gt;/);
assert(elements.get('sm-inbound-body').innerHTML.indexOf('B001-20261012-001') <
  elements.get('sm-inbound-body').innerHTML.indexOf('B001-20260910-001'));

elements.get('sm-inbound-from').value='2026-10-01';
elements.get('sm-inbound-search').value='새 거래처';
context.renderSubMaterialInboundHistory();
assert.equal(elements.get('sm-inbound-count').textContent,'(1건)');
assert.doesNotMatch(elements.get('sm-inbound-body').innerHTML,/소진된 LOT/);
context.exportSubMaterialInboundCSV();
assert.equal(csv.name,'부자재_입고이력.csv');
assert.equal(csv.rows.length,2);
assert.equal(csv.rows[1][5],'새 거래처');
context.clearSubMaterialInboundFilters();
assert.equal(elements.get('sm-inbound-count').textContent,'(2건)');
assert.equal(elements.get('sm-inbound-from').value,'');

console.log('PASS: collapsible history sections and inbound list, filtering, CSV, escaping, depleted LOT retention');
