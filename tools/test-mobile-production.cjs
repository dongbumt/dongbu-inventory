const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'mobile-admin.html'),'utf8');
for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(m[1].trim())new vm.Script(m[1]);
new vm.Script(fs.readFileSync(path.join(root,'mobile-production.js'),'utf8'));

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const artifactDir=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-mobile-production-'));
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Asia/Seoul'}),page=await context.newPage();
    await page.clock.install({time:new Date('2026-10-15T03:00:00Z')});
    const errors=[],calls=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
    let plans=[{id:'11111111-1111-4111-8111-111111111111',date:'2026-10-15',product:'돈등심',qty:100,trader:'동원홈푸드',note:'3mm',status:'planned',revision:1},
      {id:'22222222-2222-4222-8222-222222222222',date:'2026-10-15',product:'우둔살',qty:50,trader:'직납',note:'완료 건',status:'completed',revision:1}];
    const orders=[{id:'old',date:'2026-10-15',product:'기존 생산물',title:'기존 작업지시',lot:'OLD-LOT',sourceStock:{product:'돈등심',origin:'국내산',lot:'RAW-OLD'},inputWeight:12.5,mfgdate:'2026-10-15',expdate:'2027-10-14',temptype:'냉동'},
      {id:'multi',date:'2026-10-14',product:'여러 원료 생산물',title:'혼합 작업',lot:'MULTI-LOT',sourceInputs:[{sourceStock:{product:'돈등심',origin:'국내산',lot:'RAW-ONE'},inputWeight:10},{sourceStock:{product:'우둔살',origin:'호주산',lot:'RAW-TWO'},inputWeight:20}],packunit:'5KG',temptype:'냉장'}];
    let saveFailure=false,loadFailure=false,delayPlans=false,delaySnapshot=false,releasePlans,releaseSnapshot,sequence=0;
    const clone=value=>JSON.parse(JSON.stringify(value));
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin==='http://mobile.test'){
        const file=url.pathname==='/'?'mobile-admin.html':url.pathname.slice(1);
        if(!['mobile-admin.html','mobile-production.js','stock-ledger.js','styles/mobile-production.css'].includes(file))return route.fulfill({status:404,body:''});
        return route.fulfill({contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html',body:fs.readFileSync(path.join(root,file),'utf8')});
      }
      const headers={'access-control-allow-origin':'*','access-control-allow-headers':'apikey,authorization,content-type','access-control-allow-methods':'POST,OPTIONS'};
      if(request.method()==='OPTIONS')return route.fulfill({status:204,headers,body:''});
      const name=url.pathname.split('/').at(-1),params=request.postDataJSON();calls.push({name,params});
      const ok=value=>route.fulfill({headers,contentType:'application/json',body:JSON.stringify(clone(value))});
      const fail=message=>route.fulfill({status:400,headers,contentType:'application/json',body:JSON.stringify({message})});
      if(name==='dbmt_mobile_admin_snapshot'){
        if(delaySnapshot)await new Promise(resolve=>{releaseSnapshot=resolve;});
        return ok({account:{displayName:'QA 관리자'},serverTime:'2026-10-15T03:00:00Z',transactions:[],prod:[],appData:{scheduleEvents:[],employees:[],expenseList:[]}});
      }
      if(name==='dbmt_mobile_admin_driver_week')return ok({attendance:[]});
      if(name==='dbmt_mobile_admin_login')return ok({ok:true,token:'qa-next-session'});
      if(name==='dbmt_mobile_admin_logout')return ok(true);
      if(name==='dbmt_mobile_admin_production_schedule'){
        if(delayPlans)await new Promise(resolve=>{releasePlans=resolve;});
        if(loadFailure)return fail('QA 조회 오류');
        return ok({ok:true,events:plans.filter(row=>row.date>=params.p_start&&row.date<=params.p_end)});
      }
      if(name==='dbmt_mobile_admin_save_production_schedule'){
        if(saveFailure)return fail('QA 저장 오류');
        const old=plans.find(row=>row.id===params.p_id);
        if(old&&old.revision!==params.p_revision)return fail('다른 사용자가 이 일정을 변경했습니다. 새로고침 후 다시 수정해주세요.');
        const record={...params.p_record,id:params.p_id||'33333333-3333-4333-8333-'+String(++sequence).padStart(12,'0'),revision:(old?.revision||0)+1};
        plans=plans.filter(row=>row.id!==record.id).concat(record);return ok({ok:true,event:record});
      }
      if(name==='dbmt_mobile_admin_delete_production_schedule'){
        const old=plans.find(row=>row.id===params.p_id);if(old?.revision!==params.p_revision)return fail('다른 사용자가 이 일정을 변경했습니다.');
        plans=plans.filter(row=>row.id!==params.p_id);return ok({ok:true,id:params.p_id});
      }
      if(name==='dbmt_mobile_admin_work_orders')return ok({ok:true,orders:orders.filter(row=>row.date>=params.p_start&&row.date<=params.p_end)});
      errors.push('Unexpected network request: '+name);return fail('Unexpected RPC');
    });
    await context.addInitScript(()=>{if(location.origin==='http://mobile.test'){localStorage.setItem('dbmt_mobile_admin_session_token','qa-mobile-session');localStorage.setItem('dbmt_mobile_admin_view','production-plan');}});
    await page.goto('http://mobile.test/');
    await page.locator('#mp-list').getByText('돈등심',{exact:false}).waitFor();
    assert.equal(await page.locator('.menu button').count(),9);assert.equal(await page.locator('#mp-grid button').count(),21);
    assert.match(await page.locator('#mp-totals').innerText(),/예정 100 KG/);assert.match(await page.locator('#mp-totals').innerText(),/완료 50 KG/);
    await page.locator('#mp-add').click();await page.locator('#mp-product').fill('새 생산품');await page.locator('#mp-trader').fill('삼성웰스토리');await page.locator('#mp-note').fill('5KG 진공포장');await page.locator('#mp-save').click();
    await page.waitForFunction(()=>document.getElementById('mp-message').textContent==='생산일정을 저장했습니다.');
    assert.equal(plans.find(row=>row.product==='새 생산품').qty,null);
    const row=product=>page.locator('#mp-list .row').filter({has:page.locator('.row-title',{hasText:product})});
    await row('새 생산품').getByRole('button',{name:'수정'}).click();await page.locator('#mp-qty').fill('250.5');await page.locator('#mp-status').selectOption('completed');await page.locator('#mp-save').click();
    await page.waitForFunction(()=>document.getElementById('mp-editor').classList.contains('hidden'));
    assert.equal(plans.find(row=>row.product==='새 생산품').qty,250.5);assert.equal(plans.find(row=>row.product==='새 생산품').status,'completed');
    assert.match(await page.locator('#mp-totals').innerText(),/완료 300.5 KG/);
    await row('돈등심').getByRole('button',{name:'수정'}).click();plans.find(row=>row.product==='돈등심').revision++;
    await page.locator('#mp-note').fill('충돌 입력 보존');await page.locator('#mp-save').click();
    await page.locator('#mp-message').getByText(/다른 사용자/).waitFor();assert.equal(await page.locator('#mp-note').inputValue(),'충돌 입력 보존');
    await page.locator('#mp-cancel').click();await page.locator('[data-view="production-plan"]').click();await page.waitForFunction(()=>document.getElementById('mp-message').textContent==='');
    await row('돈등심').getByRole('button',{name:'수정'}).click();saveFailure=true;await page.locator('#mp-note').fill('실패 입력 보존');await page.locator('#mp-save').click();
    await page.locator('#mp-message').getByText('QA 저장 오류').waitFor();assert.equal(await page.locator('#mp-note').inputValue(),'실패 입력 보존');saveFailure=false;await page.locator('#mp-cancel').click();
    await page.locator('#mp-add').click();await page.locator('#mp-product').fill('다음달 생산품');await page.locator('#mp-date').fill('2026-11-10');await page.locator('#mp-qty').fill('10');loadFailure=true;await page.locator('#mp-save').click();
    await page.locator('#mp-message').getByText('QA 조회 오류').waitFor();assert.equal(plans.some(row=>row.product==='다음달 생산품'),true,'Successful save survives a reload failure');
    loadFailure=false;await page.locator('[data-view="production-plan"]').click();await row('다음달 생산품').waitFor();assert.equal(await page.locator('#mp-anchor').inputValue(),'2026-11-10');
    await row('다음달 생산품').getByRole('button',{name:'수정'}).click();await page.locator('#mp-delete').click();await page.locator('#mp-message').getByText('생산일정을 삭제했습니다.').waitFor();assert.equal(plans.some(row=>row.product==='다음달 생산품'),false);
    await page.locator('#mp-anchor').fill('2026-10-30');await page.locator('#mp-anchor').dispatchEvent('change');await page.waitForFunction(()=>document.getElementById('mp-message').textContent==='');
    assert.equal(await page.locator('[data-plan-date="2026-11-01"]').count(),1,'Three-week calendar spans months');
    await page.locator('#mp-today').click();await page.waitForFunction(()=>document.getElementById('mp-message').textContent==='');
    await page.screenshot({path:path.join(artifactDir,'production.png'),fullPage:true});
    const beforeOrders=JSON.stringify(orders),callStart=calls.length;
    await page.locator('[data-view="workorders"]').click();await page.locator('#mw-list').getByText('여러 원료 생산물').waitFor();
    assert.equal(await page.locator('#view-workorders form,#mw-list button').count(),0,'Work orders have no editing actions');
    await page.locator('#mw-list details').filter({hasText:'우둔살'}).locator('summary').click();
    assert.equal(await page.locator('#mw-list .mp-source').count(),3,'Legacy and multiple input rows are shown');
    await page.locator('#mw-search').fill('우둔살');assert.equal(await page.locator('#mw-list .row').count(),1);assert.match(await page.locator('#mw-list').innerText(),/30 KG/);
    await page.locator('#mw-search').fill('OLD-LOT');assert.equal(await page.locator('#mw-list .row').count(),1);assert.match(await page.locator('#mw-list').innerText(),/기존 생산물/);
    await page.locator('#mw-search').fill('');await page.locator('#mw-list details').filter({hasText:'우둔살'}).locator('summary').click();
    await page.screenshot({path:path.join(artifactDir,'workorders.png'),fullPage:true});
    assert.equal(JSON.stringify(orders),beforeOrders);assert.ok(calls.slice(callStart).every(call=>call.name==='dbmt_mobile_admin_work_orders'),'Work order view only reads');
    await page.locator('[data-view="production-plan"]').click();await page.waitForFunction(()=>document.getElementById('mp-message').textContent==='');
    await page.locator('#mp-add').click();await page.locator('#mp-product').fill('작성 중인 수기 일정');await page.locator('#mp-note').fill('자동 갱신해도 유지');
    plans.push({id:'work-order:old',workOrderId:'old',source:'work_order',readonly:true,date:'2026-10-15',product:'자동 작업지시',qty:12.5,inputQty:12.5,note:'연결 작업',status:'planned',revision:'hash'});
    await page.clock.runFor(5000);
    const automatic=()=>page.locator('#mp-list .row').filter({has:page.locator('[data-plan-order="work-order:old"]')});
    await automatic().waitFor();assert.match(await automatic().innerText(),/투입 12.5 KG/);
    assert.equal(await automatic().locator('[data-plan-edit]').count(),0);
    assert.equal(await page.locator('#mp-product').inputValue(),'작성 중인 수기 일정');assert.equal(await page.locator('#mp-note').inputValue(),'자동 갱신해도 유지');
    await automatic().getByRole('button',{name:'작업지시',exact:true}).click();await page.locator('#mw-list').getByText('기존 생산물',{exact:true}).waitFor();
    assert.equal(await page.locator('#mw-from').inputValue(),'2026-10-15');assert.equal(await page.locator('#mw-to').inputValue(),'2026-10-15');
    await page.locator('[data-view="production-plan"]').click();await automatic().waitFor();
    assert.equal(await page.locator('#mp-product').inputValue(),'작성 중인 수기 일정');
    Object.assign(plans.find(r=>r.source==='work_order'),{status:'completed',qty:10});await page.clock.runFor(5000);
    await automatic().getByText(/생산 10 KG/).waitFor();
    await page.screenshot({path:path.join(artifactDir,'production-work-orders.png'),fullPage:true});
    plans=plans.filter(r=>r.source!=='work_order');await page.clock.runFor(5000);await automatic().waitFor({state:'detached'});
    assert.equal(await page.locator('#mp-note').inputValue(),'자동 갱신해도 유지');assert.equal(JSON.stringify(orders),beforeOrders);
    await page.locator('#mp-cancel').click();
    for(const width of [320,390,760]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`No overflow at ${width}px`);}
    delayPlans=true;await page.locator('[data-view="production-plan"]').click();await page.waitForTimeout(30);assert.equal(typeof releasePlans,'function');
    await page.getByRole('button',{name:'로그아웃'}).click();releasePlans();await page.waitForTimeout(30);
    assert.equal(await page.locator('#app-view').isVisible(),false);assert.equal(await page.locator('#mp-grid button').count(),0,'Late response cannot restore plans after logout');
    delayPlans=false;await page.locator('#login-id').fill('abc');await page.locator('#login-pin').fill('0123');await page.locator('#login-btn').click();await page.locator('#app-view').waitFor({state:'visible'});
    delaySnapshot=true;await page.getByRole('button',{name:'새로고침',exact:true}).click();await page.waitForTimeout(30);assert.equal(typeof releaseSnapshot,'function');
    await page.getByRole('button',{name:'로그아웃'}).click();releaseSnapshot();await page.waitForTimeout(30);
    assert.equal(await page.locator('#app-view').isVisible(),false,'Late snapshot cannot reopen a logged-out session');
    assert.deepEqual(errors,[]);
    console.log('PASS: mobile manual CRUD/status, linked read-only schedules and navigation, automatic add/complete/delete preserves draft, legacy/multiple work orders, no overflow, login/logout races');
    console.log('Screenshots: '+artifactDir);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
