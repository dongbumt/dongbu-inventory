// Refresh actual ERP handlers against a fake RPC; never send business writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-inventory-refresh-'));
const names=['inventoryRefreshBlocked','refreshTransactionList','refreshInventoryStock','refreshProductionList','refreshInventoryData','saveTransactionRows','markLocalCoreChanged','assertPersonalServerResult'];
names.push('stockLedgerDateKey','normProdDate');
names.push('stockManagementButtons','renderStockReceiptDetails','toggleStockReceiptDetails');
names.push('localDateString','htmlEscape','jsArg','parseAppNumber','parseOptionalBoxCount','boxCountDisplay','normalizeStockLocation','getTxnStockLocation','transactionDisplayRows','renderTransactions','exportTransactionsCSV','printFilteredTransactions','getStockMap','getKnownStockLocations','stockLocationOptionsHtml','refreshStockLocationFilter','stockCanAdjustCurrent','stockPersonalCan','applyStockPermissionState','closeStockAdjust','closeStockBoxBaseline','setStockExportEnabled','getStockQueryFilters','stockQueryDescription','renderStock');
names.push('renderProduction','setProductionListIdle','getFilteredProductionEntries','productionMatchesSearch','productionDisplayInputs','productionStockNoteHtml','productionStockNote','productionLegacySamsung','getProdJobType','getProdEntryNote','totalRecordedBoxes','validateProductionDateRange');
const searchSource=html.slice(html.indexOf('let transactionListQueryActive = false;'),html.indexOf('function renderTransactions(){'));
assert.match(searchSource,/function runTransactionSearch\(/);
const functions=names.map(name=>{const match=html.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'));assert(match,name);return match[0];}).concat(searchSource).join('\n');new vm.Script(functions);
const auth=fs.readFileSync(path.join(root,'m02-auth.js'),'utf8');
assert.match(auth,/refreshTransactionList:\['transactions','view'\]/);assert.match(auth,/refreshInventoryStock:\['stock','view'\]/);
assert.match(auth,/refreshProductionList:\['production','view'\]/);
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://local').pathname;
  if(pathname==='/fixture'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><main></main>');return;}
  const file=path.resolve(root,pathname.slice(1));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.svg')?'image/svg+xml':'text/plain');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'Asia/Seoul'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await page.evaluate(markup=>{
      const template=document.createElement('template');template.innerHTML=markup;
      for(const id of ['p-transactions','p-stock','p-production'])document.querySelector('main').append(template.content.querySelector('#'+id));
      for(const id of ['stock-adjust-modal','stock-box-baseline-modal'])document.body.append(template.content.querySelector('#'+id));
    },html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'stock-ledger.js'),'utf8')});
    for(const file of ['work-order-stock-groups.js','stock-receipt-view.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'pda-transaction-summary.js'),'utf8')});
    await page.addScriptTag({content:`
      const seed={id:'qa-old',date:'2026-11-11',type:'입고',product:'기존 품목',lot:'OLD',stockLocation:'가공장',stockRowId:'qa-old-stock',weight:10,boxCount:1,price:1000};
      const incoming={id:'qa-pda',date:'2026-11-11',type:'입고',product:'목전지',lot:'903024600808',stockLocation:'가공장',stockRowId:'qa-pda-stock',weight:349.89,boxCount:20,price:4400};
      const finished={id:'qa-new-prod',date:'2026-11-11',job_no:7,inputs:[],outputs:[{product:'새 가상 생산품',lot:'QA-PROD',qty:40,price:1000,boxCount:4}]};
      let userTransactions=[{...seed}],transactions=[...userTransactions],userProdEntries=[{id:'qa-old-prod'}],EXCEL_TRANSACTIONS=[];
      let _editTxnId=null,_editProdId=null,transactionWritePending=0,productionWritePending=0,labelProductionRefreshPromise=null,inventoryRefreshPromise=null,localCoreRevision=0;
      let productionListQueryActive=false,stockSearchActivated=false,_stockMapCache=null;
      const EXCEL_PROD=[],subMaterialUsages=[];
      const STOCK_LOCATION_DEFAULT='가공장',STOCK_LOCATION_SECONDARY='물류창고',EXCEL_STOCK=[],labelProducts=[];
      let stockSortKey='product',stockSortDir='asc',stockSearchDirty=true,stockQuerySnapshot=null;
      const SUPABASE_ENABLED_KEY='qa-enabled';localStorage.setItem(SUPABASE_ENABLED_KEY,'1');
      const control={token:'qa-session',personal:true,allowed:true,permittedMenu:'',delay:80,writeDelay:100,fail:false,shape:false,remote:[seed,incoming],prod:[{id:'qa-new-prod'}]};
      const DBMTAuth={isPersonal:()=>control.personal,can:(menu,action)=>control.allowed&&(!control.permittedMenu||(menu===control.permittedMenu&&action==='view')),getSessionToken:()=>control.token};
      const today='2026-11-23';
      let active='p-transactions',calls=[],messages=[],cached={},rendered=[],printed=null,csv=null;
      const activePageId=()=>active,toast=value=>messages.push(value),safeLocalStorageSet=(key,value)=>cached[key]=value;
      const openA4ListPrint=(title,filters,count,table)=>printed={title,filters,count,table},downloadCSV=rows=>csv=rows;
      const invalidateStockMap=()=>{_stockMapCache=null;},recordTransactionChange=()=>{},save=()=>{throw Error('Must not write a full ERP payload');};
      async function supabaseSaveTransactionRows(){await new Promise(resolve=>setTimeout(resolve,control.writeDelay));}
      async function sbRpc(name,body){
        if(name!=='dbmt_erp_get_inventory_snapshot')throw Error('Unexpected RPC: '+name);
        calls.push(structuredClone(body));const remote=structuredClone(control.remote),prod=structuredClone(control.prod);
        if(control.hold){control.hold=false;await new Promise(resolve=>{control.release=resolve;});}
        else await new Promise(resolve=>setTimeout(resolve,control.delay));
        if(control.fail)throw Error('QA refresh network error');return control.shape?{ok:true}:{ok:true,transactions:remote,prod};
      }
      function show(id){active=id;document.querySelectorAll('.tab-panel').forEach(el=>el.classList.toggle('active',el.id===id));}
      ${functions}
      show('p-transactions');
      for(const [id,value] of Object.entries({'t-search-date':'2026-11-11','t-search-product':'목전지','t-search-lot':'903024600808','t-filter-type':'입고','t-weight':'123.45','t-note':'저장하지 않은 새 입력','t-product-managed':'새 품목'}))document.getElementById(id).value=value;
      prepareTransactionList();
    `});
    assert.equal(await page.locator('#t-count').textContent(),'(0건)');
    const button=page.getByRole('button',{name:'거래내역 새로고침',exact:true});assert(await button.getAttribute('title'));
    await button.click();assert(await button.isDisabled());assert.equal(await button.getAttribute('aria-busy'),'true');
    await page.evaluate(()=>refreshInventoryStock());
    await page.waitForFunction(()=>inventoryRefreshPromise===null);
    assert.equal(await page.evaluate(()=>calls.length),1);assert.deepEqual(await page.evaluate(()=>calls[0]),{p_token:'qa-session',p_menu:'transactions'});
    assert.equal(await page.locator('#t-count').textContent(),'(1건)');assert.equal(await page.locator('#t-body tr').count(),1);assert.match(await page.locator('#t-body').textContent(),/목전지/);assert.equal(await page.locator('#t-body .txn-col-weight').textContent(),'349.89');
    for(const [id,value] of [['t-search-date','2026-11-11'],['t-search-product','목전지'],['t-search-lot','903024600808'],['t-weight','123.45'],['t-note','저장하지 않은 새 입력'],['t-product-managed','새 품목']])assert.equal(await page.locator('#'+id).inputValue(),value);
    assert.equal(await page.evaluate(()=>userProdEntries[0].id),'qa-new-prod');assert.equal(await button.getAttribute('aria-busy'),'false');
    await page.locator('#p-transactions .section-header').last().screenshot({path:path.join(artifacts,'transaction-refresh.png')});
    await page.evaluate(()=>{show('p-stock');document.getElementById('stock-search').value='목전지';document.getElementById('stock-location-filter').value='가공장';document.getElementById('stock-as-of-date').value='2026-11-11';control.remote=[seed,{...incoming,weight:340}];_stockMapCache=DBMTStockLedger.calculate([seed]);});
    await page.getByRole('button',{name:'재고현황 새로고침',exact:true}).click();await page.waitForFunction(()=>inventoryRefreshPromise===null);
    assert.equal(await page.locator('#stock-body tr').count(),1,await page.evaluate(()=>messages.at(-1)));assert.match(await page.locator('#stock-body').textContent(),/목전지/);assert.equal(await page.locator('#stock-body td').nth(11).textContent(),'340.0020 박스');assert.equal(await page.locator('#stock-as-of-date').inputValue(),'2026-11-11');assert.equal(await page.locator('#stock-search').inputValue(),'목전지');assert.equal(await page.locator('#stock-location-filter').inputValue(),'가공장');
    await page.locator('#p-stock .section-header').screenshot({path:path.join(artifacts,'stock-refresh.png')});
    const productionFields={'prod-filter-from':'2026-11-10','prod-filter-to':'2026-11-12','prod-filter-product':'가상 생산품','prod-filter-lot':'QA-PROD','prod-date':'2026-11-13','prod-job-no':'9','prod-note':'저장하지 않은 생산일보'};
    await page.evaluate(fields=>{
      show('p-production');
      for(const [id,value] of Object.entries(fields))document.getElementById(id).value=value;
      control.prod=[finished,{...finished,id:'qa-filtered-out',date:'2026-11-15'}];
      control.permittedMenu='production';control.remote=null;
      renderProduction();
    },productionFields);
    assert.equal(await page.locator('#prod-body tr').count(),0);
    const productionButton=page.getByRole('button',{name:'생산일보 새로고침',exact:true});
    assert(await productionButton.getAttribute('title'));
    await productionButton.click();
    assert(await productionButton.isDisabled());assert.equal(await productionButton.getAttribute('aria-busy'),'true');
    await page.waitForFunction(()=>inventoryRefreshPromise===null);
    assert.deepEqual(await page.evaluate(()=>calls.at(-1)),{p_token:'qa-session',p_menu:'production'});
    assert.match(await page.locator('#prod-filter-status').textContent(),/1건$/);
    assert.match(await page.locator('#prod-body').textContent(),/새 가상 생산품/);
    assert.doesNotMatch(await page.locator('#prod-body').textContent(),/2026-11-15/);
    assert.equal(await page.evaluate(()=>userTransactions[1].weight),340,'Production-only refresh preserves inaccessible transaction cache');
    for(const [id,value] of Object.entries(productionFields))assert.equal(await page.locator('#'+id).inputValue(),value);
    assert.equal(await productionButton.getAttribute('aria-busy'),'false');
    await page.evaluate(()=>{control.permittedMenu='transactions';});
    const productionCalls=await page.evaluate(()=>calls.length);
    await productionButton.click();assert.equal(await page.evaluate(()=>calls.length),productionCalls,'Production view permission is required');
    await page.evaluate(()=>{control.permittedMenu='';control.remote=[seed,{...incoming,weight:340}];show('p-stock');});
    let count=await page.evaluate(()=>calls.length);
    for(const field of ['transactionWritePending','productionWritePending','labelProductionRefreshPromise','_editTxnId','_editProdId']){
      await page.evaluate(field=>{window.__setGuard=()=>{};eval(field+'=1');},field);await page.evaluate(()=>refreshInventoryStock());
      assert.equal(await page.evaluate(()=>calls.length),count,field+' must protect drafts/writes');await page.evaluate(field=>eval(field+'=null'),field);
    }
    await page.evaluate(()=>document.getElementById('stock-adjust-modal').classList.remove('hidden'));await page.evaluate(()=>refreshInventoryStock());assert.equal(await page.evaluate(()=>calls.length),count);await page.evaluate(()=>document.getElementById('stock-adjust-modal').classList.add('hidden'));
    await page.evaluate(()=>{control.fail=true;});await page.evaluate(()=>refreshInventoryStock());assert.equal(await page.evaluate(()=>userTransactions[1].weight),340);assert.match(await page.evaluate(()=>messages.at(-1)),/QA refresh network error/);assert.equal(await page.locator('#stock-refresh-btn').isDisabled(),false);
    await page.evaluate(()=>{control.fail=false;control.shape=true;});await page.evaluate(()=>refreshInventoryStock());assert.equal(await page.evaluate(()=>userTransactions[1].weight),340);
    await page.evaluate(()=>{control.shape=false;control.allowed=false;});count=await page.evaluate(()=>calls.length);await page.evaluate(()=>refreshInventoryStock());assert.equal(await page.evaluate(()=>calls.length),count);
    await page.evaluate(()=>{control.allowed=true;control.remote=[seed,{...incoming,weight:1}];window.__refresh=refreshInventoryStock();userTransactions.push({id:'qa-local-write'});window.__write=saveTransactionRows([]);});
    await page.evaluate(()=>Promise.all([__refresh,__write]));assert.equal(await page.evaluate(()=>userTransactions[1].weight),340);assert(await page.evaluate(()=>userTransactions.some(row=>row.id==='qa-local-write')));
    await page.evaluate(()=>{window.__refresh=refreshInventoryStock();control.token='new-session';});await page.evaluate(()=>__refresh);assert.equal(await page.evaluate(()=>userTransactions[1].weight),340);
    await page.evaluate(()=>{control.prod=null;control.remote=[];});await page.evaluate(()=>refreshInventoryStock());assert.equal(await page.evaluate(()=>userTransactions.length),0);assert.equal(await page.evaluate(()=>userProdEntries[0].id),'qa-new-prod');

    // A long-running tab must search a fresh snapshot without losing the rows it already displayed.
    await page.clock.setFixedTime(new Date('2026-11-25T12:00:00+09:00'));
    await page.evaluate(()=>{
      show('p-transactions');
      control.remote=[seed,{...incoming,product:'11월 24일 최신 입고',date:'2026-11-24'}];
      userTransactions=[seed];transactions=[seed];
      for(const id of ['t-search-product','t-search-lot','t-search-from','t-search-to','t-filter-type'])document.getElementById(id).value='';
      document.getElementById('t-search-date').value='2026-11-11';
    });
    const transactionsPanel=page.locator('#p-transactions');
    const exactSearch=transactionsPanel.getByRole('button',{name:'특정일 조회',exact:true});
    const conditionSearch=transactionsPanel.getByRole('button',{name:'조건 조회',exact:true});
    const rows=page.locator('#t-body');
    const date=page.locator('#t-search-date');
    const searchStatus=page.locator('#t-search-status');
    await exactSearch.click();
    await page.waitForFunction(()=>inventoryRefreshPromise===null);
    assert.match(await rows.textContent(),/기존 품목/);
    await date.fill('2026-11-24');
    assert.match(await rows.textContent(),/기존 품목/,'Changing the date keeps the last successful result');
    assert.match(await searchStatus.textContent(),/조회 버튼/);
    const initialCalls=await page.evaluate(()=>calls.length);
    await page.evaluate(()=>{control.hold=true;});
    await exactSearch.click();
    await page.waitForFunction(()=>typeof control.release==='function');
    assert.equal(await page.evaluate(()=>calls.length),initialCalls+1);
    assert.deepEqual(await page.evaluate(()=>calls.at(-1)),{p_token:'new-session',p_menu:'transactions'});
    assert(await exactSearch.isDisabled());
    assert(await conditionSearch.isDisabled());
    assert.match(await searchStatus.textContent(),/불러오는 중/);
    assert.match(await rows.textContent(),/기존 품목/,'The prior result remains visible until the server responds');
    await page.evaluate(()=>{void runTransactionExactDateSearch();});
    assert.equal(await page.evaluate(()=>calls.length),initialCalls+1,'Identical in-flight search does not make a second server request');
    await date.fill('2026-11-25');
    assert.match(await rows.textContent(),/기존 품목/);
    await page.evaluate(()=>{control.release();control.release=null;});
    await rows.getByText('11월 24일 최신 입고',{exact:true}).waitFor();
    assert.equal(await date.inputValue(),'2026-11-25','A response never overwrites a newer date draft');
    assert.doesNotMatch(await rows.textContent(),/기존 품목/,'Apply the submitted date after a successful response');
    await button.click();
    await page.waitForFunction(()=>inventoryRefreshPromise===null);
    assert.match(await rows.textContent(),/11월 24일 최신 입고/,'Manual refresh keeps the applied date rather than submitting the draft');

    await transactionsPanel.getByRole('button',{name:'인쇄',exact:true}).click();
    assert.match(await page.evaluate(()=>printed.filters),/2026-11-24/);
    assert.doesNotMatch(await page.evaluate(()=>printed.filters),/2026-11-25/,'Print uses the applied criteria while the user edits the draft');
    assert.match(await page.evaluate(()=>printed.table),/11월 24일 최신 입고/);
    await transactionsPanel.getByRole('button',{name:'CSV 저장',exact:true}).click();
    const previousCSV=await page.evaluate(()=>csv);

    await page.locator('#t-search-product').fill('25일');
    assert.equal(await date.inputValue(),'2026-11-25','Adding a product condition preserves the date draft');
    assert.match(await rows.textContent(),/11월 24일 최신 입고/);
    await page.evaluate(()=>{
      control.fail=true;
      control.remote=[{...incoming,product:'11월 25일 추가 입고',date:'2026-11-25'}];
    });
    await conditionSearch.click();
    await page.waitForFunction(()=>inventoryRefreshPromise===null);
    assert.match(await rows.textContent(),/11월 24일 최신 입고/,'Server failure preserves previous results');
    assert.doesNotMatch(await rows.textContent(),/조회 결과가 없습니다/,'A failed request is not a valid empty result');
    assert.match(await searchStatus.textContent(),/불러오지 못했습니다/);
    await transactionsPanel.getByRole('button',{name:'인쇄',exact:true}).click();
    assert.match(await page.evaluate(()=>printed.filters),/2026-11-24/);
    await transactionsPanel.getByRole('button',{name:'CSV 저장',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>csv),previousCSV,'A failed conditional search does not replace CSV data');
    await page.evaluate(()=>{control.fail=false;});
    await page.locator('#t-search-product').press('Enter');
    await rows.getByText('11월 25일 추가 입고',{exact:true}).waitFor();
    assert.doesNotMatch(await rows.textContent(),/11월 24일 최신 입고/);

    let conditionCalls=await page.evaluate(()=>calls.length);
    await page.evaluate(()=>{control.remote=[];});
    await conditionSearch.click();
    await page.waitForFunction(()=>inventoryRefreshPromise===null);
    assert.equal(await page.evaluate(()=>calls.length),conditionCalls+1,'Submitting the same criteria after completion fetches a new snapshot');
    assert.match(await rows.textContent(),/조회 결과가 없습니다/,'An empty successful response replaces the prior result');
    await page.evaluate(()=>{control.remote=[{...incoming,product:'오늘 입고',date:'2026-11-25'}];document.getElementById('t-search-product').value='';});
    await transactionsPanel.getByRole('button',{name:/최근 15일/}).click();
    await rows.getByText('오늘 입고',{exact:true}).waitFor();
    assert.equal(await page.locator('#t-search-to').inputValue(),'2026-11-25','Recent-day search reads today at click time after a tab crosses midnight');

    for(const width of [1440,390]){await page.setViewportSize({width,height:900});for(const [id,buttonId] of [['p-transactions','txn-refresh-btn'],['p-stock','stock-refresh-btn'],['p-production','prod-refresh-btn']]){await page.evaluate(showId=>show(showId),id);const icon=page.locator('#'+buttonId);const bounds=await icon.boundingBox();assert(bounds.width===30&&bounds.height===30&&bounds.x>=0&&bounds.x+bounds.width<=width);assert(await icon.locator('img').evaluate(img=>img.complete&&img.naturalWidth>0));await page.locator('#'+id+' .section-header').last().screenshot({path:path.join(artifacts,id+'-'+width+'.png')});}}
    assert.deepEqual(errors,[]);console.log('PASS: server-fresh date/condition searches, draft and result separation, duplicate lookup guard, failure preserving print/CSV, empty result, date rollover, and all three scoped refresh controls');console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
