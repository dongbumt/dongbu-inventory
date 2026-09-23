const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-production-schedule-'));
  try{
    const page=await browser.newPage({viewport:{width:1400,height:1080}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.abort());
    await page.setContent('<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body><main style="padding:12px"></main></body></html>');
    await page.evaluate(markup=>{
      const template=document.createElement('template');template.innerHTML=markup;
      const panel=template.content.querySelector('#p-production-schedule');panel.classList.add('active');
      document.querySelector('main').append(panel);
    },html);
    for(const file of ['styles/main.css','styles/production-schedule.css']) await page.addStyleTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    await page.addScriptTag({content:`
      var qaToken='qa-session',qaRights={view:true,create:true,update:true,delete:true},qaRows=[],qaCalls=[],qaFailure=false,qaSequence=0;
      var labelProducts=[{name:'냉장돈등심(작업)'},{name:'돈뒷다리(작업)'}];
      var DBMTAuth={isPersonal:()=>!!qaToken,can:(_,action)=>qaRights[action],getSessionToken:()=>qaToken};
      function getKoreanHoliday(){return '';}
      window.confirm=()=>true;
      async function sbRpc(name,p){
        qaCalls.push({name,p});
        if(qaFailure) throw new Error('QA 서버 오류');
        if(name.includes('_get_')) return {ok:true,events:structuredClone(qaRows.filter(r=>r.date>=p.p_start&&r.date<=p.p_end))};
        if(name.includes('_save_')){
          const old=qaRows.find(r=>r.id===p.p_id);
          if(old&&old.revision!==p.p_revision) throw new Error('다른 사용자가 변경했습니다.');
          const event={...p.p_record,id:p.p_id||'qa-'+(++qaSequence),revision:(old?.revision||0)+1};
          qaRows=qaRows.filter(r=>r.id!==event.id).concat(event);return {ok:true,event:structuredClone(event)};
        }
        qaRows=qaRows.filter(r=>r.id!==p.p_id);return {ok:true,id:p.p_id};
      }
    `});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'production-schedule.js'),'utf8')});
    await page.locator('#ps-month').fill('2026-09');
    await page.evaluate(()=>DBMTProductionSchedule.init());
    assert.equal(await page.locator('.ps-day').count(),35);
    assert.equal(await page.locator('.ps-day').first().getAttribute('data-date'),'2026-08-30');
    assert.equal(await page.locator('.ps-day').last().getAttribute('data-date'),'2026-10-03');
    await page.locator('[data-action="date"][data-date="2026-09-23"]').click();
    await page.locator('#ps-product').fill('냉장돈등심(작업)');
    await page.locator('#ps-qty').fill('250.5');
    await page.locator('#ps-trader').fill('가상 납품처');
    await page.locator('#ps-note').fill('5KG 포장 / 3mm 슬라이스');
    await page.locator('#ps-save').click();
    assert.equal(await page.locator('.ps-item').count(),1);
    assert.match(await page.locator('#ps-summary').textContent(),/250.5/);
    assert.equal(await page.locator('#ps-product').inputValue(),'');
    assert.equal(await page.locator('#ps-date').inputValue(),'2026-09-23');
    await page.locator('#ps-product').fill('돈뒷다리(작업)');
    await page.locator('#ps-note').fill('규격 미정');
    await page.locator('#ps-save').click();
    assert.match(await page.locator('[data-plan-id="qa-2"]').textContent(),/수량 미정/);
    await page.locator('[data-action="edit"][data-id="qa-1"]').click();
    await page.locator('#ps-date').fill('2026-09-25');
    await page.locator('#ps-qty').fill('300');
    await page.locator('#ps-status').selectOption('completed');
    await page.locator('#ps-save').click();
    assert.equal(await page.locator('.ps-day[data-date="2026-09-25"] .ps-item').count(),1);
    assert.match(await page.locator('#ps-summary').textContent(),/완료 1건/);
    await page.evaluate(()=>DBMTProductionSchedule.load());
    assert.equal(await page.locator('.ps-item').count(),2,'Reload retains saved plans');
    await page.screenshot({path:path.join(artifacts,'calendar-desktop.png'),fullPage:true});
    await page.locator('#ps-month').fill('2026-01');await page.evaluate(()=>DBMTProductionSchedule.load());
    assert.equal(await page.locator('.ps-day').first().getAttribute('data-date'),'2025-12-28');
    await page.locator('#ps-month').fill('2026-02');await page.evaluate(()=>DBMTProductionSchedule.load());
    assert.equal(await page.locator('.ps-day').count(),28);
    await page.locator('#ps-month').fill('2026-09');await page.evaluate(()=>DBMTProductionSchedule.load());
    await page.locator('[data-action="edit"][data-id="qa-1"]').click();
    await page.evaluate(()=>{qaRows.find(r=>r.id==='qa-1').revision++;});
    await page.locator('#ps-save').click();
    assert.match(await page.locator('#ps-message').textContent(),/다른 사용자/);
    assert.equal(await page.locator('#ps-product').inputValue(),'냉장돈등심(작업)');
    await page.evaluate(()=>{DBMTProductionSchedule.reset();qaFailure=true;});
    await page.locator('#ps-product').fill('실패시 보존');await page.locator('#ps-save').click();
    assert.match(await page.locator('#ps-message').textContent(),/QA 서버 오류/);
    assert.equal(await page.locator('#ps-product').inputValue(),'실패시 보존');
    await page.evaluate(()=>{qaFailure=false;DBMTProductionSchedule.reset();});
    await page.evaluate(()=>DBMTProductionSchedule.load());
    await page.locator('[data-action="delete"][data-id="qa-2"]').click();
    assert.equal(await page.locator('.ps-item').count(),1);
    await page.evaluate(()=>{qaRights={view:true,create:false,update:false,delete:false};DBMTProductionSchedule.applyPermissions();});
    await page.evaluate(()=>DBMTProductionSchedule.load());
    assert.equal(await page.locator('#ps-editor').isVisible(),false);
    assert.equal(await page.locator('[data-action="delete"]').count(),0);
    assert.equal(await page.locator('.ps-item-main').isDisabled(),true);
    const count=await page.evaluate(()=>qaCalls.length);await page.evaluate(()=>DBMTProductionSchedule.save());
    assert.equal(await page.evaluate(()=>qaCalls.length),count);
    await page.evaluate(()=>{qaRights={view:true,create:true,update:true,delete:true};DBMTProductionSchedule.applyPermissions();});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Calendar scroll stays inside its container');
    await page.screenshot({path:path.join(artifacts,'calendar-mobile.png'),fullPage:true});
    await page.evaluate(()=>{qaToken='';DBMTProductionSchedule.applyPermissions();});
    assert.equal(await page.locator('.ps-item').count(),0,'Logout clears private plans');
    assert.equal(await page.locator('#ps-product').inputValue(),'');
    assert.deepEqual(errors,[]);
    assert.match(fs.readFileSync(path.join(root,'m02-auth.js'),'utf8'),/'nav-production-schedule':'production_schedule'/);
    console.log('PASS: calendar boundaries, create/edit/move/complete/delete, optional quantity, reload, failed saves, revision conflicts, view-only permissions, mobile containment, logout');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
