/* Real calendar/drag handlers, fictional schedules and intercepted RPCs only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const start=html.indexOf('let scheduleEvents ='),end=html.indexOf('async function openProductionByDate(',start);
assert.ok(start>=0&&end>start);
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-schedule-drag-'));
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'Asia/Seoul'}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><meta charset="utf-8"><body></body></html>'}));
    await page.goto('http://127.0.0.1/schedule-fixture');
    await page.evaluate(markup=>{const t=document.createElement('template');t.innerHTML=markup;document.body.append(t.content.querySelector('#p-schedule'));},html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
    await page.addScriptTag({content:`
      var today='2026-09-23',EXCEL_PROD=[],userProdEntries=[],dataChangeLogs=[],notices=[],qaCalls=[],qaToken='qa-session';
      var qaRights={view:true,create:true,update:true,delete:true},qaMode='',qaPending=null,qaSequence=0;
      var qaEvents=[{id:'qa-move',date:today,text:'회의 <안건> & 확인',custom:'preserve'},
        {id:'qa-other',date:today,text:'다른 일정'}];
      localStorage.setItem('dbmt_schedule_events',JSON.stringify(qaEvents));
      var DBMTAuth={isPersonal:()=>!!qaToken,can:(_,action)=>qaRights[action],getSessionToken:()=>qaToken};
      function htmlEscape(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
      function jsArg(value){return htmlEscape(JSON.stringify(value));}
      function toast(message){notices.push(message);}
      function safeLocalStorageSet(key,value){localStorage.setItem(key,value);}
      function saveDataChangeLogsLocal(){}
      function resetDataChangeAppDataBaseline(){}
      function isProductionCountedEntry(){return true;}
      function normProdDate(value){return value.replaceAll('/','-');}
      function parseAppNumber(value){return Number(value)||0;}
      async function sbRpc(name,p){
        qaCalls.push({name,p:structuredClone(p)});
        if(qaMode==='failure')throw new Error('QA 저장 실패');
        if(qaMode==='denied')return {ok:false,message:'QA 권한 없음'};
        if(qaMode==='defer')await new Promise(resolve=>qaPending=resolve);
        if(name==='dbmt_erp_save_schedule'){
          const old=qaEvents.find(row=>row.id===p.p_id);
          const event={...old,id:p.p_id||'qa-new-'+(++qaSequence),date:p.p_date,text:p.p_text};
          qaEvents=qaEvents.filter(row=>row.id!==event.id).concat(event);
          return {ok:true,event,events:structuredClone(qaEvents),logEntry:{id:'log-'+(++qaSequence)}};
        }
        if(name==='dbmt_erp_delete_schedule'){
          qaEvents=qaEvents.filter(row=>row.id!==p.p_id);return {ok:true,events:structuredClone(qaEvents)};
        }
        throw new Error('Unexpected RPC '+name);
      }
      ${html.slice(start,end)}
      document.getElementById('sch-month').value='2026-09';renderScheduleCalendar();
    `});
    const card=()=>page.locator('.sch-event[data-schedule-id="qa-move"]');
    const day=date=>page.locator(`.sch-day[data-schedule-date="${date}"]`);
    const dateOfCard=()=>card().evaluate(node=>node.closest('.sch-day').dataset.scheduleDate);
    const count=()=>page.evaluate(()=>qaCalls.length);
    await page.locator('#sch-event-text').fill('작성 중인 새 일정');
    await card().dragTo(day('2026-09-24'));
    await page.waitForFunction(()=>!scheduleWritePending&&scheduleEvents.find(row=>row.id==='qa-move').date==='2026-09-24');
    assert.equal(await dateOfCard(),'2026-09-24');
    assert.deepEqual(await page.evaluate(()=>qaCalls[0]),{name:'dbmt_erp_save_schedule',p:{p_token:'qa-session',p_id:'qa-move',p_date:'2026-09-24',p_text:'회의 <안건> & 확인'}});
    assert.equal(await page.evaluate(()=>scheduleEvents.length),2,'Moving updates the original ID without duplicating it');
    assert.equal(await page.evaluate(()=>scheduleEvents.find(row=>row.id==='qa-move').custom),'preserve');
    assert.equal(await page.locator('#sch-event-text').inputValue(),'작성 중인 새 일정');
    assert.equal(await page.locator('#sch-calendar img,#sch-calendar script').count(),0);
    for(const date of ['2026-10-01','2026-08-31']){
      await card().dragTo(day(date));await page.waitForFunction(date=>!scheduleWritePending&&scheduleEvents.find(row=>row.id==='qa-move').date===date,date);
      assert.equal(await dateOfCard(),date,'Adjacent-month cells accept date moves');
    }
    const sameDateCalls=await count();await card().dragTo(day('2026-08-31'));assert.equal(await count(),sameDateCalls);
    for(const mode of ['failure','denied']){
      await page.evaluate(mode=>qaMode=mode,mode);
      await card().dragTo(day('2026-09-01'));await page.waitForFunction(()=>!scheduleWritePending);
      assert.equal(await dateOfCard(),'2026-08-31','Failure keeps the original date');
      assert.match(await page.evaluate(()=>notices.at(-1)),mode==='failure'?/저장 실패/:/권한 없음/);
    }
    await page.evaluate(()=>qaMode='defer');await card().dragTo(day('2026-09-02'));
    await page.waitForFunction(()=>!!qaPending);
    assert.equal(await dateOfCard(),'2026-08-31','The calendar changes only after server success');
    assert.equal(await card().getAttribute('draggable'),'false');
    assert.equal(await page.locator('#sch-event-add-btn').isDisabled(),true);
    assert.equal(await card().locator('button').isDisabled(),true);
    const pendingCalls=await count();
    await page.evaluate(()=>{addScheduleEvent('2026-09-23');deleteScheduleEvent('qa-other');});
    assert.equal(await count(),pendingCalls,'Concurrent add/delete cannot overwrite a pending move');
    await page.evaluate(()=>{qaMode='';qaPending();qaPending=null;});
    await page.waitForFunction(()=>!scheduleWritePending);assert.equal(await dateOfCard(),'2026-09-02');
    assert.equal(await page.locator('#sch-event-add-btn').isDisabled(),false);
    await page.evaluate(()=>{qaRights.update=false;renderScheduleCalendar();});
    assert.equal(await card().getAttribute('draggable'),'false');
    const deniedCalls=await count(),transfer=await page.evaluateHandle(()=>new DataTransfer());
    await card().dispatchEvent('dragstart',{dataTransfer:transfer});
    await day('2026-09-04').dispatchEvent('drop',{dataTransfer:transfer});assert.equal(await count(),deniedCalls);
    await page.evaluate(()=>{qaRights.update=true;renderScheduleCalendar();});
    await card().locator('button').dispatchEvent('dragstart',{dataTransfer:transfer});
    await day('2026-09-04').dispatchEvent('drop',{dataTransfer:transfer});assert.equal(await count(),deniedCalls,'Delete buttons cannot start a move');
    await day('2026-09-04').dispatchEvent('drop',{dataTransfer:transfer});assert.equal(await count(),deniedCalls,'External drops cannot move an event');
    await card().dispatchEvent('dragstart',{dataTransfer:transfer});
    await page.evaluate(()=>scheduleEvents.find(row=>row.id==='qa-move').text='수정된 내용');
    await day('2026-09-04').dispatchEvent('drop',{dataTransfer:transfer});assert.equal(await count(),deniedCalls,'A changed local event cancels a stale drag');
    await page.evaluate(()=>{scheduleEvents=structuredClone(qaEvents);renderScheduleCalendar();qaMode='defer';});
    await card().dragTo(day('2026-09-05'));await page.waitForFunction(()=>!!qaPending);
    await page.evaluate(()=>{qaToken='other-session';scheduleEvents=[{id:'new-user',date:today,text:'새 사용자 일정'}];qaMode='';qaPending();qaPending=null;});
    await page.waitForFunction(()=>!scheduleWritePending);
    assert.deepEqual(await page.evaluate(()=>scheduleEvents.map(row=>row.id)),['new-user'],'An old-session response cannot change the new user calendar');
    // Existing add/delete still save and release the shared controls.
    await page.evaluate(async()=>{qaEvents=structuredClone(scheduleEvents);document.getElementById('sch-event-text').value='신규 일정';await addScheduleEvent('2026-09-25');});
    assert.equal(await page.locator('.sch-day[data-schedule-date="2026-09-25"] .sch-event').count(),1);
    await page.locator('.sch-day[data-schedule-date="2026-09-25"] .sch-event button').click();
    await page.waitForFunction(()=>!scheduleWritePending);assert.equal(await page.locator('.sch-day[data-schedule-date="2026-09-25"] .sch-event').count(),0);
    await page.screenshot({path:path.join(artifacts,'schedule-calendar.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('PASS: real mouse drag, stable ID/text/metadata, adjacent months, same-day no-op, failed/denied saves, pending locks, draft preservation, update rights, button/external/stale drag rejection, session isolation and existing add/delete');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
