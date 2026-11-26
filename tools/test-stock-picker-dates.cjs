/* Fictional transactions only. Actual ledger, picker DOM and selection handlers. */
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const ledger=fs.readFileSync(path.join(root,'stock-ledger.js'),'utf8');
const stockGroups=fs.readFileSync(path.join(root,'work-order-stock-groups.js'),'utf8');
const source=name=>{const match=html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));assert(match,name);return match[0]};
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
const pdaBase={...base,product:'QA PDA 돈등심',lot:'QA-PDA-LOT',origin:'미국산',labelProductId:'qa-pda-product',
  brand:'SWIFT',type:'입고',date:'2026-11-24',price:5300,trader:'QA 공급처',traderId:'qa-supplier',_pdaAction:'receive'};
const pdaReceipt=(id,weight,boxCount,overrides={})=>({...pdaBase,id,stockRowId:id,_pdaRawRequestId:`request-${id}`,weight,boxCount,...overrides});
const pdaReceipts=[
  pdaReceipt('pda-a',25.54,1),pdaReceipt('pda-b',4.88,0,{proddate:'2026-09-03'}),pdaReceipt('pda-c',6.91,2),
  pdaReceipt('pda-other-date',1,1,{date:'2026-11-25'}),pdaReceipt('pda-other-cost',2,1,{price:5361}),
  pdaReceipt('pda-other-branch',3,1,{stockLocation:'물류창고'}),
  pdaReceipt('regular',4,1,{_pdaRawRequestId:undefined,_pdaAction:undefined})
];
const helpers=['parseAppNumber','normProdDate','priceKey','priceProductKey','samePriceText','samePriceProductText','normalizeOriginName','originKey','sameOriginText','normalizeStockLocation','stockLocationKey','getTxnStockLocation','stockPriceKey','stockDateKey','stockMapKey','sameStockIdentity','getStockMap','htmlEscape','jsArg','parseOptionalBoxCount','boxCountDisplay',
  'bulkOutboundIdentityKey','bulkOutboundKeyFromValues','bulkOutboundStockOptions','bulkOutboundShipmentStockOptions',
  'bulkOutboundSourceKey','bulkOutboundRawAvailability','bulkOutboundAvailableGroup','bulkOutboundSearchKey','bulkOutboundSearchText','bulkOutboundStockLabel','getEditingTransaction','stockOptionFromTransaction','sameBulkOutboundStockOption','outboundStockOptionsForEdit','availableStockForEdit','availableBoxesForEdit','getTxnStockSearchOptions','selectTxnStock','workOrderStockOptions'];
const pickerStart=html.indexOf('let txnStockPickerRows ='),pickerEnd=html.indexOf('function selectTxnStock(',pickerStart);
const setup=`
var userTransactions=${JSON.stringify(tx)},transactions=[...userTransactions],EXCEL_STOCK=[],labelProducts=[],STOCK_LOCATION_DEFAULT='가공장',STOCK_LOCATION_SECONDARY='물류창고',_stockMapCache=null,_editTxnId=null;
var bulkOutboundStockOptionsCacheMap=null,bulkOutboundStockOptionsCacheRows=null,bulkOutboundShipmentOptionsSource=null,bulkOutboundShipmentOptionsCache=null,notices=[];
function getTMoveFromLocation(){return ''}
function autoFillTxnPrice(){}
function ensureOutProductOption(){}
function toast(message){notices.push(message)}
${ledger}
${stockGroups}
${helpers.map(source).join('\n')}
${html.slice(pickerStart,pickerEnd)}
`;
const context=vm.createContext({});context.window=context;vm.runInContext(setup,context);
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
    closeTxnStockPicker(false);_editTxnId=null;userTransactions=rows;transactions=[...rows];_stockMapCache=null;
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

