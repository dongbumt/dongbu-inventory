/* Isolated browser regression test with fictional expenses and mocked server saves. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
const source = html.slice(html.indexOf('const WORK_DAYS = 22;'), html.indexOf('function costCompareRecordId('));
const helpers = ['htmlEscape', 'parseAppNumber'].map(name => {
  const match = html.match(new RegExp('function ' + name + '\\([^]*?\\n\\}'));
  assert.ok(match, name);
  return match[0];
}).join('\n');
const defaults = [
  {id:1, name:'인건비', monthlyCost:4400000, active:true},
  {id:2, name:'임대료', monthlyCost:2200000, active:true},
  {id:3, name:'물류비', monthlyCost:1100000, active:false}
];
const material = {id:1, name:'테스트 원료', origin:'국내산', qty:100, price:5000, loss:10};

(async()=>{
  const browser = await chromium.launch({headless:true, executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page = await browser.newPage({viewport:{width:1280,height:1024}, timezoneId:'Asia/Seoul'});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('http://costcalc.test/**', route => route.fulfill({contentType:'text/html', body:'<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body><main></main></body></html>'}));
    async function mount(){
      await page.goto('http://costcalc.test/');
      await page.evaluate(markup => {
        const template = document.createElement('template');
        template.innerHTML = markup;
        const panel = template.content.querySelector('#p-costcalc');
        panel.classList.add('active');
        document.querySelector('main').append(panel);
      }, html);
      await page.addStyleTag({content:fs.readFileSync(path.join(root, 'styles/main.css'), 'utf8')});
      await page.addScriptTag({content:helpers + '\nfunction localShortDateString(){return "2026-09-30";}\nvar savedPayloads=[]; function gsSaveAppData(){savedPayloads.push(JSON.parse(JSON.stringify(costCalcHistory)));}\n' + source});
      await page.evaluate(()=>{renderMaterialRows();renderCostExpenseArea();renderCostHistory();});
    }
    await page.goto('http://costcalc.test/');
    await page.evaluate(rows=>localStorage.setItem('dbmt_pangwanbi',JSON.stringify(rows)),defaults);
    await mount();
    const expenseRows = page.locator('#cc-expense-area tbody tr');
    const amount = index => expenseRows.nth(index).locator('.cc-expense-monthly');
    const active = index => expenseRows.nth(index).locator('.cc-expense-active');
    const result = ()=>page.evaluate(()=>window._ccLastResult);
    const saved = ()=>page.evaluate(()=>JSON.parse(localStorage.getItem('dbmt_costcalc')));
    await page.evaluate(row=>{ccMaterials=[row];renderMaterialRows();},material);
    await page.locator('#cc-daily-qty').fill('1000');
    await page.locator('#cc-sell-price').fill('8000');
    assert.equal(await expenseRows.count(),3,'Inactive defaults remain available for this calculation');
    assert.equal(await active(2).isChecked(),false);
    assert.equal((await result()).totExpCost,27000);

    await amount(0).fill('');
    await amount(0).pressSequentially('6600000');
    assert.equal(await amount(0).inputValue(),'6600000','Recalculation must keep the input focused while typing');
    await expenseRows.nth(1).locator('.cc-expense-name').fill('시설 임대료');
    await active(1).uncheck();
    assert.equal((await result()).totExpCost,27000);
    assert.equal(await expenseRows.nth(1).locator('.cc-expense-state').innerText(),'제외');
    assert.equal(await expenseRows.nth(1).locator('.cc-expense-kg').innerText(),'-');
    assert.doesNotMatch(await page.locator('#cc-breakdown-tbody').innerText(),/시설 임대료/);
    assert.match(await page.locator('#cc-r-info').innerText(),/6,600,000 원\/월/);
    assert.deepEqual(await page.evaluate(()=>pgbList),defaults,'Per-calculation changes do not edit shared expense settings');
    if(process.env.COSTCALC_SCREENSHOT) await page.screenshot({path:process.env.COSTCALC_SCREENSHOT,fullPage:true});
    await page.evaluate(()=>saveCostCalc());
    const first = (await saved())[0];
    assert.equal(JSON.parse(first.expenses)[0].monthlyCost,6600000);
    assert.equal(JSON.parse(first.expenses)[1].active,false);
    assert.equal(JSON.parse(first.expenses)[1].name,'시설 임대료');
    assert.equal(await page.evaluate(()=>savedPayloads[0][0].expenses),first.expenses,'The server payload includes the snapshot');

    // Change the defaults and start another calculation, then reopen both saved
    // calculations after a complete browser page reload.
    await page.evaluate(()=>{
      pgbList[0].monthlyCost=8800000;
      localStorage.setItem('dbmt_pangwanbi',JSON.stringify(pgbList));
      resetCostCalc();
    });
    assert.equal(await amount(0).inputValue(),'8800000','New calculations start from current defaults');
    assert.equal(await active(1).isChecked(),true);
    await page.evaluate(row=>{ccMaterials=[row];renderMaterialRows();},material);
    await page.locator('#cc-daily-qty').fill('1000');
    await active(2).check();
    await page.evaluate(()=>saveCostCalc());
    const second = (await saved())[0];
    assert.equal(second.totExpCost,49500);
    await mount();
    await page.evaluate(id=>loadCostCalc(id),first.id);
    assert.equal(await amount(0).inputValue(),'6600000');
    assert.equal(await active(1).isChecked(),false);
    assert.equal(await active(2).isChecked(),false);
    assert.equal((await result()).totExpCost,first.totExpCost);
    await page.locator('#cc-daily-qty').fill('500');
    assert.equal((await result()).totExpCost,54000);
    assert.equal(await amount(0).inputValue(),'6600000','Changing production volume retains the overridden expense');
    await page.evaluate(id=>loadCostCalc(id),second.id);
    assert.equal(await amount(0).inputValue(),'8800000');
    assert.equal(await active(2).isChecked(),true);
    assert.equal((await result()).totExpCost,second.totExpCost);
    assert.deepEqual((await saved()).find(row=>row.id===first.id),first,'Reopening never rewrites earlier saved calculations');

    // Worker-based labor remains editable and exclusions persist when the
    // worker count is deliberately changed.
    await page.locator('#cc-workers').fill('2');
    assert.equal(await amount(0).inputValue(),'7000000');
    await amount(0).fill('5500000');
    await active(0).uncheck();
    await page.locator('#cc-daily-qty').fill('500');
    assert.equal(await amount(0).inputValue(),'5500000');
    assert.match(await page.locator('#cc-r-info').innerText(),/인건비\s*0 원\/월/);
    await page.locator('#cc-workers').fill('3');
    assert.equal(await amount(0).inputValue(),'10500000');
    assert.equal(await active(0).isChecked(),false);
    await page.locator('#cc-workers').fill('');
    assert.equal(await amount(0).inputValue(),'8800000');
    assert.equal(await active(0).isChecked(),false);

    // All excluded, empty, and older records must not accidentally import
    // or reactivate expenses when restored.
    for(let i=0;i<3;i++) await active(i).uncheck();
    assert.equal((await result()).totExpCost,0);
    await page.evaluate(()=>saveCostCalc());
    const excluded = (await saved())[0];
    await page.evaluate(id=>loadCostCalc(id),excluded.id);
    assert.equal((await result()).totExpCost,0);
    assert.deepEqual(JSON.parse((await result()).expenses).map(row=>row.active),[false,false,false]);
    await page.evaluate(record=>{costCalcHistory.push({...record,id:901,expenses:'[]'});loadCostCalc(901);},first);
    assert.equal(await expenseRows.count(),0);
    assert.equal((await result()).totExpCost,0);
    await page.evaluate(record=>{
      const legacy={...record,id:902};delete legacy.expenses;
      costCalcHistory.push(legacy);loadCostCalc(902);
    },first);
    assert.equal(await amount(0).inputValue(),'8800000');
    assert.match(await page.locator('#cc-expense-note').innerText(),/현재 경비 설정/);
    assert.equal(await page.evaluate(()=>Object.hasOwn(costCalcHistory.find(row=>row.id===902),'expenses')),false);
    await amount(0).fill('0');
    await page.getByRole('button',{name:'경비 설정 다시 불러오기',exact:true}).click();
    assert.equal(await amount(0).inputValue(),'8800000');
    assert.equal(await active(0).isChecked(),true);
    const countBefore = await page.evaluate(()=>costCalcHistory.length);
    await page.locator('#cc-mat-tbody input[type=number]').first().fill('0');
    await page.evaluate(()=>saveCostCalc());
    assert.equal(await page.evaluate(()=>costCalcHistory.length),countBefore,'Saving invalid material input cannot reuse a stale result');
    assert.equal(await result(),null);
    assert.deepEqual(errors,[]);
    console.log('PASS: default expenses, editable names/monthly amounts, exclusions, live totals, independent saved snapshots across reloads, worker labor, legacy fallback and invalid-input guard.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
