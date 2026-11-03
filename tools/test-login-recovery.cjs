// Actual login UI/auth module/startup coordinator; fictional RPCs, no live accounts.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const auth=fs.readFileSync(path.join(root,'m02-auth.js'),'utf8');
new vm.Script(auth);
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
const modal=html.slice(html.indexOf('<div id="m02-login-modal"'),html.indexOf('<!-- ── 거래내역 수정 모달'));
const startup=html.slice(html.indexOf('let authenticatedErpStartPromise = null;'),html.indexOf('window.lockErpForLogin ='));
const mainCss=fs.readFileSync(path.join(root,'styles/main.css'),'utf8');
const css=fs.readFileSync(path.join(root,'styles/m02-access-control.css'),'utf8');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-login-recovery-'));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 try{
  const context=await browser.newContext({viewport:{width:1100,height:800}});
  await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  async function open({stored=false,restoreFail=false,loadFail=false}={}){
   await page.goto('http://login.test');
   await page.evaluate(({stored,restoreFail,loadFail})=>{
    localStorage.clear();sessionStorage.clear();
    if(stored)sessionStorage.setItem('dbmt_erp_user_session_token','qa-session');
    window.qa={calls:[],loads:0,starts:0,restoreFail,loadFail,wrong:false,expired:false,pending:false,release:null};
    window.qaUser={id:'qa-user',loginId:'qa-user',displayName:'테스트 사용자',roleName:'테스트 역할'};
    window.sbRpc=async(name,args)=>{
     qa.calls.push({name,args});
     if(name==='dbmt_erp_login'){
      if(qa.authPending)await new Promise(resolve=>qa.authRelease=resolve);
      if(qa.wrong)return {ok:false,message:'아이디 또는 비밀번호가 맞지 않습니다.'};
      return {ok:true,token:'qa-session',user:qaUser,permissions:[]};
     }
     if(name==='dbmt_erp_session'){
      if(qa.restoreFail)throw Object.assign(new Error('canceling statement due to statement timeout'),{code:'57014'});
      if(qa.expired)return {ok:false,message:'사용자 로그인이 만료되었습니다.'};
      return {ok:true,user:qaUser,permissions:[]};
     }
     if(name==='dbmt_erp_logout')return true;
     throw new Error('Unexpected RPC: '+name);
    };
    window.requireSupabasePassword=()=>DBMTAuth.getSessionToken();
    window.SUPABASE_ENABLED_KEY='qa-enabled';
    window.supabaseInit=async()=>{
     qa.loads++;
     if(qa.pending)await new Promise(resolve=>qa.release=resolve);
     if(qa.loadFail)throw Object.assign(new Error('canceling statement due to statement timeout'),{code:'57014'});
     return {ok:true};
    };
    window.DBMTWorkOrders={start:async()=>{qa.starts++;},stop(){}};
    window.lockErpForLogin=()=>{document.body.classList.add('erp-auth-locked');document.getElementById('m02-login-modal').classList.remove('hidden');};
   },{stored,restoreFail,loadFail});
   await page.setContent(`<style>${mainCss}\n${css}</style><body class="erp-auth-locked">${modal}<div class="app-body">ERP</div></body>`);
   await page.addScriptTag({content:startup});
   await page.addScriptTag({content:auth});
   await page.waitForFunction(()=>!document.getElementById('m02-login-submit').disabled);
  }
  async function credentials(){await page.locator('#m02-login-id').fill('qa-user');await page.locator('#m02-login-password').fill('0123');}
  const names=()=>page.evaluate(()=>qa.calls.map(x=>x.name));
  await open();await credentials();
  await page.evaluate(()=>{qa.wrong=true;});await page.locator('#m02-login-submit').click();
  await page.waitForFunction(()=>document.getElementById('m02-login-error').textContent.includes('맞지 않습니다'));
  assert.equal(await page.evaluate(()=>qa.loads),0);
  assert(await page.locator('.m02-login-fields').isVisible());
  await page.evaluate(()=>{qa.wrong=false;qa.authPending=true;qa.pending=true;qa.loadFail=true;});
  await page.locator('#m02-login-submit').click();
  await page.waitForFunction(()=>Boolean(qa.authRelease));
  assert.match(await page.locator('#m02-login-status').textContent(),/아이디와 비밀번호/);
  await page.evaluate(()=>{DBMTAuth.loginFromModal();DBMTAuth.loginFromModal();qa.authRelease();});
  await page.waitForFunction(()=>Boolean(qa.release));
  assert.equal((await names()).filter(n=>n==='dbmt_erp_login').length,2,'One wrong attempt + one successful authentication, no double-click duplicates');
  assert.match(await page.locator('#m02-login-status').textContent(),/로그인 완료/);
  assert.equal(await page.locator('#m02-login-password').inputValue(),'');
  assert(await page.locator('.m02-login-fields').isHidden());
  assert(await page.locator('#m02-login-submit').isDisabled());
  assert(await page.evaluate(()=>document.body.classList.contains('erp-auth-locked')));
  await page.evaluate(()=>qa.release());
  await page.waitForFunction(()=>document.getElementById('m02-login-submit').textContent==='자료 다시 불러오기');
  assert.match(await page.locator('#m02-login-error').textContent(),/서버 자료 조회 시간이 초과/);
  assert(await page.evaluate(()=>DBMTAuth.isPersonal()));
  await page.screenshot({path:path.join(artifacts,'load-failed.png')});
  await page.evaluate(()=>{qa.loadFail=false;qa.pending=true;qa.release=null;});
  await page.locator('#m02-login-submit').click();
  await page.waitForFunction(()=>Boolean(qa.release));
  await page.evaluate(()=>{DBMTAuth.loginFromModal();DBMTAuth.loginFromModal();qa.release();});
  await page.waitForFunction(()=>document.getElementById('m02-login-modal').classList.contains('hidden'));
  assert.equal(await page.evaluate(()=>qa.loads),2,'Only failed initialization is retried');
  assert.equal((await names()).filter(n=>n==='dbmt_erp_login').length,2,'Retry does not authenticate again');
  assert.equal((await names()).filter(n=>n==='dbmt_erp_session').length,1,'Retry verifies current session');
  assert(!await page.evaluate(()=>document.body.classList.contains('erp-auth-locked')));
  // Reload with saved authentication: failed data loading remains recoverable.
  await open({stored:true,loadFail:true});
  assert.equal(await page.locator('#m02-login-submit').textContent(),'자료 다시 불러오기');
  assert(!(await names()).includes('dbmt_erp_login'));
  await page.evaluate(()=>{qa.expired=true;});await page.locator('#m02-login-submit').click();
  await page.waitForFunction(()=>document.getElementById('m02-login-submit').textContent==='로그인');
  assert(await page.locator('.m02-login-fields').isVisible());
  assert.equal(await page.evaluate(()=>DBMTAuth.getSessionToken()),'');
  assert.equal(await page.evaluate(()=>qa.loads),1,'Expired session cannot retry data loading');
  // A transient failure restoring a saved session must not become a credential failure.
  await open({stored:true,restoreFail:true});
  assert.equal(await page.locator('#m02-login-submit').textContent(),'로그인 상태 다시 확인');
  assert(await page.locator('.m02-login-fields').isHidden());
  await page.evaluate(()=>{qa.restoreFail=false;});await page.locator('#m02-login-submit').click();
  await page.waitForFunction(()=>document.getElementById('m02-login-modal').classList.contains('hidden'));
  assert(!(await names()).includes('dbmt_erp_login'));
  await open({stored:true,loadFail:true});
  await page.locator('#m02-login-change-user').click();
  assert.equal(await page.evaluate(()=>DBMTAuth.getSessionToken()),'');
  assert(await page.locator('.m02-login-fields').isVisible());
  assert.equal(await page.locator('#m02-login-error').textContent(),'');
  assert((await names()).includes('dbmt_erp_logout'));
  await page.setViewportSize({width:360,height:640});await credentials();
  await page.locator('#m02-login-submit').click();
  await page.waitForFunction(()=>document.getElementById('m02-login-submit').textContent==='자료 다시 불러오기');
  const box=await page.locator('.m02-login-box').boundingBox();assert(box.x>=0&&box.x+box.width<=360&&box.y>=0&&box.y+box.height<=640);
  await page.screenshot({path:path.join(artifacts,'load-failed-mobile.png')});
  assert.deepEqual(errors,[]);
  // Whole ERP smoke check: actual HTML, modules, fetch wrapper and initialization.
  const full=await context.newPage(),fullCalls=[],fullErrors=[];
  let failFullLoad=true;
  full.on('pageerror',error=>fullErrors.push(error.message));
  await full.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(request.method()==='POST'){
    const name=url.pathname.split('/').pop();fullCalls.push(name);
    let result;
    if(name==='dbmt_erp_login')result={ok:true,token:'qa-full-session',user:{id:'qa-full-user',loginId:'qa-full',displayName:'가상 사용자'},permissions:[{menuCode:'schedule',canView:true}]};
    else if(name==='dbmt_erp_session')result={ok:true,user:{id:'qa-full-user',displayName:'가상 사용자'},permissions:[{menuCode:'schedule',canView:true}]};
    else if(name==='dbmt_erp_get_all'){
     if(failFullLoad)return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({code:'57014',message:'canceling statement due to statement timeout'})});
     result={transactions:[],prod:[],prices:[],appData:{}};
    }else if(name==='dbmt_erp_get_company_master')result={companies:[],documentSenderProfiles:[]};
    else if(name==='dbmt_erp_get_submaterial_usages')result=[];
    else return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({message:'Unmocked QA request: '+name})});
    return route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
   }
   if(url.origin!=='http://erp.test')return route.abort();
   const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
   if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.fulfill({status:404,body:''});
   return route.fulfill({contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
  });
  await full.goto('http://erp.test/index.html');
  await full.locator('#m02-login-id').fill('qa-full');await full.locator('#m02-login-password').fill('0123');
  await full.locator('#m02-login-submit').click();
  await full.waitForFunction(()=>document.getElementById('m02-login-submit').textContent==='자료 다시 불러오기');
  assert(await full.evaluate(()=>DBMTAuth.isPersonal()&&document.body.classList.contains('erp-auth-locked')));
  failFullLoad=false;
  await full.locator('#m02-login-submit').click();
  await full.waitForFunction(()=>!document.body.classList.contains('erp-auth-locked'));
  assert(await full.locator('#m02-login-modal').isHidden());
  assert.equal(fullCalls.filter(name=>name==='dbmt_erp_login').length,1);
  assert.equal(fullCalls.filter(name=>name==='dbmt_erp_get_all').length,2);
  assert.deepEqual(fullErrors,[]);
  console.log('PASS: credential/initial-load/restore states, retained authentication, query-only retry, repeated-click guard, expired sessions, account change, locked ERP, password clearing and mobile layout.');
  console.log('PASS: full ERP initializes through the actual fetch/startup path after retry, with no repeated login.');
  console.log('Artifacts: '+artifacts);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