async function checkPdaBulkOutbound(page){
  await page.addScriptTag({content:`
    var EXCEL_TRANSACTIONS=[],appIdSeq=0,transactionWritePending=0,rpcCalls=[],remoteReceipts=[],rawAvailability={};
    const SUPABASE_ENABLED_KEY='qa-enabled';
    const DBMTAuth={isPersonal:()=>true,can:()=>true,getSessionToken:()=> 'qa-token'};
    localStorage.setItem(SUPABASE_ENABLED_KEY,'1');
    window.confirm=()=>true;
    function nationalPartNameForCode(){return '';}
    function normalizeLabelProductTaxType(){return '면세';}
    function gsShowSync(){}
    function renderTransactions(){}
    function updateProductList(){}
    function updateOutProductList(){}
    function markLocalCoreChanged(){invalidateStockMap();}
    function invalidateStockMap(){_stockMapCache=null;}
    function safeLocalStorageSet(){}
    function recordTransactionChange(){}
    async function refreshProtectedCoreAfterFailure(){throw Error('Unexpected save recovery');}
    async function sbRpc(name,body){
      rpcCalls.push({name,body:structuredClone(body)});
      if(name==='dbmt_erp_get_bulk_outbound_raw_stock'){
        return {ok:true,rows:body.p_sources.map(({stockRowId,stockLocation})=>{
          const source=remoteReceipts.find(row=>row.stockRowId===stockRowId&&row.stockLocation===stockLocation&&row._pdaRawRequestId);
          if(!source)throw Error('Availability lookup must use an original PDA source');
          return {stockRowId,stockLocation,availableWeight:source.weight,reservedBoxes:0,...rawAvailability[stockRowId]};
        })};
      }
      if(name!=='dbmt_erp_save_transactions')throw Error('Unexpected RPC '+name);
      for(const row of body.p_rows){
        const source=remoteReceipts.find(receipt=>receipt.stockRowId===row.stockRowId&&receipt.stockLocation===row.stockLocation);
        if(!source||row.stockUnitPrice!==source.price||row.stockProddate!==source.proddate)throw Error('Original stock identity changed');
      }
      return {ok:true};
    }
    ${['asArray','makeAppId','ensureUniqueRowIds','normalizeRowsForUpsert','personalServerWriteToken','assertPersonalServerResult','confirmBulkOutboundStockGroup',
      'supabaseSaveTransactionRows','saveTransactionRows','parseTransactionUnitPrice','buildBulkOutboundTransactions','saveBulkOutbound'].map(source).join('\n')}
  `});
  async function reset(){
    await page.evaluate(rows=>{
      closeTxnStockPicker(false);remoteReceipts=rows;userTransactions=structuredClone(rows);transactions=[...userTransactions];
      invalidateStockMap();rawAvailability={};rpcCalls=[];notices=[];clearBulkOutbound();
      document.getElementById('bulk-out-date').value='2026-11-26';
    },pdaReceipts);
  }
  const row=i=>page.locator('#bulk-outbound-tbody > tr').nth(i);
  const choices=page.locator('#tsp-result-body tr[data-tsp-index]');
  const bundle=choices.filter({hasText:'37.33 KG'});
  async function open(i){
    await row(i).locator('.bulk-out-stock-search button').click();
    await page.locator('#tsp-search-all').fill('QA-PDA-LOT');
  }
  async function selectBundle(i){
    await open(i);await bundle.click();await page.locator('#tsp-confirm').click();
    await page.waitForFunction(index=>Boolean(document.querySelectorAll('.bulk-out-weight')[index]?.value),i,{timeout:5000});
  }
  const calls=()=>page.evaluate(()=>rpcCalls);
  const writes=async()=>(await calls()).filter(call=>call.name==='dbmt_erp_save_transactions');
  await reset();
  await open(0);
  assert.equal(await choices.count(),5,'Only the matching PDA receipts collapse into a single picker row');
  assert.deepEqual(await choices.evaluateAll(rows=>rows.map(row=>Array.from(row.cells).slice(4,9).map(cell=>cell.innerText)).sort()),[
    ['2026-11-24','5,300원','가공장','37.33 KG','3 박스'],['2026-11-24','5,300원','가공장','4.00 KG','1 박스'],
    ['2026-11-24','5,300원','물류창고','3.00 KG','1 박스'],['2026-11-24','5,361원','가공장','2.00 KG','1 박스'],
    ['2026-11-25','5,300원','가공장','1.00 KG','1 박스']
  ].sort());
  await page.evaluate(()=>closeTxnStockPicker(false));
  // Single-entry selection keeps its individual source rows.
  await page.evaluate(()=>openTxnStockPicker('QA-PDA-LOT'));
  assert.equal(await choices.count(),7);
  await page.evaluate(()=>closeTxnStockPicker(false));
  await selectBundle(0);
  assert.equal(await row(0).locator('.bulk-out-weight').inputValue(),'37.33');
  assert.equal(await row(0).locator('.bulk-out-box-count').inputValue(),'3');
  const reads=await calls();
  assert.equal(reads.length,1);
  assert.equal(reads[0].name,'dbmt_erp_get_bulk_outbound_raw_stock');
  assert.deepEqual(reads[0].body.p_sources.map(row=>[row.stockRowId,row.stockLocation]).sort(),[
    ['pda-a','가공장'],['pda-b','가공장'],['pda-c','가공장']
  ]);
  await open(1);assert.equal(await choices.count(),4,'Another draft row already selected the bundle');
  await page.evaluate(()=>closeTxnStockPicker(false));
  await open(0);assert.equal(await bundle.count(),1,'The current draft row retains its bundle');
  await page.evaluate(()=>closeTxnStockPicker(false));
  await row(0).locator('button.btn-danger').click();await open(1);assert.equal(await bundle.count(),1,'Removing the row releases the bundle');
  await page.evaluate(()=>closeTxnStockPicker(false));

  // The picker cannot apply a stale bundle to two rows.
  await open(1);await page.locator('#tsp-search-all').fill('37.33');
  await page.evaluate(()=>{
    const selected=txnStockPickerRows[txnStockPickerIndex];
    selectBulkOutboundStock(document.querySelector('.bulk-out-stock-input'),selected.key,selected,selected);
  });
  await page.locator('#tsp-confirm').click();
  assert.equal(await row(1).locator('.bulk-out-key').inputValue(),'');
  await page.evaluate(()=>closeTxnStockPicker(false));

  await reset();await selectBundle(0);
  await row(0).locator('.bulk-out-trader').fill('QA 거래처');
  await row(0).locator('.bulk-out-price-input').fill('7553');
  await page.evaluate(()=>{rawAvailability={'pda-a':{availableWeight:19.99,reservedBoxes:1}};});
  await page.evaluate(()=>saveBulkOutbound());
  assert.equal((await writes()).length,0,'A fresh availability check blocks excess draft weight before any write');
  assert.equal(await row(0).locator('.bulk-out-weight').inputValue(),'37.33','A rejected save retains the draft');
  assert.equal((await calls()).filter(call=>call.name==='dbmt_erp_get_bulk_outbound_raw_stock').length,2);

  await reset();
  await page.evaluate(()=>{rawAvailability={'pda-a':{availableWeight:19.99,reservedBoxes:1}};});
  await selectBundle(0);
  assert.equal(await row(0).locator('.bulk-out-weight').inputValue(),'31.78','Autofill accounts for current barcode-reserved weight');
  assert.equal(await row(0).locator('.bulk-out-box-count').inputValue(),'2');
  await row(0).locator('.bulk-out-trader').fill('QA 거래처');
  await row(0).locator('.bulk-out-price-input').fill('7553');
  await page.evaluate(()=>saveBulkOutbound());
  const reservedWrites=await writes();
  assert.equal(reservedWrites.length,1,'A reserved bundle still saves its free part once');
  const freeRows=reservedWrites[0].body.p_rows;
  assert.equal(freeRows.reduce((sum,tx)=>sum+Math.round(tx.weight*100),0),3178);
  assert.equal(freeRows.reduce((sum,tx)=>sum+tx.boxCount,0),2);
  assert.equal(freeRows.find(tx=>tx.stockRowId==='pda-a')?.weight,19.99);
  assert.notEqual(freeRows.find(tx=>tx.stockRowId==='pda-a')?.boxCount,1,'A reserved barcode box stays on its original stock');

  await reset();await selectBundle(0);
  await row(0).locator('.bulk-out-trader').fill('QA 거래처');
  await row(0).locator('.bulk-out-price-input').fill('7553');
  await page.evaluate(()=>saveBulkOutbound());
  const saved=await writes();
  assert.equal(saved.length,1,'All original sources go through one existing bulk write RPC');
  assert.deepEqual(saved[0].body.p_delete_ids,[]);
  const savedRows=saved[0].body.p_rows;
  assert.deepEqual(savedRows.map(row=>[row.stockRowId,row.weight,row.boxCount]).sort(),[['pda-a',25.54,1],['pda-b',4.88,0],['pda-c',6.91,2]]);
  assert.equal(new Set(savedRows.map(row=>row.id)).size,3);
  assert(savedRows.every(row=>row.price===7553&&row.trader==='QA 거래처'&&row.type==='출고'&&row.stockLocation==='가공장'));
  assert.equal(savedRows.reduce((sum,row)=>sum+row.amount,0),281953,'Split sales amounts add up to the form amount');
  const remaining=await page.evaluate(()=>Object.values(getStockMap()).filter(row=>row.stockRowId?.startsWith('pda-')&&['pda-a','pda-b','pda-c'].includes(row.stockRowId)).map(row=>[row.stock,row.stockBoxes]));
  assert.deepEqual(remaining,[[0,0],[0,0],[0,0]],'The ledger deducts the submitted original sources exactly');
  console.log('PASS: PDA outbound groups, boundaries, picker reservations, fresh barcode availability, exact per-source bulk write with mocked RPC');
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
    const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url()==='https://dbmt-qa.invalid/'
      ? route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><meta charset="utf-8"><body></body></html>'}) : route.abort());
    await page.goto('https://dbmt-qa.invalid/');
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
    await checkPdaBulkOutbound(page);
    assert.deepEqual(errors,[]);
    console.log('PASS: separate raw receipt dates, preserved production dates/identities, transfers, legacy aggregates, unknown dates, date search, raw selection weight/boxes and fully consumed edit restoration');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
