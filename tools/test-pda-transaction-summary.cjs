// Display aggregation and actual ERP list handlers. No production requests or writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-pda-summary-'));
const index=fs.readFileSync(path.join(repo,'index.html'),'utf8');
for(const match of index.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
const pure={window:{}};vm.runInNewContext(fs.readFileSync(path.join(repo,'pda-transaction-summary.js'),'utf8'),pure);
const group=rows=>pure.window.DBMTPdaTransactionSummary.group(rows);
const rawReceipts=require('./pda-raw-receipt-fixture.cjs');
const first={id:'tx_pda_01',date:'2026-10-20',type:'출고',trader:'동원홈푸드',traderId:'qa-partner',product:'돈사태(작업)',labelProductId:'qa-product',lot:'L12610134894030',origin:'국내산',storage:'냉동',packunit:'3KG',proddate:'2026-10-13',stockLocation:'가공장',stockRowId:'qa-stock',stockUnitPrice:5000,weight:12,boxCount:1,price:7500,amount:90000,note:'',_isUser:true,_pdaRequestId:'qa-batch',_pdaLabelId:'qa-label-01',_pdaCode:'DB2610201200-ABC120',_pdaAction:'ship'};
const boxes=Array.from({length:20},(_,i)=>({...first,id:`tx_pda_${String(i+1).padStart(2,'0')}`,stockUnitPrice:i%2?5315:5505,proddate:i%2?'2026-10-19':'2026-10-20',expdate:i%2?'2027-10-18':'2027-10-19',stockProddate:i%2?'2026-10-19':'2026-10-20',_pdaLabelId:`qa-label-${i}`,_pdaCode:'DB2610201200-ABC1'+String(i).padStart(2,'0')}));
const original=JSON.stringify(boxes),summaries=group(boxes);
assert.equal(summaries.length,1);assert.equal(summaries[0].weight,240);assert.equal(summaries[0].boxCount,20);assert.equal(summaries[0].amount,1800000);
assert.equal(JSON.stringify(boxes),original,'Grouping must not rewrite or delete original box rows');
for(const field of ['_pdaRequestId','date','traderId','trader','product','labelProductId','packunit','lot','origin','storage','brand','factoryNo','grade','stockLocation','stockRowId','note','price']){
  assert.equal(group([first,{...first,id:'other',_pdaLabelId:'other',[field]:field==='price'?8000:'different'}]).length,2,`Separate different ${field}`);
}
for(const field of ['proddate','expdate','stockProddate','stockUnitPrice']){
  const originalRows=[first,{...first,id:'other',_pdaLabelId:'other',[field]:'different'}];
  assert.equal(group(originalRows).length,1,`Display totals across different ${field}`);
  assert.equal(group(originalRows)[0]._pdaSummaryRows[1][field],'different','Retain original source identity');
}
const manual={...first,id:'manual'};delete manual._pdaRequestId;delete manual._pdaLabelId;
assert.equal(group([manual,{...manual,id:'manual2'}]).length,2,'Never merge ordinary/manual transactions');
assert.equal(group([{...first,type:'입고'},{...first,id:'return2',type:'입고'}]).length,2,'Do not change receipt/return presentation');
const rounded=group([{...first,weight:.2,amount:1},{...first,id:'round2',weight:.2,amount:1}])[0];
assert.equal(rounded.weight,.4);assert.equal(rounded.amount,2,'Preserve individual-box amount rounding');
const many=group(Array.from({length:200},(_,i)=>({...first,id:String(i),weight:.1})))[0];assert.equal(many.weight,20);assert.equal(many.boxCount,200);
const rawBoxes=boxes.map(({_pdaRequestId,_pdaLabelId,...row},i)=>({...row,_pdaRawRequestId:_pdaRequestId,_pdaRawPackageId:_pdaLabelId,_pdaCode:'076623002060046015970094'+String(i).padStart(2,'0')}));
assert.equal(group(rawBoxes).length,1);assert.equal(group(rawBoxes)[0].weight,240);
assert.equal(group([...boxes,...rawBoxes]).length,2,'Raw and product boxes never merge even if request IDs match');
const separate=boxes.map((row,i)=>({...row,stockRowId:i<8?'stock-A':'stock-B',_productionCostSourceId:'same-original-production'}));
const receipts=[{type:'생산입고',stockRowId:'stock-A',stockNote:'3mm / A업체'},
  {type:'생산입고',stockRowId:'stock-B',stockNote:'5mm / B업체'}];
const separateBefore=JSON.stringify(separate),ledgerBefore=JSON.stringify(receipts);
const separated=pure.window.DBMTPdaTransactionSummary.group(separate,undefined,receipts);
assert.equal(separated.length,2);assert.deepEqual(Array.from(separated,row=>[row.boxCount,row.weight,row.amount]),[[8,96,720000],[12,144,1080000]]);
assert.deepEqual(Array.from(separated,pure.window.DBMTPdaTransactionSummary.note),['3mm / A업체','5mm / B업체']);
assert.equal(JSON.stringify(separate),separateBefore);assert.equal(JSON.stringify(receipts),ledgerBefore);
assert.equal(pure.window.DBMTPdaTransactionSummary.note(pure.window.DBMTPdaTransactionSummary.group([separate[0]],undefined,receipts)[0]),'3mm / A업체','A single box must also show its source note');
assert.equal(group(separate.map(row=>({...row,_pdaProvisional:true,_productionCostStatus:'pending',stockRowId:'stock_pending_'+row._pdaLabelId}))).length,1,'Temporary sources must not ungroup every provisional box');
assert.equal(group(separate.map(({_pdaRequestId,_pdaLabelId,...row})=>({...row,_pdaRawRequestId:_pdaRequestId,_pdaRawPackageId:_pdaLabelId}))).length,2,'Raw shipments also respect distinct stock rows');
const receiptBefore=JSON.stringify(rawReceipts),receiptSummary=group(rawReceipts);
assert.equal(receiptSummary.length,1);assert.equal(receiptSummary[0].weight,2313.93);assert.equal(receiptSummary[0].boxCount,101);
assert.equal(receiptSummary[0]._pdaSummaryRows.length,10);assert.equal(JSON.stringify(rawReceipts),receiptBefore);
const rawEditCalls=[],rawEditContext={findPdaTransactionSummary:()=>receiptSummary[0],userTransactions:rawReceipts,
  openPdaTransactionDetails:(...args)=>rawEditCalls.push(args)};
vm.runInNewContext(index.match(/function loadTxnToForm\([^]*?\n\}/)[0]+`\nloadTxnToForm(${JSON.stringify(receiptSummary[0].id)});`,rawEditContext);
assert.deepEqual(rawEditCalls,[[receiptSummary[0].id,'receipts']],'Aggregate form editing must open the original receipt chooser, not copy totals into the first receipt');
for(const field of ['date','trader','traderId','product','labelProductId','lot','price']){
  assert.equal(group([rawReceipts[0],{...rawReceipts[1],[field]:field==='price'?4400:'different'}]).length,2,`Raw receipts keep different ${field} separate`);
}
for(const field of ['proddate','mfgdate','expdate','stockProddate','stockRowId','_pdaRawRequestId','_pdaCode']){
  assert.equal(group([rawReceipts[0],{...rawReceipts[1],[field]:'different'}]).length,1,`Raw receipt display ignores ${field}, originals remain intact`);
}
assert.equal(group([rawReceipts[0],{...rawReceipts[1],_pdaAction:'return'}]).length,2,'Do not group return or stock-registration actions into a new receipt');
assert.equal(group([{...rawReceipts[0],amount:1},{...rawReceipts[1],amount:2}])[0].amount,3,'Sum saved receipt amounts, not rounded aggregate weight');
const mixedReceipt=group([rawReceipts[0],{...rawReceipts[1],stockLocation:'물류창고',note:'수기 메모',brand:'다른 브랜드'}])[0];
assert.equal(mixedReceipt.stockLocation,'가공장 / 물류창고');assert.equal(mixedReceipt.brand,'SWIFT / 다른 브랜드');
assert.equal(pure.window.DBMTPdaTransactionSummary.note(mixedReceipt),'수기 메모');
console.log('PASS: exact weight/box/amount totals, identity boundaries, manual/receipt isolation, original row preservation and per-box rounding');
const names=['localDateString','htmlEscape','jsArg','parseOptionalBoxCount','boxCountDisplay','normalizeStockLocation','getTxnStockLocation','getFilteredTransactions','transactionDisplayRows','findPdaTransactionSummary','renderTransactions','openPdaTransactionDetails','closePdaTransactionDetails','renderPdaTransactionDetails','updateTxnPrice','setTransactionListIdle','prepareTransactionList','markTransactionSearchPending','markTransactionKeywordSearchPending','validateTransactionDateRange','runTransactionSearch','runTransactionExactDateSearch','runTransactionAllSearch','exportTransactionsCSV','printFilteredTransactions'];
names.push('parseTransactionUnitPrice');
names.push('deleteTransaction');
const functions=names.map(name=>{const match=index.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));assert(match,`Missing ${name}`);return match[0];}).join('\n');
const template=index.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://local');
  if(url.pathname==='/fixture.html'){res.setHeader('Content-Type','text/html');res.end(template);return;}
  const file=path.resolve(repo,url.pathname.slice(1));
  if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}/`;
  const assets=process.env.DBMT_SUMMARY_TEST_BASE||base;
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Seoul'}),page=await context.newPage(),errors=[];
    await page.clock.setFixedTime(new Date('2026-10-20T12:00:00+09:00'));
    await context.route('**/*',route=>{const r=route.request();return r.method()==='GET'&&(r.url().startsWith(base)||r.url().startsWith(assets))?route.continue():route.abort();});
    await context.addInitScript(()=>{
      sessionStorage.setItem('dbmt_erp_user_session_token','qa-token');window.__saves=[];window.__fail=false;window.__toasts=[];
      window.__session={ok:true,user:{id:'qa-user',displayName:'테스트'},permissions:[{menuCode:'transactions',canView:true,canUpdate:true}]};
      window.sbRpc=async(name)=>{if(name==='dbmt_erp_session')return __session;throw Error('Unexpected RPC: '+name);};
      window.startAuthenticatedErp=async()=>{document.body.classList.remove('erp-auth-locked');};
      window.showPage=(id)=>{document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));document.getElementById(id)?.classList.add('active');};
      window.toast=message=>__toasts.push(message);
      window.saveTransactionRows=async(rows,deleted,old,options)=>{if(__fail)throw Error('QA atomic save failed');if(rows.some(row=>row._pdaSummaryRows||String(row.id).startsWith('pda-summary:')))throw Error('Must only save original boxes');__saves.push({rows:structuredClone(rows),deleted,options});};
      window.safeLocalStorageSet=(key,value)=>localStorage.setItem(key,value);
      window.invalidateStockMap=()=>{};window.updateOutProductList=()=>{};window.loadTxnToForm=id=>{window.__editId=id;};
      window.parseAppNumber=value=>Number(value)||0;window.downloadCSV=(rows,name)=>{window.__csv={rows,name};};
      window.openA4ListPrint=(title,filters,count,table)=>{window.__print={title,filters,count,table};};
    });
    page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'fixture.html');
    for(const file of ['pda-transaction-summary.js','label-layout.js'])await page.addScriptTag({url:assets+file});
    await page.addScriptTag({content:`var userTransactions=[],transactions=[],EXCEL_TRANSACTIONS=[],transactionListQueryActive=false,pdaTransactionDetailIds=[],today='2026-10-20',STOCK_LOCATION_DEFAULT='가공장',SUPABASE_ENABLED_KEY='qa_enabled';const transactionPricePendingIds=new Set();\n${functions}`});
    await page.addScriptTag({url:assets+'m02-auth.js'});await page.waitForFunction(()=>DBMTAuth.isPersonal());
    await page.evaluate(rows=>{userTransactions=structuredClone(rows);transactions=[...userTransactions];showPage('p-transactions');prepareTransactionList();},boxes);
    assert.equal(await page.locator('#t-search-date').inputValue(),'2026-10-20');
    assert.equal(await page.locator('#t-body tr').count(),1,'Show today automatically before any search button is pressed');
    assert.match(await page.locator('#t-count').textContent(),/1건.*20박스/);
    await page.locator('#p-transactions').getByRole('button',{name:'특정일 조회',exact:true}).click();
    assert.equal(await page.locator('#t-body tr').count(),1);assert.match(await page.locator('#t-count').textContent(),/1건.*20박스/);
    const row=page.locator('#t-body tr').first();assert.equal(await row.locator('.txn-col-weight').textContent(),'240.00');assert.equal(await row.locator('.txn-col-boxes').textContent(),'20');assert.equal(await row.locator('.txn-col-amount').textContent(),'1,800,000');
    assert.equal(await page.evaluate(()=>userTransactions.length),20);assert.equal(await page.evaluate(()=>__saves.length),0);
    await page.locator('#t-table').screenshot({path:path.join(artifacts,'summary.png')});
    await page.locator('#t-body').getByRole('button',{name:'박스별',exact:true}).click();
    assert.equal(await page.locator('#txn-pda-detail-body tr').count(),20);assert.match(await page.locator('#txn-pda-detail-summary').textContent(),/20박스.*240\.00.*1,800,000/);
    assert.equal(await page.locator('#txn-pda-detail-body tr').first().locator('td').first().textContent(),await page.evaluate(code=>DBMTLabelLayout.encodePrintCode(code),boxes[0]._pdaCode));
    await page.locator('#txn-pda-detail-dialog').screenshot({path:path.join(artifacts,'boxes.png')});await page.getByRole('button',{name:'박스별 내역 닫기'}).click();
    const price=page.locator('#t-body input[type="number"]');await price.fill('8000');await price.press('Tab');await page.waitForFunction(()=>__saves.length===1);
    const saved=await page.evaluate(()=>__saves[0]);assert.equal(saved.rows.length,20);assert(saved.rows.every(row=>row.price===8000&&row.amount===96000));assert.equal(saved.options.action,'수정');
    assert(saved.rows.every(row=>row.weight===12&&row.boxCount===1&&row._pdaRequestId==='qa-batch'));assert.equal(new Set(saved.rows.map(row=>row._pdaLabelId)).size,20);
    const originalById=new Map(boxes.map(row=>[row.id,row]));
    saved.rows.forEach(row=>{for(const field of ['stockRowId','stockUnitPrice','proddate','expdate','stockProddate'])assert.equal(row[field],originalById.get(row.id)[field],`Group price change preserves ${field}`);});
    assert.equal(await page.locator('#t-body tr').count(),1);assert.match(await page.locator('#t-body .txn-col-amount').textContent(),/1,920,000/);
    await page.evaluate(()=>{__fail=true;});await price.fill('9000');await price.press('Tab');await page.waitForFunction(()=>__toasts.includes('QA atomic save failed'));
    assert.equal(await price.inputValue(),'8000');assert.equal(await page.evaluate(()=>userTransactions.filter(row=>row.price===8000).length),20);await page.evaluate(()=>{__fail=false;});
    await page.locator('#t-body').getByRole('button',{name:'박스별',exact:true}).click();const one=page.locator('#txn-pda-detail-body input').first();await one.fill('8100');await one.press('Tab');await page.waitForFunction(()=>__saves.length===2);
    assert.equal(await page.evaluate(()=>__saves[1].rows.length),1,'Editing one box must not update the aggregate');assert.equal(await page.locator('#t-body tr').count(),2,'Different box prices must split the display');
    assert.equal(await page.locator('#txn-pda-detail-body tr').count(),20);assert.equal(await page.locator('[id^="txn-amt-"]').evaluateAll(els=>new Set(els.map(el=>el.id)).size===els.length),true);
    await page.getByRole('button',{name:'박스별 내역 닫기'}).click();
    await page.locator('#p-transactions').getByRole('button',{name:'인쇄',exact:true}).click();assert.equal(await page.evaluate(()=>__print.count),2);assert.equal(await page.evaluate(()=>new DOMParser().parseFromString(__print.table,'text/html').querySelectorAll('tbody tr').length),2);
    await page.locator('#p-transactions').getByRole('button',{name:'CSV 저장',exact:true}).click();assert.equal(await page.evaluate(()=>__csv.rows.length),3);assert.equal(await page.evaluate(()=>__csv.rows.slice(1).reduce((sum,row)=>sum+row[7],0)),240);
    await page.locator('#t-search-lot').fill('no-match');await page.locator('#t-search-lot').press('Enter');assert.match(await page.locator('#t-body').textContent(),/조회 결과가 없습니다/);
    await page.locator('#t-search-lot').fill('L12610134894030');await page.locator('#t-search-lot').press('Enter');assert.equal(await page.locator('#t-body tr').count(),2);
    await page.evaluate(async()=>{__session.permissions=[{menuCode:'transactions',canView:true,canUpdate:false}];await DBMTAuth.initializeSession(true);renderTransactions();});
    assert(await page.locator('#t-body input[title]').isDisabled());await page.locator('#t-body').getByRole('button',{name:'박스별',exact:true}).click();assert(await page.locator('#txn-pda-detail-body input').first().isDisabled());
    const saveCount=await page.evaluate(()=>__saves.length);await page.evaluate(()=>updateTxnPrice(userTransactions[0].id,'9999'));assert.equal(await page.evaluate(()=>__saves.length),saveCount,'Readonly direct calls must not save');
    for(const width of [1440,390]){await page.setViewportSize({width,height:900});const bounds=await page.locator('#txn-pda-detail-dialog').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=width);await page.locator('#txn-pda-detail-dialog').screenshot({path:path.join(artifacts,`boxes-${width}.png`)});}
    await page.getByRole('button',{name:'박스별 내역 닫기'}).click();
    await page.evaluate(async rows=>{__session.permissions=[{menuCode:'transactions',canView:true,canUpdate:true}];await DBMTAuth.initializeSession(true);userTransactions=structuredClone(rows);transactions=[...userTransactions];renderTransactions();},rawBoxes);
    assert.equal(await page.locator('#t-body tr').count(),1);assert.match(await page.locator('#t-count').textContent(),/20박스/);
    await page.locator('#t-body input[type="number"]').fill('8200');await page.locator('#t-body input[type="number"]').press('Tab');await page.waitForFunction(()=>__saves.length===3);
    assert.equal(await page.evaluate(()=>__saves[2].rows.length),20);assert.equal(await page.evaluate(()=>__saves[2].rows.every(row=>row._pdaRawPackageId&&!row._pdaLabelId&&row.price===8200)),true);
    await page.locator('#t-body').getByRole('button',{name:'박스별',exact:true}).click();assert.equal(await page.locator('#txn-pda-detail-body tr').first().locator('td').first().textContent(),rawBoxes[0]._pdaCode);
    await page.getByRole('button',{name:'박스별 내역 닫기'}).click();
    await page.evaluate(sample=>{
      userTransactions=[{...sample,id:'today-entry',date:'2026-10-20',product:'TODAY-ENTRY'},
        {...sample,id:'previous-entry',date:'2026-10-19',product:'PREVIOUS-ENTRY'}];
      transactions=[...userTransactions];transactionListQueryActive=false;
      ['t-search-date','t-search-from','t-search-to','t-search-product','t-search-lot','t-filter-type'].forEach(id=>document.getElementById(id).value='');
      prepareTransactionList();
    },manual);
    assert.match(await page.locator('#t-body').textContent(),/TODAY-ENTRY/);
    assert.doesNotMatch(await page.locator('#t-body').textContent(),/PREVIOUS-ENTRY/);
    await page.evaluate(()=>{document.getElementById('t-search-date').value='2026-10-19';prepareTransactionList();});
    assert.match(await page.locator('#t-body').textContent(),/PREVIOUS-ENTRY/);
    assert.doesNotMatch(await page.locator('#t-body').textContent(),/TODAY-ENTRY/);
    await page.evaluate(()=>{runTransactionAllSearch();prepareTransactionList();});
    assert.equal(await page.locator('#t-search-date').inputValue(),'','Returning to an all-dates query keeps that choice');
    assert.equal(await page.locator('#t-body tr').count(),2);
    await page.locator('#t-search-product').fill('PREVIOUS');await page.evaluate(()=>prepareTransactionList());
    assert.equal(await page.locator('#t-search-date').inputValue(),'','A keyword query must not be restricted to today');
    assert.match(await page.locator('#t-body').textContent(),/PREVIOUS-ENTRY/);
    await page.evaluate(()=>{
      document.getElementById('t-search-product').value='';document.getElementById('t-search-from').value='2026-10-19';
      document.getElementById('t-search-to').value='2026-10-20';transactionListQueryActive=false;prepareTransactionList();
    });
    assert.equal(await page.locator('#t-body tr').count(),2,'Explicit range survives menu reentry');
    await page.evaluate(()=>{transactions=[];renderTransactions();});
    assert.match(await page.locator('#t-body').textContent(),/조회 결과가 없습니다/);assert.equal(await page.locator('#t-count').textContent(),'(0건)');
    const receipt={...rawBoxes[0],id:'qa_raw_receipt',type:'입고',_pdaAction:'receive',weight:240,boxCount:20,price:4400,amount:1056000,
      _pdaRawBoxes:rawBoxes.map(row=>({id:row.id,barcode:row._pdaCode,weight:12}))};
    await page.evaluate(async row=>{
      __session.permissions=[{menuCode:'transactions',canView:true,canUpdate:true,canDelete:true}];await DBMTAuth.initializeSession(true);
      userTransactions=[row];transactions=[row];renderTransactions();localStorage.setItem(SUPABASE_ENABLED_KEY,'1');
    },receipt);
    assert.equal(await page.locator('#t-body tr').count(),1);assert.equal(await page.locator('#t-body .txn-col-boxes').textContent(),'20');
    await page.locator('#t-body').getByRole('button',{name:'박스별',exact:true}).click();
    assert.equal(await page.locator('#txn-pda-detail-body tr').count(),20);assert.match(await page.locator('#txn-pda-detail-title').textContent(),/입고/);
    assert.equal(await page.locator('#txn-pda-detail-body input').count(),0,'Package detail is read-only; receipt price is edited on the main row');
    assert.match(await page.locator('#txn-pda-detail-summary').textContent(),/20박스.*240\.00/);
    await page.locator('#txn-pda-detail-dialog').screenshot({path:path.join(artifacts,'receipt-boxes.png')});
    await page.getByRole('button',{name:'박스별 내역 닫기'}).click();
    page.on('dialog',dialog=>dialog.accept());
    await page.evaluate(()=>{__fail=true;});await page.locator('#t-body').getByRole('button',{name:'삭제',exact:true}).click();
    assert.equal(await page.evaluate(()=>userTransactions.length),1,'A rejected receipt deletion must remain visible');
    await page.evaluate(()=>{__fail=false;});const beforeDelete=await page.evaluate(()=>__saves.length);
    await page.locator('#t-body').getByRole('button',{name:'삭제',exact:true}).click();
    await page.waitForFunction(()=>userTransactions.length===0);
    assert.equal(await page.evaluate(()=>__saves.length),beforeDelete+1);assert.deepEqual(await page.evaluate(()=>__saves.at(-1).deleted),[receipt.id]);
    assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('dbmt_user_transactions'))),[]);
    // Existing source notes remain visible even when receipts are outside the date/type filter.
    await page.evaluate(({rows,sources})=>{
      userTransactions=[...sources.map((source,i)=>({...source,id:'source-'+i,date:'2026-10-19',product:'돈사태(작업)'})),...rows];
      transactions=[...userTransactions];
      for(const id of ['t-search-product','t-search-lot','t-search-from','t-search-to'])document.getElementById(id).value='';
      document.getElementById('t-search-date').value='2026-10-20';document.getElementById('t-filter-type').value='출고';
      transactionListQueryActive=true;renderTransactions();
    },{rows:separate,sources:receipts});
    assert.equal(await page.locator('#t-body tr').count(),2);
    const groupA=page.locator('#t-body tr').filter({hasText:'3mm / A업체'}),groupB=page.locator('#t-body tr').filter({hasText:'5mm / B업체'});
    assert.equal(await groupA.locator('.txn-col-boxes').innerText(),'8');assert.equal(await groupB.locator('.txn-col-boxes').innerText(),'12');
    await page.setViewportSize({width:1440,height:900});await page.locator('#t-table').screenshot({path:path.join(artifacts,'distinct-stock-notes.png')});
    const splitSaveCount=await page.evaluate(()=>__saves.length);
    await groupA.locator('input[type="number"]').fill('8400');await groupA.locator('input[type="number"]').press('Tab');
    await page.waitForFunction(count=>__saves.length===count+1,splitSaveCount);
    const splitSave=await page.evaluate(()=>__saves.at(-1).rows);
    assert.equal(splitSave.length,8);assert(splitSave.every(row=>row.stockRowId==='stock-A'&&!('_pdaStockNote' in row)));
    assert.equal(await groupB.locator('input[type="number"]').inputValue(),'7500','A group price edit must not touch the other inventory row');
    await page.locator('#p-transactions').getByRole('button',{name:'인쇄',exact:true}).click();
    assert.equal(await page.evaluate(()=>__print.count),2);assert.match(await page.evaluate(()=>__print.table),/3mm \/ A업체/);assert.match(await page.evaluate(()=>__print.table),/5mm \/ B업체/);
    await page.locator('#p-transactions').getByRole('button',{name:'CSV 저장',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>__csv.rows.filter(row=>row[1]==='출고').map(row=>row[11]).sort()),['3mm / A업체','5mm / B업체']);
    // Ten independent receipts become one display row without losing their 101 barcodes.
    await page.evaluate(rows=>{
      userTransactions=structuredClone(rows);transactions=[...userTransactions];
      document.getElementById('t-filter-type').value='입고';renderTransactions();
    },rawReceipts);
    assert.equal(await page.locator('#t-body tr').count(),1);assert.match(await page.locator('#t-count').innerText(),/1건.*101박스/);
    assert.equal(await page.locator('#t-body .txn-col-weight').innerText(),'2313.93');assert.equal(await page.locator('#t-body .txn-col-boxes').innerText(),'101');
    assert.equal(await page.evaluate(()=>JSON.stringify(userTransactions)),receiptBefore);
    await page.locator('#t-table').screenshot({path:path.join(artifacts,'raw-receipt-summary.png')});
    await page.locator('#t-body').getByRole('button',{name:'박스별',exact:true}).click();
    assert.equal(await page.locator('#txn-pda-detail-body tr').count(),101);
    assert.match(await page.locator('#txn-pda-detail-summary').innerText(),/101박스.*2313\.93/);
    assert.equal(await page.locator('#txn-pda-detail-body input').count(),0);
    const expectedCodes=rawReceipts.flatMap(row=>(row._pdaRawBoxes||[{barcode:row._pdaCode}]).map(box=>box.barcode)).sort();
    const displayedCodes=await page.locator('#txn-pda-detail-body tr td:first-child').allTextContents();
    assert.deepEqual(displayedCodes.sort(),expectedCodes);
    for(const date of ['2026-07-23','2026-07-24','2026-07-29','2026-07-30','2026-08-07'])assert.match(await page.locator('#txn-pda-detail-body').innerText(),new RegExp(date));
    await page.locator('#txn-pda-detail-dialog').screenshot({path:path.join(artifacts,'raw-receipt-boxes.png')});
    await page.locator('#txn-pda-detail-modes').getByRole('button',{name:'입고별',exact:true}).click();
    assert.equal(await page.locator('#txn-pda-detail-body tr').count(),10);assert.match(await page.locator('#txn-pda-detail-title').innerText(),/원본 입고/);
    const firstOriginalId=await page.evaluate(()=>userTransactions[0].id);
    await page.locator('#txn-pda-detail-body tr').first().getByRole('button',{name:'수정',exact:true}).click();
    assert.equal(await page.evaluate(()=>__editId),firstOriginalId,'Receipt edits target one original record, never the aggregate');
    const countBeforePrice=await page.evaluate(()=>__saves.length);
    await page.locator('#t-body input[type="number"]').fill('4400');await page.locator('#t-body input[type="number"]').press('Tab');
    await page.waitForFunction(count=>__saves.length===count+1,countBeforePrice);
    const receiptPriceSave=await page.evaluate(()=>__saves.at(-1).rows);
    assert.equal(receiptPriceSave.length,10);assert(receiptPriceSave.every(row=>row.price===4400&&!row._pdaSummaryRows));
    const rawReceiptById=new Map(rawReceipts.map(row=>[row.id,row]));
    receiptPriceSave.forEach(row=>{for(const field of ['id','weight','boxCount','stockRowId','proddate','expdate','_pdaRawBoxes','_pdaCode','_pdaRawEditRevision'])assert.deepEqual(row[field],rawReceiptById.get(row.id)[field],`Receipt bulk price keeps ${field}`);});
    const priceBeforeFailure=await page.evaluate(()=>JSON.stringify(userTransactions));
    await page.evaluate(()=>{__fail=true;});await page.locator('#t-body input[type="number"]').fill('4500');await page.locator('#t-body input[type="number"]').press('Tab');
    await page.waitForFunction(()=>!transactionPricePendingIds.size);assert.equal(await page.evaluate(()=>JSON.stringify(userTransactions)),priceBeforeFailure);
    await page.evaluate(()=>{__fail=false;});
    await page.locator('#p-transactions').getByRole('button',{name:'인쇄',exact:true}).click();assert.equal(await page.evaluate(()=>__print.count),1);
    await page.locator('#p-transactions').getByRole('button',{name:'CSV 저장',exact:true}).click();assert.equal(await page.evaluate(()=>__csv.rows.length),2);
    const readonlySaveCount=await page.evaluate(()=>__saves.length);
    await page.evaluate(async()=>{__session.permissions=[{menuCode:'transactions',canView:true,canUpdate:false,canDelete:false}];await DBMTAuth.initializeSession(true);renderTransactions();});
    assert(await page.locator('#t-body input[type="number"]').isDisabled());
    const readonlyEdit=page.locator('#t-body').getByRole('button',{name:'수정',exact:true,includeHidden:true});
    assert(!await readonlyEdit.isVisible()||await readonlyEdit.isDisabled());
    await page.evaluate(()=>updateTxnPrice(transactionDisplayRows(transactions)[0].id,'9999'));assert.equal(await page.evaluate(()=>__saves.length),readonlySaveCount);
    await page.evaluate(async()=>{__session.permissions=[{menuCode:'transactions',canView:true,canUpdate:true,canDelete:true}];await DBMTAuth.initializeSession(true);renderTransactions();});
    const beforeRawDelete=await page.evaluate(()=>__saves.length);
    await page.evaluate(()=>{__fail=true;});await page.locator('#t-body').getByRole('button',{name:'삭제',exact:true}).click();
    assert.equal(await page.evaluate(()=>userTransactions.length),10);assert.equal(await page.evaluate(()=>__saves.length),beforeRawDelete);
    await page.evaluate(()=>{__fail=false;});await page.locator('#t-body').getByRole('button',{name:'삭제',exact:true}).click();
    await page.waitForFunction(()=>!userTransactions.length);
    assert.deepEqual((await page.evaluate(()=>__saves.at(-1).deleted)).sort(),rawReceipts.map(row=>row.id).sort());
    assert.deepEqual(errors,[]);console.log('PASS: today/date/range/all/keyword queries; product/raw outbound totals; 101-box raw receipt summary and manufacturing/barcode preservation; atomic price/delete success/failure, print/CSV, permissions and narrow dialog');console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
