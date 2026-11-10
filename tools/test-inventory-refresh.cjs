// Refresh actual ERP handlers against a fake RPC; never send business writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-inventory-refresh-'));
const names=['inventoryRefreshBlocked','refreshTransactionList','refreshInventoryStock','refreshInventoryData','saveTransactionRows','markLocalCoreChanged','assertPersonalServerResult'];
names.push('stockLedgerDateKey','normProdDate');
names.push('localDateString','htmlEscape','jsArg','parseAppNumber','parseOptionalBoxCount','boxCountDisplay','normalizeStockLocation','getTxnStockLocation','getFilteredTransactions','transactionDisplayRows','renderTransactions','getStockMap','getKnownStockLocations','stockLocationOptionsHtml','refreshStockLocationFilter','stockCanAdjustCurrent','stockPersonalCan','applyStockPermissionState','closeStockAdjust','closeStockBoxBaseline','setStockExportEnabled','getStockQueryFilters','stockQueryDescription','renderStock');
const functions=names.map(name=>{const match=html.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'));assert(match,name);return match[0];}).join('\n');new vm.Script(functions);
const auth=fs.readFileSync(path.join(root,'m02-auth.js'),'utf8');
assert.match(auth,/refreshTransactionList:\['transactions','view'\]/);assert.match(auth,/refreshInventoryStock:\['stock','view'\]/);
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
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await page.evaluate(markup=>{
      const template=document.createElement('template');template.innerHTML=markup;
      for(const id of ['p-transactions','p-stock'])document.querySelector('main').append(template.content.querySelector('#'+id));
      for(const id of ['stock-adjust-modal','stock-box-baseline-modal'])document.body.append(template.content.querySelector('#'+id));
    },html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'stock-ledger.js'),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'pda-transaction-summary.js'),'utf8')});
    await page.addScriptTag({content:`
      const seed={id:'qa-old',date:'2026-11-11',type:'입고',product:'기존 품목',lot:'OLD',stockLocation:'가공장',stockRowId:'qa-old-stock',weight:10,boxCount:1,price:1000};
      const incoming={id:'qa-pda',date:'2026-11-11',type:'입고',product:'목전지',lot:'903024600808',stockLocation:'가공장',stockRowId:'qa-pda-stock',weight:349.89,boxCount:20,price:4400};
      let userTransactions=[{...seed}],transactions=[...userTransactions],userProdEntries=[{id:'qa-old-prod'}],EXCEL_TRANSACTIONS=[];
      let _editTxnId=null,_editProdId=null,transactionWritePending=0,productionWritePending=0,labelProductionRefreshPromise=null,inventoryRefreshPromise=null,localCoreRevision=0;
      let transactionListQueryActive=false,stockSearchActivated=false,_stockMapCache=null;
      const STOCK_LOCATION_DEFAULT='가공장',STOCK_LOCATION_SECONDARY='물류창고',EXCEL_STOCK=[],labelProducts=[];
      let stockSortKey='product',stockSortDir='asc',stockSearchDirty=true,stockQuerySnapshot=null;
      const SUPABASE_ENABLED_KEY='qa-enabled';localStorage.setItem(SUPABASE_ENABLED_KEY,'1');
      const control={token:'qa-session',personal:true,allowed:true,delay:80,writeDelay:100,fail:false,shape:false,remote:[seed,incoming],prod:[{id:'qa-new-prod'}]};
      const DBMTAuth={isPersonal:()=>control.personal,can:()=>control.allowed,getSessionToken:()=>control.token};
      let active='p-transactions',calls=[],messages=[],cached={},rendered=[];
      const activePageId=()=>active,toast=value=>messages.push(value),safeLocalStorageSet=(key,value)=>cached[key]=value;
      const invalidateStockMap=()=>{_stockMapCache=null;},recordTransactionChange=()=>{},save=()=>{throw Error('Must not write a full ERP payload');};
      async function supabaseSaveTransactionRows(){await new Promise(resolve=>setTimeout(resolve,control.writeDelay));}
      async function sbRpc(name,body){
        if(name!=='dbmt_erp_get_inventory_snapshot')throw Error('Unexpected RPC: '+name);
        calls.push(structuredClone(body));const remote=structuredClone(control.remote),prod=structuredClone(control.prod);
        await new Promise(resolve=>setTimeout(resolve,control.delay));
        if(control.fail)throw Error('QA refresh network error');return control.shape?{ok:true}:{ok:true,transactions:remote,prod};
      }
      function show(id){active=id;document.querySelectorAll('.tab-panel').forEach(el=>el.classList.toggle('active',el.id===id));}
      ${functions}
      show('p-transactions');
      for(const [id,value] of Object.entries({'t-search-date':'2026-11-11','t-search-product':'목전지','t-search-lot':'903024600808','t-filter-type':'입고','t-weight':'123.45','t-note':'저장하지 않은 새 입력','t-product-managed':'새 품목'}))document.getElementById(id).value=value;
      transactionListQueryActive=true;renderTransactions();
    `});
    assert.equal(await page.locator('#t-count').textContent(),'(0건)');
    const button=page.getByRole('button',{name:'거래내역 새로고침',exact:true});assert(await button.getAttribute('title'));
    await button.click();assert(await button.isDisabled());assert.equal(await button.getAttribute('aria-busy'),'true');
    await page.evaluate(()=>refreshInventoryStock());
    await page.waitForFunction(()=>inventoryRefreshPromise===null);
    assert.equal(await page.evaluate(()=>calls.length),1);assert.deepEqual(await page.evaluate(()=>calls[0]),{p_token:'qa-session',p_menu:'transactions'});
    assert.equal(await page.locator('#t-count').textContent(),'(1건)');assert.equal(await page.locator('#t-body tr').count(),1);assert.match(await page.locator('#t-body').textContent(),/목전지/);assert.equal(await page.locator('#t-body td').nth(6).textContent(),'349.89');
    for(const [id,value] of [['t-search-date','2026-11-11'],['t-search-product','목전지'],['t-search-lot','903024600808'],['t-weight','123.45'],['t-note','저장하지 않은 새 입력'],['t-product-managed','새 품목']])assert.equal(await page.locator('#'+id).inputValue(),value);
    assert.equal(await page.evaluate(()=>userProdEntries[0].id),'qa-new-prod');assert.equal(await button.getAttribute('aria-busy'),'false');
    await page.locator('#p-transactions .section-header').last().screenshot({path:path.join(artifacts,'transaction-refresh.png')});
    await page.evaluate(()=>{show('p-stock');document.getElementById('stock-search').value='목전지';document.getElementById('stock-location-filter').value='가공장';document.getElementById('stock-as-of-date').value='2026-11-11';control.remote=[seed,{...incoming,weight:340}];_stockMapCache=DBMTStockLedger.calculate([seed]);});
    await page.getByRole('button',{name:'재고현황 새로고침',exact:true}).click();await page.waitForFunction(()=>inventoryRefreshPromise===null);
    assert.equal(await page.locator('#stock-body tr').count(),1,await page.evaluate(()=>messages.at(-1)));assert.match(await page.locator('#stock-body').textContent(),/목전지/);assert.equal(await page.locator('#stock-body td').nth(11).textContent(),'340.0020 박스');assert.equal(await page.locator('#stock-as-of-date').inputValue(),'2026-11-11');assert.equal(await page.locator('#stock-search').inputValue(),'목전지');assert.equal(await page.locator('#stock-location-filter').inputValue(),'가공장');
    await page.locator('#p-stock .section-header').screenshot({path:path.join(artifacts,'stock-refresh.png')});
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
    for(const width of [1440,390]){await page.setViewportSize({width,height:900});for(const id of ['p-transactions','p-stock']){await page.evaluate(showId=>show(showId),id);const icon=page.locator('#'+(id==='p-stock'?'stock':'txn')+'-refresh-btn');const bounds=await icon.boundingBox();assert(bounds.width===30&&bounds.height===30&&bounds.x>=0&&bounds.x+bounds.width<=width);assert(await icon.locator('img').evaluate(img=>img.complete&&img.naturalWidth>0));await page.locator('#'+id+' .section-header').last().screenshot({path:path.join(artifacts,id+'-'+width+'.png')});}}
    assert.deepEqual(errors,[]);console.log('PASS: both real refresh buttons, one scoped RPC, latest PDA rows/stock cache, filters/new drafts, production access, duplicate/loading states, edit/write/modal guards, concurrent-save/session protection, failure/empty responses and 1440/390px icons');console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
