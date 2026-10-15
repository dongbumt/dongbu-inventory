/* Isolated mobile page, fictional transactions and mocked read-only RPCs. */
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const base={date:'2026-10-15',origin:'국내산',stockLocation:'가공장',price:6000,lot:'QA-LOT',packunit:'5KG',proddate:'2026-10-15'};
const fixture=[
  {...base,type:'입고',product:'가상 원료육',origin:'미국',lot:'QA-OLD',weight:100,price:2500},
  {...base,type:'출고',product:'가상 원료육',origin:'미국산',lot:'QA-OLD',weight:25,price:5000},
  {...base,type:'생산입고',product:'가상 생산품',stockRowId:'A',stockNote:'3mm',weight:100,boxCount:10},
  {...base,type:'생산입고',product:'가상 생산품',stockRowId:'B',stockNote:'5mm',weight:60},
  {...base,type:'출고',product:'가상 생산품',stockRowId:'A',weight:20,boxCount:2,price:9000},
  {...base,type:'재고이동',product:'가상 생산품',stockRowId:'A',weight:10,boxCount:1,fromLocation:'가공장',toLocation:'물류창고'},
  {...base,type:'사용',product:'가상 생산품',stockRowId:'B',weight:70},
  {...base,type:'입고',product:'가상 소진품',lot:'QA-ZERO',weight:5},
  {...base,type:'출고',product:'가상 소진품',lot:'QA-ZERO',weight:5}
];
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-mobile-stock-'));
  try{
    const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
    const calls=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
    let transactions=structuredClone(fixture);
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin==='http://stock.test'){
        const file=url.pathname==='/'?'mobile-admin.html':url.pathname.slice(1);
        if(!['mobile-admin.html','stock-ledger.js','mobile-production.js','styles/mobile-production.css'].includes(file))return route.fulfill({status:404,body:''});
        return route.fulfill({contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html',body:fs.readFileSync(path.join(root,file),'utf8')});
      }
      const headers={'access-control-allow-origin':'*','access-control-allow-headers':'apikey,authorization,content-type','access-control-allow-methods':'POST,OPTIONS'};
      if(request.method()==='OPTIONS')return route.fulfill({status:204,headers,body:''});
      const name=url.pathname.split('/').at(-1);calls.push(name);
      let body;
      if(name==='dbmt_mobile_admin_login')body={ok:true,token:'fictional-stock-session'};
      else if(name==='dbmt_mobile_admin_snapshot')body={account:{displayName:'QA'},serverTime:'2026-10-15T03:00:00Z',transactions,prod:[],appData:{}};
      else if(name==='dbmt_mobile_admin_driver_week')body={attendance:[]};
      else if(name==='dbmt_mobile_admin_logout')body={ok:true};
      else throw Error('Unexpected RPC: '+name);
      return route.fulfill({headers,contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.goto('http://stock.test/');
    await page.locator('#login-id').fill('abc');await page.locator('#login-pin').fill('0123');await page.locator('#login-btn').click();
    await page.locator('#app-view').waitFor({state:'visible'});await page.locator('[data-view="stock"]').click();
    assert.equal(await page.locator('#stock-count').innerText(),'4항목');
    assert.match(await page.locator('#stock-summary').innerText(),/145kg/);
    assert.match(await page.locator('#stock-summary').innerText(),/607,500원/);
    assert.equal(await page.locator('#stock-list .warning').count(),1,'Negative rows stay visible by default');
    assert.match(await page.locator('#stock-list').innerText(),/박스수 7/);
    assert.match(await page.locator('#stock-list').innerText(),/박스수 미기록/);
    assert.match(await page.locator('#stock-list').innerText(),/포장 5KG/);
    await page.screenshot({path:path.join(artifacts,'stock.png'),fullPage:true});
    await page.locator('#stock-search').fill('3mm');assert.equal(await page.locator('#stock-count').innerText(),'2항목');assert.match(await page.locator('#stock-summary').innerText(),/80kg/);
    await page.locator('#stock-search').fill('');await page.locator('#stock-location').selectOption('가공장');assert.match(await page.locator('#stock-summary').innerText(),/135kg/);
    await page.locator('#stock-location').selectOption('');await page.locator('#stock-positive').selectOption('소진');assert.equal(await page.locator('#stock-count').innerText(),'1항목');assert.match(await page.locator('#stock-list').innerText(),/가상 소진품/);
    await page.locator('#stock-positive').selectOption('');assert.equal(await page.locator('#stock-count').innerText(),'5항목');
    await page.locator('#stock-positive').selectOption('재고');
    transactions.push({...base,type:'출고',product:'가상 생산품',stockRowId:'A',weight:5,boxCount:1});
    await page.getByRole('button',{name:'새로고침',exact:true}).click();await page.waitForFunction(()=>document.getElementById('stock-summary').textContent.includes('140kg'));
    for(const width of [320,390,760]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`No horizontal overflow at ${width}px`);}
    const storage=await page.evaluate(()=>({...localStorage}));assert.ok(Object.keys(storage).every(key=>['dbmt_mobile_admin_session_token','dbmt_mobile_admin_view'].includes(key)),'Business data is never persisted in browser storage');
    assert.ok(calls.every(name=>['dbmt_mobile_admin_login','dbmt_mobile_admin_snapshot','dbmt_mobile_admin_driver_week'].includes(name)),'Viewing stock cannot write transactions');
    await page.getByRole('button',{name:'로그아웃'}).click();assert.equal(await page.locator('#app-view').isVisible(),false);
    assert.deepEqual(errors,[]);
    console.log('PASS: actual mobile login/render, shared balances and amount, negative/zero/location/search filters, optional boxes, snapshot refresh, read-only requests and responsive layout');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
