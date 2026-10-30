/* Fictional transactions only. Actual ledger, picker DOM and selection handlers. */
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const ledger=fs.readFileSync(path.join(root,'stock-ledger.js'),'utf8');
const source=name=>{const match=html.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));assert(match,name);return match[0]};
const base={product:'가상 냉장돈안심',lot:'L12610121938001',origin:'국내산',packunit:'벌크',proddate:'2026-09-01',stockLocation:'가공장'};
const tx=[
  {...base,id:'raw1',stockRowId:'raw1',type:'입고',date:'2026-10-10',price:7300,weight:27.86,boxCount:3},
  {...base,id:'raw2',stockRowId:'raw2',type:'입고',date:'2026-10-11',price:7500,weight:38.82,boxCount:4},
  {...base,id:'raw3',stockRowId:'raw3',type:'입고',date:'2026-10-12',price:7500,weight:20.19,boxCount:2},
  {...base,id:'prod',stockRowId:'prod',type:'생산입고',date:'2026-10-15',proddate:'2026-10-14',product:'가상 생산품',weight:30,price:8000,boxCount:3},
  {...base,id:'move',stockRowId:'raw1',type:'재고이동',date:'2026-10-16',fromLocation:'가공장',toLocation:'물류창고',stockUnitPrice:7300,weight:7.86,boxCount:1},
  {...base,id:'old1',type:'입고',date:'2026/10/03',product:'가상 과거 원료',weight:10,price:900},
  {...base,id:'old2',type:'입고',date:'2026-10-06',product:'가상 과거 원료',weight:5,price:900},
  {...base,id:'oldmove',type:'재고이동',date:'2026-10-16',product:'가상 과거 원료',fromLocation:'가공장',toLocation:'외부창고',weight:5,price:900},
  {...base,id:'unknown',type:'재고조정',date:'2026-10-16',product:'가상 날짜 미기록',proddate:'',weight:3,price:100}
];
const helpers=['parseAppNumber','normProdDate','priceKey','priceProductKey','samePriceText','samePriceProductText','normalizeOriginName','originKey','sameOriginText','normalizeStockLocation','stockLocationKey','getTxnStockLocation','stockPriceKey','stockDateKey','stockMapKey','sameStockIdentity','getStockMap','htmlEscape','jsArg','parseOptionalBoxCount','boxCountDisplay',
  'bulkOutboundIdentityKey','bulkOutboundKeyFromValues','bulkOutboundStockOptions','bulkOutboundSearchKey','bulkOutboundSearchText','bulkOutboundStockLabel','getEditingTransaction','stockOptionFromTransaction','sameBulkOutboundStockOption','outboundStockOptionsForEdit','availableStockForEdit','availableBoxesForEdit','getTxnStockSearchOptions','selectTxnStock'];
const pickerStart=html.indexOf('let txnStockPickerRows ='),pickerEnd=html.indexOf('function selectTxnStock(',pickerStart);
const setup=`
var userTransactions=${JSON.stringify(tx)},EXCEL_STOCK=[],labelProducts=[],STOCK_LOCATION_DEFAULT='가공장',_stockMapCache=null,_editTxnId=null;
var bulkOutboundStockOptionsCacheMap=null,bulkOutboundStockOptionsCacheRows=null,notices=[];
function getTMoveFromLocation(){return ''}
function autoFillTxnPrice(){}
function ensureOutProductOption(){}
function toast(message){notices.push(message)}
${ledger}
${helpers.map(source).join('\n')}
${html.slice(pickerStart,pickerEnd)}
`;
const context=vm.createContext({});vm.runInContext(setup,context);
const rows=Object.values(context.getStockMap());
const find=(id,place='가공장')=>rows.find(r=>r.stockRowId===id&&r.stockLocation===place);
assert.equal(find('raw1').inboundDate,'2026-10-10');assert.equal(find('raw2').inboundDate,'2026-10-11');assert.equal(find('raw3').inboundDate,'2026-10-12');
assert.equal(find('raw1','물류창고').inboundDate,'2026-10-10','A transfer keeps the original receipt date');
assert.equal(find('raw1').proddate,'2026-09-01','Receipt dates do not overwrite manufacturing dates');
assert.equal(context.stockPickerDisplayDate(find('prod')),'2026-10-14');
assert.ok(rows.filter(r=>r.product==='가상 과거 원료').every(r=>r.inboundDate==='2026-10-03'),'Unsplit historical aggregates use the earliest known receipt');
const unpadded=Object.values(context.DBMTStockLedger.calculate([{...base,type:'입고',date:'2026-09-06',price:900,weight:5},{...base,type:'입고',date:'2026/9/3',price:900,weight:10}]));
assert.equal(unpadded[0].inboundDate,'2026-09-03','Historical unpadded dates are normalized before choosing the earliest receipt');
const before=JSON.stringify(context.userTransactions),keys=Object.keys(context.getStockMap()).sort();
context.userTransactions[0].date='2026-10-09';context._stockMapCache=null;
const changed=Object.values(context.getStockMap());assert.deepEqual(Object.keys(context.getStockMap()).sort(),keys,'Receipt dates cannot split or rekey stock');
for(const row of changed){const original=rows.find(r=>r.stockRowId===row.stockRowId&&r.stockLocation===row.stockLocation&&r.product===row.product);assert.equal(row.stock,original.stock);assert.equal(row.price,original.price);assert.equal(row.stockBoxes,original.stockBoxes)}
context.userTransactions[0].date='2026-10-10';context._stockMapCache=null;
assert.equal(JSON.stringify(context.userTransactions),before,'Read-only display metadata never writes source transactions');

