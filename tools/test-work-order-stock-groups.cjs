// Real picker/editor handlers and stock ledger; all work-order saves are fictional.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const receipts=require('./pda-raw-receipt-fixture.cjs').map(row=>({...row,price:5300,amount:Math.round(row.weight*5300)}));
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-wo-stock-groups-'));
const source=name=>{const match=html.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'));assert(match,name);return match[0];};
const block=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));
const pure={window:{}};
for(const file of ['stock-ledger.js','work-order-stock-groups.js'])vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),pure);
const group=pure.window.DBMTWorkOrderStockGroups.group,allocate=pure.window.DBMTWorkOrderStockGroups.allocate;
const stockRows=rows=>Object.entries(pure.DBMTStockLedger.calculate(rows)).map(([key,row])=>({...row,key}));
const stocks=stockRows(receipts),before=JSON.stringify({receipts,stocks}),summary=group(stocks,receipts);
assert.equal(summary.length,1);assert.equal(summary[0].stock,2313.93);assert.equal(summary[0].stockBoxes,101);
assert.equal(summary[0]._workOrderStockRows.length,10);assert.equal(summary[0].stockRowId,'');assert.equal(summary[0].proddate,'');
assert.equal(summary[0].inboundDate,'2026-10-20');
for(const field of ['date','trader','traderId','labelProductId','product','lot','price','stockLocation','origin','packunit','brand','factoryNo','grade','storage','note','stockNote']){
  const rows=receipts.slice(0,2).map(row=>({...row}));rows[1][field]=field==='price'?5301:'different';
  assert.equal(group(stockRows(rows),rows).length,2,'Separate different '+field);
}
const manual=receipts.slice(0,2).map(({_pdaRawRequestId,...row})=>row);
assert.equal(group(stockRows(manual),manual).length,2,'Ordinary inventory must not be merged');
assert.equal(group(stockRows(receipts.map(row=>({...row,type:'생산입고'}))),receipts).length,10,'Production rows remain independent');
const full=allocate(summary[0],2313.93,101);
assert.equal(full.length,10);assert.equal(full.reduce((sum,row)=>sum+Math.round(row.inputWeight*100),0),231393);
assert.equal(full.reduce((sum,row)=>sum+row.boxCount,0),101);
full.forEach(row=>{assert.equal(row.inputWeight,row.stock.stock);assert.equal(row.boxCount,row.stock.stockBoxes);});
const partial=allocate(summary[0],500,21);
assert.deepEqual(Array.from(partial,row=>row.boxCount),[4,16,1]);
assert.equal(partial.reduce((sum,row)=>sum+Math.round(row.inputWeight*100),0),50000);
partial.forEach(row=>assert(row.inputWeight>0&&row.inputWeight<=row.stock.stock));
const allBoxesPartialKg=allocate(summary[0],500,101);
assert.equal(allBoxesPartialKg.length,10);assert.equal(allBoxesPartialKg.reduce((sum,row)=>sum+row.boxCount,0),101);
assert.equal(allBoxesPartialKg.reduce((sum,row)=>sum+Math.round(row.inputWeight*100),0),50000);
assert(allocate(summary[0],500,null).every(row=>row.boxCount===null));
assert(allocate(summary[0],500,0).every(row=>row.boxCount===0));
const moreKgThanBoxSources=allocate(summary[0],500,1);
assert.equal(moreKgThanBoxSources.reduce((sum,row)=>sum+Math.round(row.inputWeight*100),0),50000);
assert.equal(moreKgThanBoxSources.reduce((sum,row)=>sum+row.boxCount,0),1);
for(const [weight,boxes] of [[0,null],[-1,null],[2313.94,101],[.001,null],[500,102],[.01,101],[500,-1]])assert.throws(()=>allocate(summary[0],weight,boxes));
assert.equal(JSON.stringify({receipts,stocks}),before,'Display grouping/allocation must not mutate stock or barcode receipts');
const unknown=group(stocks.map((row,i)=>({...row,stockBoxes:i?row.stockBoxes:null})),receipts)[0];
assert.equal(unknown.stockBoxes,null);assert.throws(()=>allocate(unknown,2313.93,101));
assert(allocate(unknown,2313.93,null).every(row=>row.boxCount===null));
// Regression: 127.84KG remains in source rows whose boxes were already used.
const currentBalances=[[338.33,14],[356.61,16],[41,0],[45.41,0],[256.55,12],[22.72,1],[16.16,0],[35.71,7],[11.44,0],[13.83,0]];
const remainingTransactions=[...receipts,...receipts.flatMap((receipt,i)=>{
  const [weight,boxCount]=currentBalances[i],used=Math.round((receipt.weight-weight)*100)/100;
  return used?[{...receipt,id:'qa-prior-use-'+i,type:'사용',weight:used,boxCount:receipt.boxCount-boxCount,stockUnitPrice:5300}]:[];
})];
const remainingStocks=stockRows(remainingTransactions),remainingBundle=group(remainingStocks,remainingTransactions)[0];
assert.equal(remainingBundle.stock,1137.76);assert.equal(remainingBundle.stockBoxes,50);
const remainingBefore=JSON.stringify({remainingTransactions,remainingStocks});
const remainingFull=allocate(remainingBundle,1137.76,50);
assert.equal(remainingFull.length,10);
remainingFull.forEach(row=>{assert.equal(Math.round(row.inputWeight*100),Math.round(row.stock.stock*100));assert.equal(row.boxCount,row.stock.stockBoxes)});
assert.equal(remainingFull.filter(row=>row.boxCount===0).reduce((sum,row)=>sum+Math.round(row.inputWeight*100),0),12784);
const completed=stockRows([...remainingTransactions,...remainingFull.map((allocation,i)=>({...allocation.stock,id:'qa-completed-use-'+i,
  date:'2026-10-20',type:'사용',weight:allocation.inputWeight,boxCount:allocation.boxCount,stockUnitPrice:5300}))]);
