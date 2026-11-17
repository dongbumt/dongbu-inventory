// Receipt -> work order -> completed journal -> edit/list/print/CSV/mobile.
// All data and writes are fictional; no operating account or printer is used.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-production-bundles-'));
const receipts=require('./pda-raw-receipt-fixture.cjs').map(row=>({...row,price:5300,amount:Math.round(row.weight*5300)}));
const moduleText=fs.readFileSync(path.join(root,'work-order-stock-groups.js'),'utf8');
const pure={window:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'stock-ledger.js'),'utf8'),pure);vm.runInNewContext(moduleText,pure);
const api=pure.window.DBMTWorkOrderStockGroups;
const stocks=Object.entries(pure.DBMTStockLedger.calculate(receipts)).map(([key,row])=>({...row,key}));
const bundle=api.group(stocks,receipts)[0],allocated=JSON.parse(JSON.stringify(api.allocate(bundle,1176.15,51)));
const inputs=allocated.map(({stock,inputWeight,boxCount})=>({product:stock.product,lot:stock.lot,origin:stock.origin,
  packunit:stock.packunit,proddate:stock.proddate,stockLocation:stock.stockLocation,sourceStockKey:stock.key,
  stockUnitPrice:5300,qty:inputWeight,price:5300,amount:inputWeight*5300,samsung:null,stockRowId:stock.stockRowId,stockNote:'',boxCount}));
const entry={id:'qa-completed-bundle',date:'2026/10/20',job_no:'3',job_type:'생산',note:'돈등심·QA 업체·40x50',_isUser:true,
  _labelCompletion:{workOrderId:'qa-bundle-order',lockedInputCount:inputs.length},inputs,
  outputs:[1100,25.54,30].map((qty,i)=>({product:'QA 돈등심(작업)',productId:'qa-output',labelProductId:'qa-output',
    qty,price:5395,amount:Math.round(qty*5395),boxCount:[55,4,3][i],lot:receipts[0].lot,origin:'미국산',
    proddate:'2026-10-20',stockLocation:'가공장',stockRowId:'qa-output-'+i,note:['40x50','잔량 A','잔량 B'][i]}))};
const postings=record=>[...record.inputs.map((input,i)=>({...input,id:'qa-use-'+i,_prodId:record.id,_isProdUse:true,_isUser:true,type:'사용',date:'2026-10-20',weight:input.qty})),
  ...record.outputs.map((output,i)=>({...output,id:'qa-produced-'+i,_prodId:record.id,type:'생산입고',date:'2026-10-20',weight:output.qty}))];
