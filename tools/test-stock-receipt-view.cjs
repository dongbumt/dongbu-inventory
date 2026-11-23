// Real ledger and UI with fictional receipt/barcode sources. Every server write is mocked.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const files=['stock-ledger.js','work-order-stock-groups.js','stock-receipt-view.js'];
const receipts=require('./pda-raw-receipt-fixture.cjs').map(row=>({...row,price:5300,amount:Math.round(row.weight*5300)}));
const pure={window:{}};for(const file of files)vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),pure);
const view=pure.window.DBMTStockReceiptView,ledger=pure.DBMTStockLedger;
const stock=transactions=>ledger.rows(ledger.calculate(transactions));
const group=transactions=>view.groupRows(stock(transactions),transactions);
const receiptDate=receipts[0].date;
const original=JSON.stringify(receipts),rows=stock(receipts),rawBefore=JSON.stringify(rows),grouped=view.groupRows(rows,receipts);
assert.equal(grouped.length,1);assert.equal(grouped[0].stock,2313.93);assert.equal(grouped[0].total_in,2313.93);
assert.equal(grouped[0].stockBoxes,101);assert.equal(grouped[0]._inventoryStockRows.length,10);
assert(rows.every(row=>!row.factoryProductionDate));
assert.equal(view.displayDate(grouped[0]),receiptDate);
assert.equal(view.members(grouped[0])[0].proddate,receipts[0].proddate);
assert.equal(view.summarize(grouped).totalAmount,ledger.summarize(rows).totalAmount);
assert.equal(JSON.stringify(rows),rawBefore);assert.equal(JSON.stringify(receipts),original);
assert.equal(new Set(view.members(grouped[0]).map(row=>row.stockRowId)).size,10);
const same={...receipts[0],id:'qa-use',type:'사용',weight:38.33,boxCount:2};
const out={...receipts[1],id:'qa-out',type:'출고',weight:56.62,boxCount:3,stockUnitPrice:5300,price:9900};
const adj={...receipts[2],id:'qa-adjust',type:'재고조정',weight:-.5,boxCount:0};
const changes=[...receipts,same,out,adj],remaining=group(changes)[0];
assert.equal(remaining.stock,2218.48);assert.equal(remaining.total_use,38.33);assert.equal(remaining.total_out,56.62);
assert.equal(remaining.total_adjust,-.5);assert.equal(remaining.stockBoxes,96);
for(const key of ['total_in','total_use','total_out','total_adjust','stock'])assert.equal(Math.round(remaining[key]*100),stock(changes).reduce((sum,row)=>sum+Math.round((row[key]||0)*100),0));
for(const field of ['date','trader','traderId','labelProductId','product','lot','price','stockLocation','origin','packunit','brand','factoryNo','grade','storage','stockNote','note']){
  const changed=receipts.slice(0,2).map(row=>({...row}));changed[1][field]=field==='price'?5301:'different';
  assert.equal(group(changed).length,2,'Do not merge different '+field);
}
assert.equal(group(receipts.map(({_pdaRawRequestId,...row})=>row)).length,10,'Ordinary inbound stays independent');
assert.equal(group(receipts.map(row=>({...row,type:'생산입고'}))).length,10,'Produced stock stays independent');
assert.equal(view.filterRows(grouped,{query:receiptDate,status:'재고'}).length,1,'Search finds the displayed receipt date');
assert.equal(view.filterRows(grouped,{query:'2026-07-23',status:'재고'}).length,1,'Search finds dates within whole bundle');
assert.equal(view.filterRows(grouped,{location:'물류창고'}).length,0);
const shortage=group([...receipts.slice(0,2),{...receipts[0],type:'사용',weight:receipts[0].weight+10,boxCount:receipts[0].boxCount+1}])[0];
assert(view.hasNegative(shortage));assert(shortage.stock>0);assert.equal(shortage.stockBoxes,null);
assert.equal(view.filterRows([shortage],{status:'재고'}).length,1,'Positive group cannot conceal member shortage');
assert.equal(view.filterRows([shortage],{status:'소진'}).length,0);
const zeroWithDeficit={...shortage,stock:0};assert.equal(view.filterRows([zeroWithDeficit],{status:'재고'}).length,1);
assert.equal(view.boxText(-3),'-3');assert.equal(view.boxText(null),'박스 미기록');
assert.equal(group(receipts.map((row,i)=>({...row,boxCount:i?row.boxCount:null})))[0].stockBoxes,null);
const tiny=receipts.slice(0,2).map(row=>({...row,weight:.25,boxCount:1,price:1}));
assert.equal(group(tiny)[0].stock,.5);assert.equal(view.amount(group(tiny)[0]),0,'Sum rounded source valuations, never round aggregate again');
assert.equal(ledger.rows(ledger.calculate(receipts,{asOfDate:'2026-10-19'})).length,0);
const made={id:'qa-made',type:'생산입고',product:'QA 자체 생산품',lot:'QA-MADE',stockRowId:'qa-factory',
  date:'2026-10-21',weight:10,boxCount:2,price:0,origin:'미국산',stockLocation:'가공장'};