async function checkBulkOutboundChoices(page){
  await page.evaluate(rows=>{
    closeTxnStockPicker(false);_editTxnId=null;userTransactions=rows;_stockMapCache=null;
    document.getElementById('p-transactions').classList.add('active');
    document.getElementById('bulk-outbound-body').style.display='block';
    document.getElementById('bulk-outbound-tbody').innerHTML='';
  },tx);
  await page.addScriptTag({content:`
    function refreshBulkOutboundPrice(){}
    function updateBulkOutboundAmount(){}
    function onBulkTraderSearch(){}
    function hideBulkTraderResults(){}
    ${['clearBulkOutboundStockSelection','onBulkOutboundStockPickerInput','handleBulkOutboundStockInputKeydown',
      'openBulkOutboundStockPicker','selectBulkOutboundStock','addBulkOutboundRow','addBulkOutboundRows',
      'removeBulkOutboundRow','clearBulkOutbound'].map(source).join('\n')}
    addBulkOutboundRows(4);
  `});
  const row=i=>page.locator('#bulk-outbound-tbody > tr').nth(i);
  const shown=()=>page.evaluate(()=>txnStockPickerRows.map(s=>[s.stockRowId||'',s.stockLocation,s.product]));
  const has=(rows,id,place='가공장')=>rows.some(r=>r[0]===id&&r[1]===place);
  async function open(i){
    await row(i).locator('.bulk-out-stock-search button').click();
    await page.locator('#tsp-search-all').fill('');
  }
  async function pickDate(i,date){
    await open(i);await page.locator('#tsp-search-location').selectOption('가공장');
    await page.locator('#tsp-search-all').fill(date);await page.locator('#tsp-confirm').click();
  }
  await pickDate(0,'2026-10-10');
  assert.equal(await row(0).locator('.bulk-out-weight').inputValue(),'20.00');
  assert.equal(await row(0).locator('.bulk-out-box-count').inputValue(),'2');
  await open(1);
  assert.ok(!has(await shown(),'raw1'),'Bulk choices exclude stock selected in another row');
  assert.ok(has(await shown(),'raw2')&&has(await shown(),'raw3'),'Distinct receipts with the same product/LOT remain selectable');
  assert.ok(has(await shown(),'raw1','물류창고'),'Other stock locations remain independently selectable');
  await page.evaluate(()=>closeTxnStockPicker(false));
  await open(0);assert.ok(has(await shown(),'raw1'),'The current bulk row retains its selection');
  await page.evaluate(()=>closeTxnStockPicker(false));
  await pickDate(1,'2026-10-11');await pickDate(2,'2026-10-12');
  await open(3);await page.locator('#tsp-search-location').selectOption('가공장');
  await page.locator('#tsp-search-all').fill('가상 냉장돈안심');
  assert.equal(await page.locator('#tsp-result-body tr[data-tsp-index]').count(),0);
  assert.equal(await page.locator('#tsp-confirm').isDisabled(),true);
  await page.evaluate(()=>closeTxnStockPicker(false));
  await row(0).locator('button.btn-danger').click();await open(2);
  assert.ok(has(await shown(),'raw1'),'Removing a bulk row releases its stock');
  await page.evaluate(()=>closeTxnStockPicker(false));
  await pickDate(0,'2026-10-10');await open(2);
  assert.ok(has(await shown(),'raw2')&&!has(await shown(),'raw1'),'Replacing a bulk stock releases the previous selection');
  await page.evaluate(()=>closeTxnStockPicker(false));
  await row(1).locator('.bulk-out-stock-input').fill('다른 재고 검색');await open(2);
  assert.ok(has(await shown(),'raw3'),'Clearing bulk search releases that stock');
  await page.evaluate(()=>closeTxnStockPicker(false));
  // Existing legacy selection keys also remain unique, without permanent source IDs.
  await open(1);await page.locator('#tsp-search-location').selectOption('가공장');
  await page.locator('#tsp-search-all').fill('가상 과거 원료');await page.locator('#tsp-confirm').click();
  await open(2);
  assert.ok(!(await shown()).some(r=>r[2]==='가상 과거 원료'&&r[1]==='가공장'));
  assert.ok((await shown()).some(r=>r[2]==='가상 과거 원료'&&r[1]==='외부창고'));
  await page.evaluate(()=>closeTxnStockPicker(false));
  await page.evaluate(()=>clearBulkOutbound());await open(1);
  assert.ok(has(await shown(),'raw1')&&has(await shown(),'raw2')&&has(await shown(),'raw3'),'Clearing the bulk form releases all stock');
  // Reject a stale displayed choice if another row acquired it while the popup was open.
  await page.locator('#tsp-search-location').selectOption('가공장');await page.locator('#tsp-search-all').fill('2026-10-11');
  await page.evaluate(()=>selectBulkOutboundStock(document.querySelector('#bulk-outbound-tbody .bulk-out-stock-input'),txnStockPickerRows[txnStockPickerIndex].key));
  await page.locator('#tsp-confirm').click();
  assert.equal(await row(1).locator('.bulk-out-key').inputValue(),'');
  assert.equal(await page.locator('#tsp-confirm').isDisabled(),true);
  await page.evaluate(()=>closeTxnStockPicker(false));
  // The single-entry picker remains independent of unsaved bulk selections.
  await page.evaluate(()=>openTxnStockPicker('2026-10-11'));
  assert.ok(has(await shown(),'raw2'));
  await page.evaluate(()=>closeTxnStockPicker(false));
  console.log('PASS: actual bulk outbound popup hides chosen stock, current-row editing, exact receipt/location and legacy keys, kg/boxes autofill, delete/replace/clear/all-clear release, stale confirmation and independent single entry');
}