const snapshotBefore=JSON.stringify({receipts,entry}),grouped=api.productionInputs(entry.inputs,receipts);
assert.equal(entry.inputs.length,6);assert.equal(grouped.length,1);assert.equal(grouped[0].qty,1176.15);assert.equal(grouped[0].boxCount,51);
assert.equal(grouped[0].amount,6233595);assert.equal(grouped[0].proddate,'');assert.equal(grouped[0].stockProddate,'');
assert.equal(grouped[0]._receiptInputRows.length,6);
for(const field of ['product','lot','origin','packunit','stockLocation','stockNote','price','stockUnitPrice','samsung']){
  const changed=structuredClone(inputs);changed[0][field]=field==='price'||field==='stockUnitPrice'?6000:field==='samsung'?{vendorName:'다른 업체'}:'different';
  assert.equal(api.productionInputs(changed,receipts).length,2,'Separate different '+field);
}
const changedReceipts=structuredClone(receipts);changedReceipts.find(row=>row.stockRowId===inputs[0].stockRowId).trader='별도 매입처';
assert.equal(api.productionInputs(inputs,changedReceipts).length,2);
assert.equal(api.productionInputs(inputs.map(({stockRowId,...input})=>input),receipts).length,6,'Do not merge untracked/manual history');
const groupedUse=api.productionTransactions(postings(entry),receipts);
assert.equal(groupedUse.filter(row=>row.type==='사용').length,1);assert.equal(groupedUse[0].weight,1176.15);
assert.equal(api.productionTransactions([...postings(entry),{...postings(entry)[0],id:'other-job',_prodId:'other-job'}],receipts).filter(row=>row.type==='사용').length,2);
assert.equal(JSON.stringify({receipts,entry}),snapshotBefore);
console.log('PASS: one shared receipt rule across work-order/production shapes; six original sources -> one 1176.15KG/51-box input, exact cost and strict boundaries');
const source=name=>{const match=html.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'));assert(match,name);return match[0];};
const section=(a,b)=>{const start=html.indexOf(a),end=html.indexOf(b,start);assert(start>=0&&end>start,a);return html.slice(start,end);};
for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(script[1]);
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<main></main>');});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1500,height:1100}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(markup=>{const t=document.createElement('template');t.innerHTML=markup;
      for(const id of ['p-production','p-transactions','txn-stock-picker-modal'])document.body.append(t.content.querySelector('#'+id));
      document.getElementById('p-production').classList.add('active');
    },html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'stock-ledger.js'),'utf8')});await page.addScriptTag({content:moduleText});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'pda-transaction-summary.js'),'utf8')});
    await page.addScriptTag({content:`
      const seedReceipts=${JSON.stringify(receipts)},seedEntry=${JSON.stringify(entry)},seedPostings=${JSON.stringify(postings(entry))};
      const STOCK_LOCATION_DEFAULT='가공장',STOCK_LOCATION_SECONDARY='물류창고',SUPABASE_ENABLED_KEY='qa-enabled',today='2026-10-20',EXCEL_PROD=[],EXCEL_TRANSACTIONS=[],EXCEL_STOCK=[];
      let userProdEntries=[structuredClone(seedEntry)],userTransactions=[...structuredClone(seedReceipts),...structuredClone(seedPostings)],transactions=[...userTransactions];
      let _stockMapCache=null,stockSearchDirty=true,stockQuerySnapshot=null,localCoreRevision=0,subMaterialUsages=[],productionListQueryActive=true,sequence=0,requests=[],failed=false,allowUpdate=true;
      let labelProducts=[{id:'qa-output',name:'QA 돈등심(작업)',kind:'제품',origin:'미국산'}];
      const DBMT_PERF={record:()=>{}},DBMTAuth={isPersonal:()=>true,can:()=>allowUpdate,getSessionToken:()=> 'qa-session'};
      const toast=message=>messages.push(message),autoSetJobNo=()=>{},getPrice=()=>0,nationalPartNameForCode=()=>'',normalizeLabelProductTaxType=value=>value||'면세';
      const showPage=()=>initProdForm(),setStockExportEnabled=()=>{},openSubMaterialUsageModal=()=>{};
      const makeAppId=prefix=>prefix+'-qa-'+(++sequence);
      const safeLocalStorageSet=()=>{},normalizeLocalTransactionIds=()=>{},recordProductionChange=()=>{},gsShowSync=()=>{},syncSubMaterialUsageProductionMetadata=()=>{};
      ${source('markLocalCoreChanged')}
      const asArray=value=>value==null?[]:Array.isArray(value)?value:[value],normalizeRowsForUpsert=asArray;
      const refreshProtectedCoreAfterFailure=async()=>{userProdEntries=[structuredClone(seedEntry)];userTransactions=[...structuredClone(seedReceipts),...structuredClone(seedPostings)];transactions=[...userTransactions];invalidateStockMap();};
      const getSupabasePassword=()=> 'qa-session';window.messages=[];window.alert=value=>messages.push(value);window.confirm=()=>true;
      localStorage.setItem(SUPABASE_ENABLED_KEY,'1');
      async function sbRpc(name,body){requests.push(structuredClone({name,body}));await new Promise(resolve=>setTimeout(resolve,80));
        if(failed)throw Error('QA production bundle save failed');
        assertFlat(body.p_entry);return {ok:true,entry:structuredClone(body.p_entry),transactionRows:structuredClone(body.p_transaction_rows)};
      }
      function assertFlat(record){if(record.inputs.some(input=>!input.stockRowId||input._receiptInputRows||String(input.sourceStockKey).startsWith('wo-receipt:')))throw Error('Display bundle must never enter the ledger');}
      window.__print=null;window.__csv=null;const openA4ListPrint=(title,filters,count,table)=>window.__print=table,downloadCSV=(rows,name)=>window.__csv=rows;
      ${['localDateString','htmlEscape','jsArg','normProdDate','priceKey','priceProductKey','samePriceText','samePriceProductText','normalizeOriginName','originKey','sameOriginText','normalizeStockLocation','stockLocationKey','getTxnStockLocation','parseAppNumber','stockPriceKey','stockDateKey','stockMapKey','sameStockIdentity','getTxnUnitPrice','getStockTxnProddate','stockLedgerDateKey','parseOptionalBoxCount','boxCountDisplay','totalRecordedBoxes','getStockMap','invalidateStockMap','getProdEntryNote','getProdJobType','makeProductionTxnId','getWeightedTxnPrice','getPriceFromLot','personalServerWriteToken','assertPersonalServerResult','getFilteredProductionEntries','productionMatchesSearch','renderProduction','printFilteredProduction','exportProductionCSV','bulkOutboundIdentityKey','bulkOutboundKeyFromValues','bulkOutboundStockOptions','bulkOutboundSearchKey','bulkOutboundSearchText','bulkOutboundStockLabel'].map(source).join('\n')}
      let bulkOutboundStockOptionsCacheMap=null,bulkOutboundStockOptionsCacheRows=null;
      ${section('let prodInputRowCount = 0;','// ─── 생산일보 ─')}
      ${section('async function supabaseSaveProductionRows(','async function supabaseLoadSubMaterialUsages(')}
      ${section('let txnStockPickerRows =','function selectTxnStock(')}
      let transactionListQueryActive=true;
      ${['getFilteredTransactions','transactionDisplayRows','renderTransactions'].map(source).join('\n')}
      document.getElementById('prod-filter-date').value='2026-10-20';
      document.getElementById('t-filter-type').value='사용';renderTransactions();renderProduction();openEditProdEntry(seedEntry.id);
    `});
    assert.deepEqual(errors,[]);assert.equal(await page.locator('.production-input-row').count(),1);assert.equal(await page.locator('.production-output-row').count(),3);
    assert.equal(await page.locator('#prod-in-qty-1').inputValue(),'1176.15');assert.equal(await page.locator('#prod-in-box-count-1').inputValue(),'51');
    assert.equal(await page.locator('#prod-in-product-1').evaluate(el=>el.readOnly),true);
    assert.equal(await page.locator('#prod-body').getByText('QA 돈등심',{exact:true}).count(),1);
    assert.equal(await page.locator('#t-body tr').count(),1);assert.equal(await page.locator('#t-body .txn-list-price-input').count(),0);
    assert.equal(await page.locator('#t-body button').textContent(),'생산일보');
    await page.evaluate(()=>{printFilteredProduction();exportProductionCSV();});
    assert.equal((await page.evaluate(()=>__print)).split('QA 돈등심</td>').length-1,1);
    assert.equal((await page.evaluate(()=>__csv)).filter(row=>row[4]==='QA 돈등심').length,1);
    for(const width of [1500,390]){await page.setViewportSize({width,height:1100});await page.locator('#p-production .card').first().screenshot({path:path.join(artifacts,'editor-'+width+'.png')});}
    await page.locator('#prod-note').fill('묶음 유지 비고만 수정');await page.locator('button[onclick="saveProdEntry()"]').click();await page.waitForFunction(()=>_editProdId===null&&!productionWritePending);
    const noteSave=await page.evaluate(()=>requests.at(-1).body.p_entry);
    assert.deepEqual(noteSave.inputs,entry.inputs,'Note-only edits must retain every original field, index and amount');
    assert.deepEqual(noteSave.outputs.map(output=>output.stockRowId),entry.outputs.map(output=>output.stockRowId));
    await page.evaluate(()=>openEditProdEntry(seedEntry.id));assert.equal(await page.locator('.production-input-row').count(),1);
    await page.locator('#prod-in-qty-1').fill('1100');await page.locator('#prod-in-price-1').fill('5600');
    await page.locator('button[onclick="saveProdEntry()"]').click();await page.evaluate(()=>saveProdEntry());await page.waitForFunction(()=>_editProdId===null&&!productionWritePending);
    assert.equal(await page.evaluate(()=>requests.length),2,'Repeated save must not write the bundle twice');
    const corrected=await page.evaluate(()=>userProdEntries[0]);
    assert.equal(corrected.inputs.reduce((sum,input)=>sum+Math.round(input.qty*100),0),110000);
    assert.equal(corrected.inputs.reduce((sum,input)=>sum+input.boxCount,0),51);
    assert.equal(Math.round(corrected.inputs.reduce((sum,input)=>sum+input.amount,0)),6160000);
    corrected.inputs.forEach(input=>{const original=entry.inputs.find(row=>row.stockRowId===input.stockRowId);assert(original);for(const key of ['stockRowId','sourceStockKey','proddate','origin','lot','stockUnitPrice'])assert.equal(input[key],original[key],key);});
    assert.deepEqual(corrected.outputs.map(output=>[output.stockRowId,output.qty,output.boxCount]),entry.outputs.map(output=>[output.stockRowId,output.qty,output.boxCount]));
    assert.equal(await page.evaluate(()=>Object.values(getStockMap()).filter(row=>row.source==='입고').reduce((sum,row)=>sum+Math.round(row.stock*100),0)),121393);
    await page.evaluate(()=>{openEditProdEntry(seedEntry.id);failed=true;});await page.locator('#prod-in-qty-1').fill('1000');
    await page.locator('button[onclick="saveProdEntry()"]').click();await page.waitForFunction(()=>messages.some(message=>message.includes('QA production bundle save failed')));
    assert.equal(await page.locator('#prod-in-qty-1').inputValue(),'1000');assert.equal(await page.locator('.production-input-row').count(),1);
    await page.evaluate(()=>{failed=false;openEditProdEntry(seedEntry.id);});await page.locator('#prod-in-price-1').fill('0');await page.locator('button[onclick="saveProdEntry()"]').click();await page.waitForFunction(()=>_editProdId===null&&!productionWritePending);
    assert.equal(await page.evaluate(()=>userProdEntries[0].inputs.reduce((sum,input)=>sum+input.amount,0)),0);
    await page.evaluate(()=>{openEditProdEntry(seedEntry.id);});await page.locator('#prod-in-qty-1').fill('999999');const count=await page.evaluate(()=>requests.length);
    await page.locator('button[onclick="saveProdEntry()"]').click();assert.equal(await page.evaluate(()=>requests.length),count);
    assert.deepEqual(await page.evaluate(()=>seedReceipts),receipts,'No barcode or manufacturing-date snapshot changes');
    // Direct production entry must use the same grouped picker, not reopen separate receipt sources.
    await page.evaluate(()=>initProdForm());await page.locator('#prod-in-1 .production-picker-field button').click();
    await page.locator('#tsp-search-name').fill('QA 돈등심');assert.equal(await page.evaluate(()=>txnStockPickerRows.filter(row=>row.product==='QA 돈등심').length),1);
    await page.evaluate(()=>setTxnStockPickerIndex(txnStockPickerRows.findIndex(row=>row.product==='QA 돈등심')));
    await page.locator('#tsp-confirm').click();assert.equal(await page.locator('.production-input-row').count(),1);
    assert.equal(await page.locator('#prod-in-qty-1').inputValue(),'1137.78');
    await page.evaluate(()=>addProdInputRow());await page.locator('#prod-in-2 .production-picker-field button').click();await page.locator('#tsp-search-name').fill('QA 돈등심');
    assert.equal(await page.evaluate(()=>txnStockPickerRows.filter(row=>row.product==='QA 돈등심').length),0,'A grouped picker selection excludes every physical source');
    await page.evaluate(()=>closeTxnStockPicker(false));assert.deepEqual(errors,[]);
    console.log('PASS: six-source completion -> one editor/list/print/CSV input; exact note-only replay, grouped KG/boxes/unit-price and zero corrections, source dates/stock/output-label preservation, failed-save draft, duplicate/overstock guards and grouped direct-entry picker');
    await checkMobile(browser);
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});