assert(completed.every(row=>Math.abs(row.stock)<.005&&row.stockBoxes===0),'Production consumes each source exactly, including its zero-box remainder');
for(const [weight,boxCount] of [[1000,50],[1100,1],[500,21],[127.84,0],[127.84,null]]){
  const result=allocate(remainingBundle,weight,boxCount);
  assert.equal(result.reduce((sum,row)=>sum+Math.round(row.inputWeight*100),0),Math.round(weight*100));
  if(boxCount===null)assert(result.every(row=>row.boxCount===null));
  else assert.equal(result.reduce((sum,row)=>sum+row.boxCount,0),boxCount);
  result.forEach(row=>{assert(row.inputWeight>0&&Math.round(row.inputWeight*100)<=Math.round(row.stock.stock*100));if(row.boxCount!==null)assert(row.boxCount<=row.stock.stockBoxes)});
}
assert.throws(()=>allocate(remainingBundle,1137.77,50));assert.throws(()=>allocate(remainingBundle,1137.76,51));
assert.equal(JSON.stringify({remainingTransactions,remainingStocks}),remainingBefore);
// Uneven source weights, including a 0.01KG source, must stay in bounds after rounding.
const uneven={_workOrderStockRows:[{key:'a',proddate:'2026-01-01',stock:.01,stockBoxes:0},{key:'b',proddate:'2026-01-02',stock:10,stockBoxes:3}]};
const rounded=allocate(uneven,.02,3);assert.deepEqual(Array.from(rounded,row=>[row.inputWeight,row.boxCount]),[[.01,0],[.01,3]]);
let randomState=20261119;
const randomInt=max=>{randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;return randomState%max};
for(let trial=0;trial<150;trial++){
  const sources=Array.from({length:1+randomInt(12)},(_,i)=>({key:'qa-source-'+i,proddate:'2026-01-'+String(i+1).padStart(2,'0'),stock:(1+randomInt(30000))/100,stockBoxes:randomInt(20)}));
  const capacity=sources.reduce((sum,row)=>sum+Math.round(row.stock*100),0),count=sources.reduce((sum,row)=>sum+row.stockBoxes,0);
  const target=Math.max(sources.length,1+randomInt(capacity)),wanted=randomInt(count+1);
  const result=allocate({_workOrderStockRows:sources},target/100,wanted);
  assert.equal(result.reduce((sum,row)=>sum+Math.round(row.inputWeight*100),0),target);
  assert.equal(result.reduce((sum,row)=>sum+row.boxCount,0),wanted);
  assert.equal(new Set(result.map(row=>row.stock.key)).size,result.length);
  result.forEach(row=>{assert(row.inputWeight>0&&Math.round(row.inputWeight*100)<=Math.round(row.stock.stock*100));assert(row.boxCount>=0&&row.boxCount<=row.stock.stockBoxes)});
}
console.log('PASS: 1137.76KG/50-box mixed remainders, full/partial/zero/unknown counts, per-source capacities, exact ledger posting and cent rounding');
console.log('PASS: same receipt conditions -> one 101-box choice, exact sums, date/barcode/source preservation, identity boundaries, FIFO partial/full and explicit zero/unknown boxes');
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<main></main>');});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(markup=>{const template=document.createElement('template');template.innerHTML=markup;
      for(const id of ['p-workorders','txn-stock-picker-modal'])document.body.append(template.content.querySelector('#'+id));
      document.getElementById('p-workorders').classList.add('active');
    },html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
    for(const file of ['stock-ledger.js','work-order-stock-groups.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    await page.addScriptTag({content:`
      const seed=${JSON.stringify(receipts)};
      let transactions=structuredClone(seed),userTransactions=transactions,workOrders=[],stockMap=DBMTStockLedger.calculate(transactions),busy=false;
      const STOCK_LOCATION_DEFAULT='가공장',STOCK_LOCATION_SECONDARY='물류창고',labelProducts=[],LBL_DEFAULTS={},EXCEL_TRANSACTIONS=[];
      const normalizeStockLocation=v=>v||STOCK_LOCATION_DEFAULT,stockLocationKey=v=>String(v||STOCK_LOCATION_DEFAULT),normalizeOriginName=v=>v||'';
      const parseAppNumber=v=>Number(v)||0,stockDateKey=v=>v||'',bulkOutboundKeyFromValues=(p,l,o,pack,date,price,loc,id)=>['row',encodeURIComponent(id),loc].join('|');
      const getStockMap=()=>stockMap;
      let bulkOutboundStockOptionsCacheMap=null,bulkOutboundStockOptionsCacheRows=null;
      const htmlEscape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const jsArg=v=>htmlEscape(JSON.stringify(v)),priceKey=v=>String(v??'').replace(/\\s/g,'').toLowerCase();
      const bulkOutboundSearchKey=priceKey,bulkOutboundIdentityKey=priceKey,samePriceText=(a,b)=>priceKey(a)===priceKey(b),sameOriginText=samePriceText;
      const bulkOutboundSearchText=row=>Object.values(row).join(' '),getTxnStockSearchOptions=()=>bulkOutboundStockOptions();
      const localDateString=()=> '2026-10-20',nationalPartNameForCode=()=>'',normalizeLabelProductTaxType=()=> '면세';
      const inferLabelMeatType=()=> '돼지고기',labelCrossFacilityNoticeFromText=()=>'';
      const fmtLblDate=v=>v,buildLabelBody=()=>'',labelSizeConfigByKey=()=>({widthCm:7,previewW:264,previewH:378,scale:1,label:'7x10'});
      const workOrderId=()=> 'qa-group-order',toast=()=>{},showPage=()=>{};
      window.alerts=[];window.alert=message=>alerts.push(message);
      ${['parseOptionalBoxCount','boxCountDisplay','totalRecordedBoxes','bulkOutboundStockOptions'].map(source).join('\n')}
      ${block('window.workOrderEditVersion=null;','function inferLabelMeatType(')}
      window.DBMTWorkOrders={versionFor:()=> 'qa-version',refresh:()=>Promise.resolve(),write:async row=>{workOrders=[structuredClone(row)];renderWorkOrders();}};
      ${block('let txnStockPickerRows =','function selectTxnStock(')}
      ${block('function workOrderSourceInputs(order){','// 📦 품목관리 (labelProducts)')}
      function refreshWorkOrderPreview(){}
      function resetFixture(){transactions=structuredClone(seed);stockMap=DBMTStockLedger.calculate(transactions);workOrders=[];resetWorkOrderForm();}
      initWorkOrderForm();
    `});
    for(const file of ['label-lots.js','work-order-output-lots.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    const row=i=>page.locator('#wo-source-rows .wo-source-row').nth(i);
    const open=async(i=0)=>{await row(i).locator('.wo-stock-search').fill('QA 돈등심');await row(i).locator('.wo-stock-search').press('Enter');};
    await open();assert.equal(await page.locator('#tsp-result-body tr[data-tsp-index]').count(),1);
    assert.match(await page.locator('#tsp-result-body').innerText(),/2313\.93 KG.*101 박스/s);
    for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.locator('#txn-stock-picker-modal .edit-modal').screenshot({path:path.join(artifacts,'picker-'+width+'.png')});}
    await page.locator('#tsp-search-all').press('Enter');
    assert.equal(await row(0).locator('.wo-input-weight').inputValue(),'2313.93');assert.equal(await row(0).locator('.wo-input-box-count').inputValue(),'101');
    await page.locator('#wo-product').fill('QA 생산품');
    await page.locator('#wo-editor').screenshot({path:path.join(artifacts,'editor-group.png')});
    const fullOrder=await page.evaluate(()=>collectWorkOrderForm());assert(fullOrder);
    assert.equal(fullOrder.sourceInputs.length,10);assert.equal(fullOrder.inputWeight,2313.93);assert.equal(fullOrder.inputBoxCount,101);
    fullOrder.sourceInputs.forEach(input=>{assert(!input.sourceStockKey.startsWith('wo-receipt:'));assert(input.sourceStock.stockRowId);assert(!('_workOrderStockRows' in input.sourceStock));});
    assert.equal(new Set(fullOrder.sourceInputs.map(input=>input.sourceStock.stockRowId)).size,10);
    await page.locator('#wo-save-btn').click();await page.waitForFunction(()=>workOrders.length===1&&!workOrderSaving);
    await page.evaluate(()=>editWorkOrder(workOrders[0].id));
    assert.equal(await page.locator('#wo-source-rows .wo-source-row').count(),1,'Saved group restores as one input row');
    assert.deepEqual(await page.evaluate(()=>collectWorkOrderForm().sourceInputs),fullOrder.sourceInputs,'Reopening must not change print-locked source snapshots or order');
    await row(0).locator('.wo-input-weight').fill('500');
    const keptBoxes=await page.evaluate(()=>collectWorkOrderForm());assert(keptBoxes);assert.equal(keptBoxes.inputBoxCount,101);assert.equal(keptBoxes.inputWeight,500);
    await row(0).locator('.wo-input-box-count').fill('21');
    const part=await page.evaluate(()=>collectWorkOrderForm());assert(part);assert.equal(part.inputWeight,500);assert.equal(part.inputBoxCount,21);assert.equal(part.sourceInputs.length,3);
    assert.equal(part.sourceInputs.reduce((sum,input)=>sum+Math.round(input.inputWeight*100),0),50000);
    await page.evaluate(()=>addWorkOrderSourceRow());
    await open(1);assert.equal(await page.locator('#tsp-result-body tr[data-tsp-index]').count(),0,'Every selected group member must be excluded');
    await page.evaluate(()=>closeTxnStockPicker(false));await row(0).locator('.wo-remove').click();await open(0);
    assert.equal(await page.locator('#tsp-result-body tr[data-tsp-index]').count(),1,'Removing a group releases all members');
    await page.evaluate(()=>closeTxnStockPicker(false));
    // An old order selected only one source; the remaining sources form a separate selectable group.
    await page.evaluate(()=>{resetFixture();const stock=bulkOutboundStockOptions()[0];const existing={id:'qa-legacy-partial',date:'2026-10-20',product:'QA 생산품',lot:stock.lot,inputWeight:10,
      sourceStock:workOrderStockSnapshot(stock),sourceInputs:[{sourceStockKey:stock.key,sourceStock:workOrderStockSnapshot(stock),inputWeight:10,boxCount:1}]};workOrders=[existing];editWorkOrder(existing.id);addWorkOrderSourceRow();});
    await open(1);assert.equal(await page.locator('#tsp-result-body tr[data-tsp-index]').count(),1);
    assert.equal(await page.evaluate(()=>txnStockPickerRows[0]._workOrderStockRows.length),9);
    await page.locator('#tsp-search-all').press('Enter');
    const disjoint=await page.evaluate(()=>collectWorkOrderForm());assert(disjoint);assert.equal(disjoint.sourceInputs.length,10);assert.equal(new Set(disjoint.sourceInputs.map(input=>input.sourceStock.stockRowId)).size,10);
    await page.evaluate(()=>{resetFixture();const inputs=bulkOutboundStockOptions().slice(0,2).map(stock=>{
      const snapshot=workOrderStockSnapshot(stock);delete snapshot.key;
      return {sourceStockKey:stock.key,sourceStock:snapshot,inputWeight:10,boxCount:1};});
      workOrders=[{id:'qa-old-keys',date:'2026-10-20',product:'QA 생산품',lot:seed[0].lot,inputWeight:20,sourceInputs:inputs}];
      editWorkOrder('qa-old-keys');addWorkOrderSourceRow();});
    assert.equal(await row(0).locator('.wo-input-weight').inputValue(),'20');
    await open(1);assert.equal(await page.evaluate(()=>txnStockPickerRows[0]._workOrderStockRows.length),8,'Legacy sourceStockKey-only snapshots still exclude their exact originals');
    await page.evaluate(()=>closeTxnStockPicker(false));
    await page.evaluate(()=>{resetFixture();});await open();
    await page.evaluate(()=>{const key=Object.keys(stockMap)[0];stockMap={...stockMap,[key]:{...stockMap[key],stock:stockMap[key].stock-1}};});
    await page.locator('#tsp-search-all').press('Enter');assert.equal(await row(0).locator('.wo-stock-key').inputValue(),'','Changed group data requires a fresh confirmation');
    await page.evaluate(()=>closeTxnStockPicker(false));
    await page.evaluate(()=>{resetFixture();transactions[0].note='다른 업체 스펙';stockMap=DBMTStockLedger.calculate(transactions);});await open();
    assert.equal(await page.locator('#tsp-result-body tr[data-tsp-index]').count(),2,'Different notes/specifications remain separate');
    await page.evaluate(()=>closeTxnStockPicker(false));
    await page.evaluate(records=>{resetFixture();transactions=records;userTransactions=records;stockMap=DBMTStockLedger.calculate(userTransactions);},remainingTransactions);
    await open();await page.locator('#tsp-search-all').press('Enter');
    assert.equal(await row(0).locator('.wo-input-weight').inputValue(),'1137.76');assert.equal(await row(0).locator('.wo-input-box-count').inputValue(),'50');
    await page.locator('#wo-product').fill('QA 잔량 생산품');
    const remainingOrder=await page.evaluate(()=>collectWorkOrderForm());assert(remainingOrder);assert.equal(remainingOrder.sourceInputs.length,10);
    assert.equal(remainingOrder.inputWeight,1137.76);assert.equal(remainingOrder.inputBoxCount,50);
    assert.equal(remainingOrder.sourceInputs.filter(input=>input.boxCount===0).reduce((sum,input)=>sum+Math.round(input.inputWeight*100),0),12784);
    await page.locator('#wo-save-btn').click();await page.waitForFunction(()=>workOrders.length===1&&!workOrderSaving);
    await page.evaluate(()=>editWorkOrder(workOrders[0].id));
    assert.deepEqual(await page.evaluate(()=>collectWorkOrderForm().sourceInputs),remainingOrder.sourceInputs,'Reopened mixed-box work order keeps every original source');
    await row(0).locator('.wo-input-weight').fill('1000');
    const editedRemainder=await page.evaluate(()=>collectWorkOrderForm());assert(editedRemainder);assert.equal(editedRemainder.inputWeight,1000);assert.equal(editedRemainder.inputBoxCount,50);
    await page.locator('#wo-editor').screenshot({path:path.join(artifacts,'zero-box-remainders.png')});
    assert.deepEqual(await page.evaluate(()=>seed),receipts);assert.deepEqual(errors,[]);
    console.log('PASS: real work-order popup -> one choice, keyboard selection, one editor row, original-source-only saves, immutable edit round trip, exact partial quantities/boxes, duplicate exclusion/release, legacy partial selection, stale confirmation and 1440/390px layouts');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
