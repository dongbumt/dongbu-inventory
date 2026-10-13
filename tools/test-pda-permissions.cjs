// Real ERP permission form and auth module; all sessions/role saves are fictional.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-pda-permissions-'));
const index=fs.readFileSync(path.join(repo,'index.html'),'utf8');
const panel=index.slice(index.indexOf('<div class="tab-panel" id="p-access-control">'),index.indexOf('<div class="tab-panel" id="p-labelproducts">'));
const nav=['nav-schedule','nav-transactions','nav-stock','nav-pda','nav-access-control'].map(id=>index.match(new RegExp(`<div\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?</div>`))[0]).join('\n');
assert(panel&&nav.includes('PDA 입출고'));
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://local');
  if(url.pathname==='/fixture.html'){
    const asset=process.env.DBMT_ACCESS_TEST_BASE||`http://127.0.0.1:${server.address().port}/`;
    res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${asset}styles/main.css"><link rel="stylesheet" href="${asset}styles/m02-access-control.css"><header><button id="m02-user-button"></button><span id="m02-auth-mode-label"></span></header><nav><div class="nav-group">${nav}</div></nav><main class="main"><div class="tab-panel active" id="p-schedule">일정</div><div class="tab-panel" id="p-transactions">거래</div><div class="tab-panel" id="p-stock">재고</div>${panel}</main><script src="${asset}m02-auth.js?v=20261013pda2"></script>`);return;
  }
  const file=path.resolve(repo,url.pathname.slice(1));
  if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',path.extname(file)==='.css'?'text/css':'text/javascript');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
    await context.route('**/*',route=>route.request().method()==='GET'?route.continue():route.abort());
    await context.addInitScript(()=>{
      sessionStorage.setItem('dbmt_erp_user_session_token','qa-token');
      const catalog=[['transactions','거래내역'],['stock','재고현황'],['pda','PDA 입출고'],['access_control','사용자·권한']].map(([menuCode,menuName])=>({menuCode,menuName}));
      const fields=['canView','canCreate','canUpdate','canDelete','canClose','canApiSend','canAdmin'];
      const permissions=(roleId,value)=>catalog.map(menu=>({roleId,menuCode:menu.menuCode,...Object.fromEntries(fields.map(field=>[field,value]))}));
      window.__admin={users:[],catalog,roles:[{id:'admin-role',code:'system_admin',name:'시스템 관리자',active:true,systemRole:true,protectedRole:true,revision:1},{id:'warehouse-role',code:'warehouse',name:'창고 담당',active:true,revision:1}],permissions:[...permissions('admin-role',true),...permissions('warehouse-role',false)]};
      window.__session={ok:true,user:{id:'qa-admin',loginId:'qa',displayName:'테스트 관리자'},permissions:permissions('admin-role',true)};
      window.__saves=[];window.__opened=[];
      window.open=(...args)=>{window.__opened.push(args);return null;};window.toast=()=>{};window.startAuthenticatedErp=async()=>{};
      window.showPage=(id,button)=>{document.querySelectorAll('.tab-panel').forEach(panel=>panel.classList.remove('active'));document.getElementById(id).classList.add('active');};
      window.sbRpc=async(name,params)=>{
        if(name==='dbmt_erp_session')return structuredClone(window.__session);
        if(name==='dbmt_erp_admin_get')return structuredClone(window.__admin);
        if(name==='dbmt_erp_admin_save_role'){
          window.__saves.push(params);const role=window.__admin.roles.find(role=>role.id===params.p_id);
          role.revision++;window.__admin.permissions=window.__admin.permissions.filter(row=>row.roleId!==role.id).concat(params.p_permissions.map(row=>({...row,roleId:role.id})));
          return {ok:true,id:role.id,revision:role.revision};
        }
        throw Error('Unexpected RPC: '+name);
      };
    });
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture.html`);
    await page.waitForFunction(()=>window.DBMTAuth?.isPersonal());
    await page.locator('#nav-access-control').click();await page.evaluate(()=>DBMTAuth.refreshAdmin());
    await page.locator('[data-role-id="warehouse-role"]').click();
    const pda=page.locator('tr[data-menu-code="pda"]');
    assert.match(await pda.textContent(),/PDA 입출고/);
    for(const action of ['view','create'])assert(await pda.locator(`[data-action="${action}"]`).isEnabled());
    for(const action of ['update','delete','close','apiSend','admin']){
      assert(await pda.locator(`[data-action="${action}"]`).isDisabled());
      await page.locator(`[data-all-action="${action}"]`).check();
      assert(!(await pda.locator(`[data-action="${action}"]`).isChecked()),'Bulk selection must not enable unsupported PDA actions');
    }
    await pda.locator('[data-action="view"]').check();await pda.locator('[data-action="create"]').check();
    await page.getByRole('button',{name:'역할 저장',exact:true}).click();
    await page.waitForFunction(()=>__saves.length===1&&document.getElementById('m02-role-revision').value==='2');
    const saved=await page.evaluate(()=>__saves[0].p_permissions.find(row=>row.menuCode==='pda'));
    assert(saved.canView&&saved.canCreate);for(const field of ['canUpdate','canDelete','canClose','canApiSend','canAdmin'])assert.equal(saved[field],false);
    assert(await pda.locator('[data-action="create"]').isChecked(),'Save/reload must retain PDA assignment');
    await pda.locator('[data-action="create"]').uncheck();await page.getByRole('button',{name:'역할 저장',exact:true}).click();
    await page.waitForFunction(()=>__saves.length===2&&document.getElementById('m02-role-revision').value==='3');
    await page.locator('#p-access-control').screenshot({path:path.join(artifacts,'pda-permission-row.png')});
    await page.locator('[data-role-id="admin-role"]').click();assert(await pda.locator('[data-action="view"]').isDisabled());
    const switchPermissions=async permissions=>page.evaluate(async permissions=>{__session.permissions=permissions;await DBMTAuth.initializeSession(true);},permissions);
    await switchPermissions([{menuCode:'transactions',canView:true,canCreate:true},{menuCode:'stock',canView:true}]);
    assert(await page.locator('#nav-pda').isHidden(),'Old office grants must not bypass PDA rights');
    await switchPermissions([{menuCode:'pda',canView:true,canCreate:true}]);
    assert(await page.locator('#nav-pda').isVisible());assert(await page.locator('#nav-transactions').isHidden());assert(await page.locator('#nav-stock').isHidden());
    assert.equal(await page.locator('.tab-panel.active').count(),0,'PDA-only role must not see an unauthorized office page');
    assert.equal(await page.evaluate(()=>__opened.length),0,'Logging in must not auto-open the standalone PDA');
    await page.locator('#nav-pda').click();assert.equal((await page.evaluate(()=>__opened[0]))[0],'pda.html?v=20261013pda2');
    await switchPermissions([{menuCode:'pda',canView:false,canCreate:true}]);assert(await page.locator('#nav-pda').isHidden());
    await switchPermissions([{menuCode:'transactions',canView:true}]);assert.equal(await page.locator('.tab-panel.active').getAttribute('id'),'p-transactions','Returning from a PDA-only session must restore an allowed office page');
    assert.deepEqual(errors,[]);
    console.log('PASS: actual permission form, PDA view/create save roundtrip, unsupported/bulk/system-role controls, independent navigation, no auto-popup or unauthorized office page');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
