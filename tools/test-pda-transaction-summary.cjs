// Display aggregation and actual ERP list handlers. No production requests or writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-pda-summary-'));
const index=fs.readFileSync(path.join(repo,'index.html'),'utf8');
for(const match of index.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
const pure={window:{}};vm.runInNewContext(fs.readFileSync(path.join(repo,'pda-transaction-summary.js'),'utf8'),pure);
const group=rows=>pure.window.DBMTPdaTransactionSummary.group(rows);
const first={id:'tx_pda_01',date:'2026-10-20',type:'출고',trader:'동원홈푸드',traderId:'qa-partner',product:'돈사태(작업)',labelProductId:'qa-product',lot:'L12610134894030',origin:'국내산',storage:'냉동',packunit:'3KG',proddate:'2026-10-13',stockLocation:'가공장',stockRowId:'qa-stock',stockUnitPrice:5000,weight:12,boxCount:1,price:7500,amount:90000,note:'',_isUser:true,_pdaRequestId:'qa-batch',_pdaLabelId:'qa-label-01',_pdaCode:'DB2610201200-ABC120',_pdaAction:'ship'};
const boxes=Array.from({length:20},(_,i)=>({...first,id:`tx_pda_${String(i+1).padStart(2,'0')}`,stockRowId:`qa-stock-${i%3}`,stockUnitPrice:i%2?5315:5505,proddate:i%2?'2026-10-19':'2026-10-20',expdate:i%2?'2027-10-18':'2027-10-19',stockProddate:i%2?'2026-10-19':'2026-10-20',_pdaLabelId:`qa-label-${i}`,_pdaCode:'DB2610201200-ABC1'+String(i).padStart(2,'0')}));
const original=JSON.stringify(boxes),summaries=group(boxes);
assert.equal(summaries.length,1);assert.equal(summaries[0].weight,240);assert.equal(summaries[0].boxCount,20);assert.equal(summaries[0].amount,1800000);
assert.equal(JSON.stringify(boxes),original,'Grouping must not rewrite or delete original box rows');
for(const field of ['_pdaRequestId','date','traderId','trader','product','labelProductId','packunit','lot','origin','storage','brand','factoryNo','grade','stockLocation','note','price']){
  assert.equal(group([first,{...first,id:'other',_pdaLabelId:'other',[field]:field==='price'?8000:'different'}]).length,2,`Separate different ${field}`);
}
for(const field of ['proddate','expdate','stockRowId','stockProddate','stockUnitPrice']){
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
console.log('PASS: exact weight/box/amount totals, identity boundaries, manual/receipt isolation, original row preservation and per-box rounding');
const names=['htmlEscape','jsArg','parseOptionalBoxCount','boxCountDisplay','normalizeStockLocation','getTxnStockLocation','getFilteredTransactions','transactionDisplayRows','findPdaTransactionSummary','renderTransactions','openPdaTransactionDetails','closePdaTransactionDetails','renderPdaTransactionDetails','updateTxnPrice','setTransactionListIdle','prepareTransactionList','markTransactionSearchPending','markTransactionKeywordSearchPending','validateTransactionDateRange','runTransactionSearch','runTransactionExactDateSearch','exportTransactionsCSV','printFilteredTransactions'];
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
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
    await context.route('**/*',route=>{const r=route.request();return r.method()==='GET'&&(r.url().startsWith(base)||r.url().startsWith(assets))?route.continue():route.abort();});
    await context.addInitScript(()=>{
      sessionStorage.setItem('dbmt_erp_user_session_token','qa-token');window.__saves=[];window.__fail=false;window.__toasts=[];
      window.__session={ok:true,user:{id:'qa-user',displayName:'테스트'},permissions:[{menuCode:'transactions',canView:true,canUpdate:true}]};
      window.sbRpc=async(name)=>{if(name==='dbmt_erp_session')return __session;throw Error('Unexpected RPC: '+name);};
      window.startAuthenticatedErp=async()=>{document.body.classList.remove('erp-auth-locked');};
      window.showPage=(id)=>{document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));document.getElementById(id)?.classList.add('active');};
      window.toast=message=>__toasts.push(message);
      window.saveTransactionRows=async(rows,deleted,old,options)=>{if(__fail)throw Error('QA atomic save failed');if(rows.some(row=>row._pdaSummaryRows||String(row.id).startsWith('pda-summary:')))throw Error('Must only save original boxes');__saves.push({rows:structuredClone(rows),options});};
      window.invalidateStockMap=()=>{};window.updateOutProductList=()=>{};window.loadTxnToForm=id=>{window.__editId=id;};
      window.parseAppNumber=value=>Number(value)||0;window.downloadCSV=(rows,name)=>{window.__csv={rows,name};};
      window.openA4ListPrint=(title,filters,count,table)=>{window.__print={title,filters,count,table};};
    });
    page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'fixture.html');
    for(const file of ['pda-transaction-summary.js','label-layout.js'])await page.addScriptTag({url:assets+file});
    await page.addScriptTag({content:`var userTransactions=[],transactions=[],EXCEL_TRANSACTIONS=[],transactionListQueryActive=false,pdaTransactionDetailIds=[],today='2026-10-20',STOCK_LOCATION_DEFAULT='가공장';const transactionPricePendingIds=new Set();\n${functions}`});
    await page.addScriptTag({url:assets+'m02-auth.js'});await page.waitForFunction(()=>DBMTAuth.isPersonal());
    await page.evaluate(rows=>{userTransactions=structuredClone(rows);transactions=[...userTransactions];showPage('p-transactions');prepareTransactionList();},boxes);
    assert.equal(await page.locator('#t-body tr').count(),0,'Keep render-on-search behavior');
    await page.locator('#p-transactions').getByRole('button',{name:'특정일 조회',exact:true}).click();
    assert.equal(await page.locator('#t-body tr').count(),1);assert.match(await page.locator('#t-count').textContent(),/1건.*20박스/);
    const cells=await page.locator('#t-body tr').first().locator('td').allTextContents();assert.equal(cells[6],'240.00');assert.equal(cells[7],'20');assert.equal(cells[9],'1,800,000');
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
    assert.equal(await page.locator('#t-body tr').count(),1);assert.match(await page.locator('#t-body tr td').nth(9).textContent(),/1,920,000/);
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
    assert.deepEqual(errors,[]);console.log('PASS: product/raw list/search aggregation, barcode details, atomic group price/rollback, one-box edit/split, print/CSV, read-only guards and narrow dialog');console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
