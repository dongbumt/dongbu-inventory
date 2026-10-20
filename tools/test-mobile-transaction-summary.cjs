// Full mobile page with fictional snapshots. All account/data RPCs are mocked.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'mobile-admin.html'),'utf8');
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
const sharedAsset=source=>source.match(/src="(pda-transaction-summary\.js\?v=[^"]+)"/)[1];
assert.equal(sharedAsset(html),sharedAsset(fs.readFileSync(path.join(root,'index.html'),'utf8')),'PC and mobile must use the same aggregation release');
const first={id:'qa-box',date:'2026-10-20',type:'출고',trader:'동원홈푸드',traderId:'qa-customer',product:'돈사태(작업)',labelProductId:'qa-product',lot:'QA-LOT',origin:'국내산',storage:'냉동',packunit:'3KG',stockLocation:'가공장',stockRowId:'qa-stock-0',stockUnitPrice:5315,weight:12,boxCount:1,price:7500,amount:90000,note:'',_pdaRequestId:'qa-batch',_pdaLabelId:'qa-label',_pdaCode:'qa-code'};
const boxes=count=>Array.from({length:count},(_,i)=>({...first,id:`qa-box-${i}`,_pdaLabelId:`qa-label-${i}`,_pdaCode:`qa-code-${i}`,proddate:i%2?'2026-10-19':'2026-10-20',expdate:i%2?'2027-10-18':'2027-10-19',stockProddate:i%2?'2026-10-19':'2026-10-20',stockRowId:`qa-stock-${i%3}`,stockUnitPrice:i%2?5315:5505}));
const sources=Array.from({length:3},(_,i)=>({id:`qa-production-${i}`,date:'2026-10-20',type:'생산입고',product:first.product,labelProductId:first.labelProductId,lot:first.lot,origin:first.origin,packunit:first.packunit,stockLocation:'가공장',stockRowId:`qa-stock-${i}`,weight:200,price:5315,amount:1063000}));
const initial=[...sources,...boxes(42)];
const allowedFiles=['mobile-admin.html','stock-ledger.js','pda-transaction-summary.js','mobile-production.js','styles/mobile-production.css'];
const base=process.env.DBMT_MOBILE_TEST_BASE||'http://mobile-summary.test/';
const remote=!!process.env.DBMT_MOBILE_TEST_BASE;
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-mobile-txn-summary-'));
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Asia/Seoul'}),page=await context.newPage();
    const calls=[],assets=[],errors=[],blocked=[];let transactions=structuredClone(initial);
    page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(request.method()==='GET'&&request.url().startsWith(base)){
        const file=url.pathname.slice(new URL(base).pathname.length)||'mobile-admin.html';
        if(allowedFiles.includes(file)){
          assets.push(file);
          if(remote)return route.continue();
          return route.fulfill({contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html',body:fs.readFileSync(path.join(root,file),'utf8')});
        }
      }
      if(url.origin==='https://hdwjwtmbsxfjrlvicgnn.supabase.co'&&url.pathname.startsWith('/rest/v1/rpc/')){
        const headers={'access-control-allow-origin':'*','access-control-allow-headers':'apikey,authorization,content-type','access-control-allow-methods':'POST,OPTIONS'};
        if(request.method()==='OPTIONS')return route.fulfill({status:204,headers,body:''});
        const name=url.pathname.split('/').at(-1);calls.push(name);
        let body;
        if(name==='dbmt_mobile_admin_login')body={ok:true,token:'qa-fictional-session'};
        else if(name==='dbmt_mobile_admin_snapshot')body={account:{displayName:'테스트 관리자'},serverTime:'2026-10-21T02:00:00Z',transactions,prod:[],appData:{}};
        else if(name==='dbmt_mobile_admin_driver_week')body={attendance:[]};
        else if(name==='dbmt_mobile_admin_logout')body={ok:true};
        else{blocked.push(name);return route.abort();}
        return route.fulfill({headers,contentType:'application/json',body:JSON.stringify(body)});
      }
      blocked.push(request.url());return route.abort();
    });
    await page.clock.install({time:new Date('2026-10-21T02:00:00Z')});
    await page.goto(base+'mobile-admin.html');
    await page.locator('#login-id').fill('qa');await page.locator('#login-pin').fill('0123');await page.locator('#login-btn').click();
    await page.locator('#app-view').waitFor({state:'visible'});await page.locator('[data-view="transactions"]').click();
    await page.locator('#tx-from').fill('2026-10-20');await page.locator('#tx-to').fill('2026-10-20');await page.locator('#tx-type').selectOption('출고');
    const rows=page.locator('#transaction-list > .row');
    assert.equal(await rows.count(),1);assert.equal(await page.locator('#transaction-count').innerText(),'1건 · PDA 42박스');
    assert.match(await rows.innerText(),/504kg/);assert.match(await rows.innerText(),/42박스/);assert.match(await rows.innerText(),/3,780,000원/);
    assert.match(await page.locator('#transaction-summary').innerText(),/504kg/);assert.match(await page.locator('#transaction-summary').innerText(),/3,780,000원/);
    assert.equal(await page.evaluate(()=>JSON.stringify(snapshot.transactions)),JSON.stringify(initial),'Aggregation must not rewrite raw transactions');
    const originalStock=await page.evaluate(()=>JSON.stringify(stockRows));
    await page.locator('#tx-search').fill('동원홈푸드');assert.equal(await rows.count(),1);
    await page.locator('#tx-search').fill('QA-LOT');assert.equal(await rows.count(),1);
    await page.locator('#tx-search').fill('no-match');assert.equal(await rows.count(),0);assert.equal(await page.locator('#transaction-count').innerText(),'0건');
    await page.locator('#tx-search').fill('');
    for(const width of [320,390,760]){
      await page.setViewportSize({width,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`No horizontal overflow at ${width}px`);
      const title=await rows.locator('.row-title').boundingBox(),value=await rows.locator('.row-value').boundingBox();
      assert(title.x+title.width<=value.x,'Product and aggregate weight must not overlap');
      await page.screenshot({path:path.join(artifacts,`summary-${width}.png`),fullPage:true});
    }
    await page.locator('#tx-type').selectOption('생산입고');assert.equal(await rows.count(),3,'Do not aggregate production receipts');
    await page.locator('#tx-type').selectOption('출고');
    assert.equal(await page.evaluate(()=>JSON.stringify(stockRows)),originalStock,'Filtering must not change stock balances');
    async function replaceRows(next){
      transactions=structuredClone(next);await page.getByRole('button',{name:'새로고침',exact:true}).click();
      await page.waitForFunction(expected=>JSON.stringify(snapshot?.transactions)===expected,JSON.stringify(transactions));
    }
    const manual={...first,id:'qa-manual'};delete manual._pdaRequestId;delete manual._pdaLabelId;
    const variants=[...initial,{...first,id:'qa-other-batch',_pdaRequestId:'qa-batch-2'},
      {...first,id:'qa-other-lot',lot:'QA-OTHER'},
      {...first,id:'qa-other-price',price:8000,amount:96000},
      {...first,id:'qa-other-customer',traderId:'qa-other',trader:'다른 고객사'},
      {...first,id:'qa-other-date',date:'2026-10-19'},manual,{...manual,id:'qa-manual-2'}];
    await replaceRows(variants);assert.equal(await rows.count(),7,'Different batch/LOT/price/customer and manual rows stay separate');
    await page.locator('#tx-from').fill('2026-10-19');assert.equal(await rows.count(),8,'Date filter applies before grouping');
    await replaceRows([{...first,id:'round-1',weight:.2,amount:1},{...first,id:'round-2',weight:.2,amount:1}]);
    assert.equal(await rows.count(),1);assert.match(await rows.innerText(),/0\.4kg/);assert.match(await rows.innerText(),/2원/);
    await replaceRows([{...first,id:'escaped',product:'<img src=x onerror=alert(1)>'}]);
    assert.equal(await page.locator('#transaction-list img').count(),0);assert.match(await rows.innerText(),/<img src=x/);
    await replaceRows(boxes(250));assert.equal(await rows.count(),1);assert.match(await rows.innerText(),/3,000kg/);assert.match(await rows.innerText(),/250박스/);assert.match(await rows.innerText(),/22,500,000원/);
    assert.equal(await page.locator('#transaction-list .more').count(),0,'Aggregate all boxes before the display limit');
    await page.reload();await page.locator('#app-view').waitFor({state:'visible'});assert.equal(await rows.count(),1);assert.equal(await page.locator('#transaction-count').innerText(),'1건 · PDA 250박스');
    assert.equal(await page.evaluate(()=>JSON.stringify(snapshot.transactions)),JSON.stringify(transactions),'Refresh preserves individual boxes');
    const storage=await page.evaluate(()=>({...localStorage}));assert(Object.keys(storage).every(key=>['dbmt_mobile_admin_session_token','dbmt_mobile_admin_view'].includes(key)),'Do not persist business data');
    await page.getByRole('button',{name:'로그아웃'}).click();assert.equal(await page.locator('#app-view').isVisible(),false);
    assert(assets.includes('pda-transaction-summary.js'));assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
    assert(calls.every(name=>['dbmt_mobile_admin_login','dbmt_mobile_admin_snapshot','dbmt_mobile_admin_driver_week','dbmt_mobile_admin_logout'].includes(name)),'No transaction writes');
    console.log('PASS: full mobile login, 42 boxes -> 504kg / 3,780,000 / one row, PC shared grouping, filters and identity separation, per-box rounding, >200 boxes, original stock/transaction preservation, refresh/login, escaping and responsive 320/390/760px');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
