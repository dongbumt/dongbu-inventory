// Actual ERP navigation/auth handlers; fictional sessions and read-only RPC mocks.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const auth=fs.readFileSync(path.join(root,'m02-auth.js'),'utf8');new vm.Script(auth);
const source=name=>{const match=html.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'));assert(match,name);return match[0]};
const nav=id=>{const match=html.match(new RegExp('<div\\b[^>]*\\bid="'+id+'"[^>]*>[\\s\\S]*?</div>'));assert(match,id);return match[0]};
const server=http.createServer((req,res)=>{
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><meta charset="utf-8">
    <header><button id="m02-user-button"></button><span id="m02-auth-mode-label"></span></header>
    <nav><div class="nav-group" id="base-group">${nav('nav-schedule')}</div><div class="nav-group" id="production-group">${nav('nav-production-board-standalone')}${nav('nav-production-board')}</div></nav>
    <main><div class="tab-panel active" id="p-schedule">일정관리</div><div class="tab-panel" id="p-production-board">
    <input id="production-board-view-date" type="date"><div id="production-board-view-status"></div></div></main>
    <script>
      const productionBoardViewerState={loading:false};
      function activateNavGroup(){} function renderPageById(id){__rendered.push(id)}
      function updateProductionBoardDeleteButton(){} function renderProductionBoardViewer(){}
      ${source('showPage')}
      ${source('loadProductionBoardPage')}
    </script>`);
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const context=await browser.newContext(),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await context.addInitScript(()=>{
      sessionStorage.setItem('dbmt_erp_user_session_token','fictional-board-session');
      window.__session={ok:true,user:{id:'qa-user',loginId:'qa-user',displayName:'테스트 사용자',roleName:'생산보드 권한 없음'},permissions:[{menuCode:'schedule',canView:true},{menuCode:'production_board',canView:false}]};
      window.__opened=[];window.__rendered=[];window.__calls=[];window.__messages=[];
      window.open=(...args)=>{__opened.push(args);return null};window.toast=message=>__messages.push(message);
      window.startAuthenticatedErp=async()=>{};
      window.sbRpc=async(name,params)=>{
        __calls.push({name,params});
        if(name==='dbmt_erp_session')return structuredClone(__session);
        if(name==='dbmt_erp_get_production_board')return {dates:[],pages:[],selectedDate:'2026-11-19'};
        if(name==='dbmt_erp_logout')return {ok:true};
        throw Error('Unexpected RPC: '+name);
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await page.addScriptTag({content:auth});await page.waitForFunction(()=>DBMTAuth.isPersonal());
    const switchPermissions=permissions=>page.evaluate(async permissions=>{__session.permissions=permissions;await DBMTAuth.initializeSession(true)},permissions);
    const assertHidden=async()=>{
      assert(await page.locator('#nav-production-board').isHidden());
      assert(await page.locator('#nav-production-board-standalone').isHidden());
      assert(await page.locator('#production-group').isHidden());
      assert.equal(await page.evaluate(()=>DBMTAuth.canOpenPage('p-production-board')),false);
    };
    await assertHidden();
    assert.equal(await page.evaluate(()=>DBMTAuth.openProductionBoard()),false);
    await page.evaluate(()=>document.getElementById('nav-production-board-standalone').click());
    assert.equal(await page.evaluate(()=>__opened.length),0,'Hidden menu/programmatic calls must not open a new tab');
    assert.equal(await page.evaluate(()=>showPage('p-production-board')),false);
    assert.equal(await page.locator('.tab-panel.active').getAttribute('id'),'p-schedule');
    await page.evaluate(()=>loadProductionBoardPage());
    assert.match(await page.locator('#production-board-view-status').innerText(),/조회 권한이 없습니다/);
    assert.equal(await page.evaluate(()=>__calls.filter(call=>call.name==='dbmt_erp_get_production_board').length),0);
    await switchPermissions([{menuCode:'production_board',canView:true,canCreate:false,canDelete:false}]);
    assert(await page.locator('#nav-production-board').isVisible());assert(await page.locator('#nav-production-board-standalone').isVisible());
    assert.equal(await page.locator('.tab-panel.active').getAttribute('id'),'p-production-board');
    assert.equal(await page.evaluate(()=>__opened.length),0,'Board-only login must select its ERP panel rather than auto-open the dedicated screen');
    await page.locator('#nav-production-board-standalone').click();
    assert.deepEqual(await page.evaluate(()=>__opened[0]),['production-board.html?v=20260831board9','_blank','noopener']);
    await page.evaluate(()=>loadProductionBoardPage());
    assert.equal(await page.evaluate(()=>__calls.filter(call=>call.name==='dbmt_erp_get_production_board').length),1);
    await switchPermissions([{menuCode:'schedule',canView:true},{menuCode:'production_board',canView:false,canCreate:true,canDelete:true}]);
    await assertHidden();assert.equal(await page.locator('.tab-panel.active').getAttribute('id'),'p-schedule','Revoking view leaves the board page');
    assert.equal(await page.evaluate(()=>DBMTAuth.openProductionBoard()),false);
    await switchPermissions([]);await assertHidden();assert.equal(await page.locator('.tab-panel.active').count(),0);
    await switchPermissions([{menuCode:'production_board',canView:true}]);
    await page.evaluate(()=>DBMTAuth.changeLoginUser());await assertHidden();
    assert.equal(await page.evaluate(()=>DBMTAuth.openProductionBoard()),false,'Signed-out users cannot open the board through ERP');
    assert.equal(await page.evaluate(()=>__opened.length),1);assert.deepEqual(errors,[]);
    console.log('PASS: actual role/navigation handlers hide both board menus, block direct calls and unauthorized reads, retain authorized access, and handle board-only login/revocation/logout without auto-opening tabs');
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
})().catch(error=>{console.error(error);process.exitCode=1;server.close()});
