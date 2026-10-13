const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1366,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><main class="main"></main></html>'}));
    await page.goto('http://expense.test/');
    const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
    await page.evaluate(markup=>{
      const template=document.createElement('template');template.innerHTML=markup;
      const panel=template.content.querySelector('#p-expense');panel.classList.add('active');
      document.querySelector('main').append(panel);
    },html);
    for(const file of ['styles/main.css','styles/expense-stores.css'])await page.addStyleTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    await page.addScriptTag({content:`
      var today='2026-10-13',qaToken='qa-session',qaRights={view:true,delete:true},qaHidden=['이미 삭제한 구매처'],qaCalls=[],qaSaves=[],qaFailure=false,qaDelay=false,qaRelease;
      var DBMTAuth={isPersonal:()=>!!qaToken,can:(_,action)=>qaRights[action],getSessionToken:()=>qaToken};
      function gsSaveAppData(){qaSaves.push(structuredClone(expenseList));}
      function toast(){} function renderExpenses(){} function normalizeExpenseCategory(value){return value;}
      function queueAppDataChangeDetail(){} function dataChangeDateLabel(value){return value;}
      async function sbRpc(name,params){
        qaCalls.push({name,params});
        if(qaDelay)await new Promise(resolve=>{qaRelease=resolve;});
        if(qaFailure)throw new Error('QA 저장 오류');
        if(name==='dbmt_erp_hide_expense_store')qaHidden=[...new Set([...qaHidden,params.p_store])];
        return {ok:true,stores:structuredClone(qaHidden)};
      }
      localStorage.setItem('dbmt_expenses',JSON.stringify(['쿠팡',' 쿠팡 ','천공(중국집)','테스트 "특수<&>','이미 삭제한 구매처',''].map((store,index)=>({id:index+1,date:today,store,item:'기존 지출',amount:1000,category:'식대'}))));
    `});
    await page.addScriptTag({content:html.slice(html.indexOf('let expenseList ='),html.indexOf('const EXP_PAY_COLORS ='))});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'expense-stores.js'),'utf8')});
    await page.evaluate(()=>{clearExpenseForm();return DBMTExpenseStores.load();});
    const before=await page.evaluate(()=>structuredClone(expenseList));
    const input=page.locator('#exp-store'),popup=page.locator('#exp-store-popup');
    const names=()=>page.locator('.exp-store-select').allTextContents();
    await input.click();
    assert.equal(await popup.isVisible(),true);
    assert.equal(await input.getAttribute('autocomplete'),'off');
    assert.equal(await input.getAttribute('list'),null,'Native datalist is replaced');
    assert.deepEqual(await names(),['쿠팡','천공(중국집)','테스트 "특수<&>'].sort((a,b)=>a.localeCompare(b,'ko',{numeric:true})),'Duplicate/blank/deleted candidates are excluded');
    assert.equal(await page.locator('#exp-store-options img').count(),0,'Names are rendered as plain text');
    await input.fill('천공');
    assert.deepEqual(await names(),['천공(중국집)']);
    await page.locator('.exp-store-select').click();
    assert.equal(await input.inputValue(),'천공(중국집)');
    assert.equal(await popup.isVisible(),false);
    await input.fill('');await input.press('ArrowDown');
    assert.equal(await page.locator('.exp-store-select').first().evaluate(node=>node===document.activeElement),true);
    await page.keyboard.press('Escape');assert.equal(await popup.isVisible(),false);
    await page.locator('#exp-store-toggle').click();assert.equal(await popup.isVisible(),true);
    await page.getByRole('button',{name:'쿠팡 후보 삭제',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('[data-action="delete"][data-store="쿠팡"]'));
    assert.equal(await popup.isVisible(),true,'Deleting keeps the candidate list open');
    assert.equal((await names()).includes('쿠팡'),false);
    assert.deepEqual(await page.evaluate(()=>expenseList),before,'Candidate deletion must not change historical expenses');
    assert.equal(await page.evaluate(()=>qaSaves.length),0,'Candidate deletion does not save or overwrite expenseList');
    await page.evaluate(()=>DBMTExpenseStores.load());
    assert.equal((await names()).includes('쿠팡'),false,'Server reload retains deletion');
    await page.screenshot({path:path.join(os.tmpdir(),'dbmt-expense-stores-qa.png'),fullPage:true});
    await page.evaluate(()=>{qaFailure=true;});
    await page.getByRole('button',{name:'천공(중국집) 후보 삭제',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('exp-store-status').textContent.includes('QA 저장 오류'));
    assert.equal((await names()).includes('천공(중국집)'),true,'Failed deletion leaves the candidate available');
    await page.evaluate(()=>{qaFailure=false;});
    await page.getByRole('button',{name:'다시 불러오기'}).click();
    await page.waitForFunction(()=>!document.getElementById('exp-store-status').textContent.includes('QA 저장 오류'));
    await input.fill('쿠팡');
    await page.locator('#exp-item').fill('다시 구매');await page.locator('#exp-amount').fill('2000');
    await page.locator('#exp-add-btn').click();
    assert.equal(await page.evaluate(()=>expenseList.at(-1).store),'쿠팡','A removed candidate can still be entered manually');
    await input.fill('');
    assert.equal((await names()).includes('쿠팡'),false,'Later expense saves cannot resurrect an excluded candidate');
    await page.evaluate(()=>{qaRights.delete=false;DBMTExpenseStores.applyPermissions();});
    assert.equal(await page.locator('.exp-store-delete').count(),0,'Read-only users cannot delete candidates');
    await input.fill('천공');await page.locator('.exp-store-select').click();
    assert.equal(await input.inputValue(),'천공(중국집)','Read-only users can select candidates');
    await page.evaluate(()=>{qaDelay=true;});
    const pending=page.evaluate(()=>DBMTExpenseStores.load());
    await page.waitForFunction(()=>typeof qaRelease==='function');
    await page.evaluate(()=>{qaToken='';DBMTExpenseStores.applyPermissions();qaRelease();});
    await pending;
    assert.equal(await popup.isVisible(),false,'Logout closes the candidate list');
    assert.equal(await page.locator('.exp-store-select').count(),0,'Delayed response does not restore candidates after logout');
    await page.evaluate(()=>{qaToken='next-session';qaDelay=false;qaRights={view:true,delete:true};qaHidden=[];return DBMTExpenseStores.load();});
    await input.fill('');
    assert.equal((await names()).includes('쿠팡'),true,'A new session loads its server state instead of retaining stale exclusions');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Mobile picker stays within the page');
    await page.locator('#p-expense .card-title').first().click();assert.equal(await popup.isVisible(),false,'Clicking outside closes the list');
    assert.deepEqual(errors,[]);
    console.log('PASS: expense candidate search/select/delete, durable exclusions, no expense history changes, save failure, manual entry, permissions, logout race, keyboard and mobile layout');
    console.log('Screenshot: '+path.join(os.tmpdir(),'dbmt-expense-stores-qa.png'));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