const laterRaw={id:'qa-later-raw',type:'입고',product:'QA 원료육',lot:'QA-LATER-RAW',stockRowId:'qa-later-raw',
  date:'2026-10-23',proddate:'2026-08-01',weight:5,boxCount:1,price:5300,origin:'미국산',stockLocation:'가공장'};
const transfer=(source,fields={})=>({...source,id:'qa-move-'+source.id,type:'재고이동',date:'2026-10-22',
  fromLocation:'가공장',toLocation:'물류창고',weight:4,boxCount:1,...fields});
const legacyMade={...made,id:'qa-legacy-made',stockRowId:'',lot:'QA-LEGACY',price:5000};
const movementRows=stock([made,transfer(made),legacyMade,transfer(legacyMade,{proddate:legacyMade.date}),
  receipts[0],transfer(receipts[0])]);
const producedRows=movementRows.filter(row=>row.product===made.product);
assert.equal(producedRows.length,4,'Both ID-based and legacy production transfer to another warehouse');
assert(producedRows.every(row=>row.factoryProductionDate===made.date),'Produced dates follow stock, including zero-cost production');
assert(producedRows.every(row=>view.displayDate(row)===made.date));
const rawMoved=movementRows.find(row=>row.stockRowId===receipts[0].stockRowId&&row.stockLocation==='물류창고');
assert(rawMoved);
assert.equal(rawMoved.proddate,receipts[0].proddate);
assert.equal(rawMoved.factoryProductionDate,undefined);
assert.equal(view.displayDate(rawMoved),receiptDate,'Transfer keeps the original receipt date');
const pooledRaw=stock([{...laterRaw,stockRowId:''},{...laterRaw,stockRowId:'',date:'2026-10-19'}]);
assert.equal(pooledRaw.length,1);
assert.equal(view.displayDate(pooledRaw[0]),'2026-10-19','Legacy pooled stock shows the earliest known receipt');
const undatedRaw=stock([{...laterRaw,date:''}])[0];
assert.equal(view.displayDate(undatedRaw),'','A missing receipt date does not fall back to the raw manufacturing date');
vm.runInNewContext(fs.readFileSync(path.join(root,'stock-report.js'),'utf8'),pure);
for(const kind of ['stock','count']){
  const report=pure.window.DBMTStockReport.buildDocument({rows:[remaining,...producedRows],kind});
  assert.match(report,/2218.48|2,218.48/);
  assert.match(report,/이력번호 \/ 입고\(생산\)일/);
  assert.match(report,/QA-RAW-LOT<span class="detail">2026-10-20<\/span>/);
  assert.match(report,/2026-10-21/);assert.doesNotMatch(report,/2026-07-23/);assert.match(report,/PDA 입고묶음/);
}
assert.match(pure.window.DBMTStockReport.buildDocument({rows:[shortage]}),/일부 부족/);
assert.match(pure.window.DBMTStockReport.buildDocument({rows:group(tiny)}),/재고금액 <strong>0원/);
console.log('PASS: 10 PDA sources -> 1 bundle, exact quantities/cost/boxes, boundaries, dates, negative/unknown boxes, raw barcode identities intact');