async function checkProductionInputChoices(page){
  await page.evaluate(({markup,rows})=>{
    closeTxnStockPicker(false);_editTxnId=null;userTransactions=rows;_stockMapCache=null;
    const template=document.createElement('template');template.innerHTML=markup;
    document.body.append(template.content.querySelector('#p-production'));
    document.getElementById('p-production').classList.add('active');
  },{markup:html,rows:tx});
  await page.addScriptTag({content:`
    var prodInputRowCount=0;
    function updateProdOutputOriginsFromInputs(){}
    function getPriceFromLot(product,lot,origin,source,fallback){return fallback || 0;}
    ${['getProdInputStockLabel','setProdInputStockIdentityReadOnly','clearProdInputStockSelection',
      'openProdInputStockPicker','handleProdInputStockPickerKeydown','addProdInputRow','selectProdInputStock'].map(source).join('\n')}
    addProdInputRow();addProdInputRow();addProdInputRow();
  `});
  const shown=()=>page.evaluate(()=>txnStockPickerRows.map(s=>[s.stockRowId||'',s.stockLocation,s.product]));
  const has=(rows,id,place='가공장')=>rows.some(r=>r[0]===id&&r[1]===place);
  async function open(id){await page.locator(`#prod-in-${id} .production-picker-field button`).click();}
  async function pickDate(id,date){await open(id);await page.locator('#tsp-search-all').fill(date);await page.locator('#tsp-confirm').click();}

  await pickDate(1,'2026-10-10');
  assert.equal(await page.locator('#prod-in-stock-row-id-1').inputValue(),'raw1');
  assert.equal(await page.locator('#prod-in-qty-1').inputValue(),'20.00');
  assert.equal(await page.locator('#prod-in-box-count-1').inputValue(),'2');
  await open(2);
  assert.ok(!has(await shown(),'raw1'),'Selected stock is hidden from another row');
  assert.ok(has(await shown(),'raw2')&&has(await shown(),'raw3'),'Distinct receipts with the same product/LOT remain selectable');
  await page.locator('#tsp-search-location').selectOption('물류창고');
  assert.ok(has(await shown(),'raw1','물류창고'),'The same source at another location remains a separate choice');
  await page.evaluate(()=>closeTxnStockPicker(false));
  await open(1);assert.ok(has(await shown(),'raw1'),'Reopening the current row retains its own selection');
  await page.evaluate(()=>closeTxnStockPicker(false));
  await pickDate(2,'2026-10-11');await open(3);
  assert.ok(!has(await shown(),'raw1')&&!has(await shown(),'raw2')&&has(await shown(),'raw3'));
  await page.locator('#tsp-search-all').fill('2026-10-12');await page.locator('#tsp-confirm').click();
  await page.evaluate(()=>addProdInputRow());await open(4);
  await page.locator('#tsp-search-all').fill('가상 냉장돈안심');
  assert.equal(await page.locator('#tsp-result-body tr[data-tsp-index]').count(),0);
  assert.equal(await page.locator('#tsp-confirm').isDisabled(),true);
  await page.evaluate(()=>closeTxnStockPicker(false));
  await page.locator('#prod-in-1 > button.btn-danger').click();
  await open(4);assert.ok(has(await shown(),'raw1'),'Deleting the selected row releases that stock');
  await page.evaluate(()=>closeTxnStockPicker(false));
  await pickDate(2,'2026-10-10');await open(4);
  assert.ok(has(await shown(),'raw2')&&!has(await shown(),'raw1'),'Replacing a selection releases the previous stock');
  await page.evaluate(()=>closeTxnStockPicker(false));
  await page.locator('#prod-in-sel-3').fill('다른 품목 검색');await open(4);
  assert.ok(has(await shown(),'raw3'),'Clearing a selection releases that stock');
  await page.evaluate(()=>{
    closeTxnStockPicker(false);
    document.getElementById('prod-in-sel-2').dataset.stockKey='';
    userTransactions.find(t=>t.id==='raw1').price=7200;_stockMapCache=null;
  });
  await open(4);assert.ok(!has(await shown(),'raw1'),'Restored rows without a stored picker key still match by stock ID');
  await page.evaluate(()=>closeTxnStockPicker(false));
  // Existing legacy inputs may have neither a permanent source ID nor a picker key.
  await page.evaluate(()=>{document.getElementById('prod-input-rows').innerHTML='';prodInputRowCount=0;addProdInputRow();addProdInputRow();});
  await open(1);await page.locator('#tsp-search-all').fill('가상 과거 원료');await page.locator('#tsp-confirm').click();
  await page.evaluate(()=>document.getElementById('prod-in-sel-1').dataset.stockKey='');
  await open(2);
  assert.ok(!(await shown()).some(r=>r[2]==='가상 과거 원료'),'Legacy stock is matched by its full inventory identity');
  await page.locator('#tsp-search-location').selectOption('외부창고');
  assert.ok((await shown()).some(r=>r[2]==='가상 과거 원료'),'Legacy stock at another location remains selectable');
  await page.evaluate(()=>closeTxnStockPicker(false));
  // The shared picker retains the original behavior in other menus.
  for(const context of ['transaction','bulk','workorder-input']){
    await page.evaluate(context=>{
      const target=context==='transaction'?null:document.createElement('input');
      if(target){target.dataset.pickerContext=context==='bulk'?'':context;document.body.append(target);}
      openTxnStockPicker('가상 과거 원료',target);
    },context);
    assert.ok((await shown()).some(r=>r[2]==='가상 과거 원료'),context+' choices are independent of the production draft');
    await page.evaluate(()=>closeTxnStockPicker(false));
  }
  // Revalidate at confirmation if the draft changes while the popup is open.
  await page.evaluate(()=>{document.getElementById('prod-input-rows').innerHTML='';prodInputRowCount=0;addProdInputRow();addProdInputRow();});
  await open(2);await page.locator('#tsp-search-all').fill('2026-10-11');
  await page.evaluate(()=>{
    const stock=txnStockPickerRows[txnStockPickerIndex];
    selectProdInputStock(1,stock.product,stock.lot,stock.origin,stock.packunit,stock.stock,'입고',stock.price,
      stock.proddate,stock.price,stock.stockLocation,stock.key,stock.stockRowId,stock.stockNote,stock.stockBoxes);
  });
  await page.locator('#tsp-confirm').click();
  assert.equal(await page.locator('#prod-in-stock-row-id-2').inputValue(),'');
  assert.equal(await page.locator('#tsp-confirm').isDisabled(),true);
  await page.evaluate(()=>closeTxnStockPicker(false));
  console.log('PASS: production popup excludes selected stock; exact source/location/legacy identity; kg/boxes autofill; current-row selection; delete/replace/clear release; restored drafts; stale confirmation; other menus unaffected');
}
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-stock-picker-dates-'));
  try{
    const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>route.abort());
    await page.setContent('<!doctype html><html lang="ko"><meta charset="utf-8"><body></body></html>');
    await page.evaluate(markup=>{const t=document.createElement('template');t.innerHTML=markup;document.body.append(t.content.querySelector('#txn-stock-picker-modal'));document.body.append(t.content.querySelector('#p-transactions'));},html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});await page.addScriptTag({content:setup});
    await page.evaluate(()=>{document.getElementById('t-type').value='출고';openTxnStockPicker('가상 냉장돈안심');document.getElementById('tsp-search-location').value='가공장';renderTxnStockPicker(true)});
    assert.equal(await page.locator('#tsp-result-head th').nth(4).innerText(),'입고(생산)일');
    assert.deepEqual(await page.locator('#tsp-result-body tr').evaluateAll(nodes=>nodes.map(row=>row.cells[4].textContent)),['2026-10-10','2026-10-11','2026-10-12']);
    await page.screenshot({path:path.join(artifacts,'receipt-dates.png'),fullPage:true});
    await page.locator('#tsp-search-all').fill('2026-10-11');assert.equal(await page.locator('#tsp-result-body tr[data-tsp-index]').count(),1);
    await page.locator('#tsp-confirm').click();
    assert.equal(await page.locator('#t-proddate').inputValue(),'2026-09-01','Selecting a receipt date must not change the stock manufacturing identity');
    assert.equal(await page.locator('#t-weight').inputValue(),'38.82');assert.equal(await page.locator('#t-box-count').inputValue(),'4');
    await page.evaluate(()=>openTxnStockPicker('가상 생산품'));
    assert.equal(await page.locator('#tsp-result-body tr td').nth(4).innerText(),'2026-10-14');
    await page.evaluate(()=>openTxnStockPicker('가상 날짜 미기록'));assert.equal(await page.locator('#tsp-result-body tr td').nth(4).innerText(),'-');
    // A fully consumed inbound source stays dated when its outbound transaction is edited.
    await page.evaluate(()=>{closeTxnStockPicker(false);userTransactions.push({...userTransactions[1],id:'sale',date:'2026-10-17',type:'출고',price:10000,stockUnitPrice:7500,stockProddate:'2026-09-01'});_stockMapCache=null;_editTxnId='sale';openTxnStockPicker('2026-10-11')});
    assert.equal(await page.locator('#tsp-result-body tr[data-tsp-index]').count(),1);assert.equal(await page.locator('#tsp-result-body tr td').nth(4).innerText(),'2026-10-11');
    assert.match(await page.locator('#tsp-result-body').innerText(),/38.82 KG/);
    // The same shared picker is used by production/work-order input rows.
    await page.evaluate(()=>{closeTxnStockPicker(false);_editTxnId=null;const target=document.createElement('input');target.dataset.pickerContext='production-input';document.body.append(target);openTxnStockPicker('가상 냉장돈안심',target)});
    assert.equal(await page.locator('#tsp-result-head th').nth(7).innerText(),'입고(생산)일');assert.ok((await page.locator('#tsp-result-body').innerText()).includes('2026-10-10'));
    await checkProductionInputChoices(page);
    await checkBulkOutboundChoices(page);
    assert.deepEqual(errors,[]);
    console.log('PASS: separate raw receipt dates, preserved production dates/identities, transfers, legacy aggregates, unknown dates, date search, raw selection weight/boxes and fully consumed edit restoration');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