async function checkMobile(browser){
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];
  await page.clock.setFixedTime(new Date('2026-10-20T12:00:00+09:00'));
  page.on('pageerror',error=>errors.push(error.message));
  const order={id:'qa-bundle-order',date:'2026-10-20',product:'QA 돈등심(작업)',inputWeight:1176.15,
    sourceInputs:entry.inputs.map(input=>({sourceStockKey:input.sourceStockKey,sourceStock:{...input,key:input.sourceStockKey,stock:input.qty,stockBoxes:input.boxCount},inputWeight:input.qty,boxCount:input.boxCount}))};
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin==='http://mobile.test'){
      const name=url.pathname==='/'?'mobile-admin.html':url.pathname.slice(1),allowed=['mobile-admin.html','stock-ledger.js','pda-transaction-summary.js','work-order-stock-groups.js','mobile-production.js','styles/mobile-production.css'];
      if(!allowed.includes(name))throw Error('Unexpected asset: '+name);
      return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(path.join(root,name),'utf8')});
    }
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'apikey,authorization,content-type','access-control-allow-methods':'POST,OPTIONS'};
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers,body:''});
    const name=url.pathname.split('/').at(-1);
    const result=name==='dbmt_mobile_admin_snapshot'?{account:{displayName:'QA'},serverTime:'2026-10-20T03:00:00Z',transactions:[...receipts,...postings(entry)],prod:[entry],appData:{}}:
      name==='dbmt_mobile_admin_work_orders'?{ok:true,orders:[order]}:name==='dbmt_mobile_admin_driver_week'?{attendance:[]}:null;
    if(!result)throw Error('Unexpected RPC: '+name);
    return route.fulfill({headers,contentType:'application/json',body:JSON.stringify(result)});
  });
  await context.addInitScript(()=>{localStorage.setItem('dbmt_mobile_admin_session_token','qa');localStorage.setItem('dbmt_mobile_admin_view','production');});
  await page.goto('http://mobile.test/');await page.locator('#production-list .row').waitFor();
  await page.locator('#prod-from').fill('2026-10-20');await page.locator('#prod-to').fill('2026-10-20');await page.evaluate(()=>renderProduction());
  assert.match(await page.locator('#production-list').innerText(),/투입: QA 돈등심 1,176\.15kg/);
  await page.locator('[data-view="transactions"]').click();await page.locator('#tx-type').selectOption('사용');
  assert.equal(await page.locator('#transaction-list .row').count(),1);assert.match(await page.locator('#transaction-list').innerText(),/1,176\.15kg/);
  await page.locator('[data-view="workorders"]').click();await page.locator('#mw-list .row').waitFor();
  assert.equal(await page.locator('#mw-list .mp-source').count(),1);assert.match(await page.locator('#mw-list summary').innerText(),/1건/);
  for(const width of [320,390,760]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  await page.screenshot({path:path.join(artifacts,'mobile-workorder.png'),fullPage:true});assert.deepEqual(errors,[]);await context.close();
  console.log('PASS: actual mobile snapshot and work-order views use the identical receipt grouping rule without changing source data');
}