const names=['localDateString','normProdDate','priceKey','priceProductKey','samePriceText','samePriceProductText',
  'normalizeOriginName','originKey','sameOriginText','normalizeStockLocation','stockLocationKey','getTxnStockLocation',
  'parseAppNumber','stockPriceKey','stockDateKey','stockMapKey','sameStockIdentity','getTxnUnitPrice','getStockTxnProddate',
  'stockLedgerDateKey','parseOptionalBoxCount','boxCountDisplay','getStockMap','invalidateStockMap','htmlEscape','jsArg',
  'stockCanAdjustCurrent','stockTableColspan','setStockExportEnabled','getStockQueryFilters','stockQueryDescription','renderStock',
  'stockManagementButtons','renderStockReceiptDetails','toggleStockReceiptDetails','stockPersonalCan','applyStockPermissionState',
  'closeStockAdjust','closeStockBoxBaseline','openStockAdjust','calcStockAdjustDiff','saveStockAdjust',
  'openStockBoxBaseline','saveStockBoxBaseline','getStockExportSnapshot','exportStockCSV','stockSort'];
const functions=names.map(name=>{const found=html.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'));assert(found,name);return found[0]}).join('\n');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-stock-receipt-'));
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.abort());
    await page.setContent('<!doctype html><main></main>');
    await page.evaluate(markup=>{const template=document.createElement('template');template.innerHTML=markup;
      for(const id of ['p-stock','stock-adjust-modal','stock-box-baseline-modal'])document.querySelector('main').append(template.content.querySelector('#'+id));
      document.getElementById('p-stock').classList.add('active');
    },html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
    for(const file of [...files,'stock-report.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    await page.addScriptTag({content:`
      let userTransactions=${JSON.stringify(receipts)},transactions=[...userTransactions],EXCEL_TRANSACTIONS=[],EXCEL_STOCK=[],labelProducts=[];
      let _stockMapCache=null,stockQuerySnapshot=null,stockSearchActivated=false,stockSearchDirty=true,stockRenderTimer=null,stockSortKey='product',stockSortDir='asc';
      let canEdit=true,canView=true,writes=[],messages=[],csvResult=null;
      const STOCK_LOCATION_DEFAULT='가공장',DBMTAuth={isPersonal:()=>true,can:(section,action)=>action==='view'?canView:canEdit,getSessionToken:()=> 'fictional-session'};
      const toast=value=>messages.push(value),refreshStockLocationFilter=()=>{},activePageId=()=> 'p-stock';
      const normalizeLabelProductTaxType=value=>value,markLocalCoreChanged=()=>invalidateStockMap(),safeLocalStorageSet=()=>{};
      const makeAppId=prefix=>prefix+'-fictional',downloadCSV=(rows,name)=>{csvResult={rows,name}},renderTransactions=()=>{};
      const saveTransactionRows=async record=>{writes.push(structuredClone(record));invalidateStockMap()};
      const sbRpc=async(name,args)=>{if(name!=='dbmt_erp_save_stock_adjust')throw Error(name);writes.push(structuredClone(args.p_record));return {ok:true,transaction:args.p_record}};
      ${functions}
      renderStock();
    `});
    const summaries=page.locator('#stock-body>tr:not(.stock-receipt-details)');
    assert.equal(await summaries.count(),1);assert.match(await summaries.innerText(),/2313\.93/);assert.match(await summaries.innerText(),/101 박스/);
    const dateHeading=page.getByRole('columnheader',{name:/입고\(생산\)일/});
    assert.equal((await dateHeading.innerText()).trim(),'입고(생산)일');
    assert.equal(await summaries.locator('td').nth(5).innerText(),receiptDate);
    assert.match(await page.locator('#stock-stats').innerText(),/2,313|2313/);
    assert.equal(await page.locator('.stock-receipt-details:visible').count(),0);
    await page.getByRole('button',{name:'입고묶음 상세',exact:true}).click();
    assert.equal(await page.locator('.stock-receipt-table tbody tr').count(),10);
    assert.doesNotMatch(await page.locator('.stock-receipt-table').innerText(),/생산일|2026-07-23/);
    assert.equal(await page.getByRole('button',{name:'상세/정리',exact:true}).getAttribute('aria-expanded'),'true');
    await page.screenshot({path:path.join(artifacts,'desktop-expanded.png'),fullPage:true});
    const first=page.locator('.stock-receipt-table tbody tr').first();
    await first.getByRole('button',{name:'정리',exact:true}).click();
    assert.equal(await page.locator('#stock-adj-row-id').inputValue(),receipts[0].stockRowId);
    assert.equal(await page.locator('#stock-adj-proddate').inputValue(),receipts[0].proddate);
    assert.equal(await page.locator('#stock-adj-proddate-view').inputValue(),receiptDate);
    await page.locator('#stock-adj-actual').fill('300');await page.getByRole('button',{name:'정리 저장',exact:true}).click();
    await page.waitForFunction(()=>writes.length===1&&stockQuerySnapshot.rows[0].stock===2275.60);
    const write=await page.evaluate(()=>writes[0]);assert.equal(write.stockRowId,receipts[0].stockRowId);assert.equal(write.weight,-38.33);
    assert.equal(write.proddate,receipts[0].proddate);
    await page.getByRole('button',{name:'상세/정리',exact:true}).click();
    await first.getByRole('button',{name:'박스기준',exact:true}).click();
    const boxIdentity=JSON.parse(await page.locator('#stock-box-identity').inputValue());assert.equal(boxIdentity.stockRowId,receipts[0].stockRowId);
    await page.locator('#stock-box-actual').fill('12');await page.getByRole('button',{name:'기준 저장',exact:true}).click();
    await page.waitForFunction(()=>writes.length===2);assert.equal((await page.evaluate(()=>writes[1])).stockRowId,receipts[0].stockRowId);
    assert.equal(await page.evaluate(()=>stockQuerySnapshot.rows[0].stockBoxes),99);
    await page.evaluate(()=>exportStockCSV());
    const csv=await page.evaluate(()=>csvResult);assert.equal(csv.rows.length,2);assert.equal(csv.rows[1][13],'2275.60');assert.equal(csv.rows[1][14],'99');
    assert.equal(csv.rows[0][7],'입고(생산)일');assert.equal(csv.rows[1][7],receiptDate);
    await page.evaluate(()=>{document.getElementById('stock-search').value='2026-07-23';renderStock()});assert.equal(await summaries.count(),1);
    await page.evaluate(()=>{document.getElementById('stock-search').value='';document.getElementById('stock-as-of-date').value='2026-10-20';renderStock()});
    assert.equal(await page.locator('#stock-body .stock-adjust-btn').count(),0,'Historical details are read only');
    assert.equal(await page.evaluate(()=>stockQuerySnapshot.rows[0].stock),2313.93,'As-of view excludes later adjustments');
    await page.getByRole('button',{name:'입고묶음 상세',exact:true}).click();assert(await first.isVisible());
    await page.evaluate(()=>{document.getElementById('stock-as-of-date').value='';canEdit=false;renderStock()});
    assert.equal(await page.locator('#stock-body .stock-adjust-btn').count(),0,'No adjustment controls without permission');
    assert.equal(await page.getByRole('button',{name:'입고묶음 상세',exact:true}).count(),1);
    await page.evaluate(added=>{
      userTransactions.push(...added);invalidateStockMap();canEdit=true;renderStock();
    },[made,laterRaw]);
    const dateCells=page.locator('#stock-body>tr:not(.stock-receipt-details)>td:nth-child(6)');
    await dateHeading.click();
    assert.deepEqual(await dateCells.allTextContents(),[receiptDate,made.date,laterRaw.date]);
    await dateHeading.click();
    assert.deepEqual(await dateCells.allTextContents(),[laterRaw.date,made.date,receiptDate]);
    await page.evaluate(()=>exportStockCSV());
    assert.deepEqual((await page.evaluate(()=>csvResult)).rows.slice(1).map(row=>row[7]),[laterRaw.date,made.date,receiptDate]);
    await summaries.filter({hasText:made.product}).getByRole('button',{name:'정리',exact:true}).click();
    assert.equal(await page.locator('#stock-adj-proddate-view').inputValue(),made.date);
    assert.deepEqual(errors,[]);
    console.log('PASS: desktop one row/details, exact-source adjustment and box baseline, date search, historical/permission locks, grouped CSV');
  }finally{await browser.close()}
  console.log('Artifacts: '+artifacts);
})().catch(error=>{console.error(error);process.exitCode=1});
