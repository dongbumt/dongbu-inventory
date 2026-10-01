const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');

const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const quotation=fs.readFileSync(path.join(root,'quotation.js'),'utf8');

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1400,height:1000},timezoneId:'Asia/Seoul'});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('http://erp.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body><main></main></body></html>'}));
    await page.goto('http://erp.test/');
    await page.evaluate(markup=>{
      const template=document.createElement('template');
      template.innerHTML=markup;
      const panel=template.content.querySelector('#p-quotation');
      panel.classList.add('active');
      document.querySelector('main').append(panel);
      localStorage.setItem('dbmt_quotations',JSON.stringify([{
        id:'legacy',customer:'기존 거래처',rows:[{id:'legacy-row',product:'기존 품목',price1:'100',price2:'777'}]
      },{
        id:'legacy-multiply',customer:'기존 배율 거래처',priceMultiplier:'1.5',
        rows:[{id:'legacy-multiply-row',product:'기존 배율 품목',price1:'100',price2:'150'}]
      }]));
      window.localDateString=()=> '2026-09-28';
      window.traderInfoMap={};
      window.htmlEscape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
      window.toast=message=>(window.qaToasts??=[]).push(message);
      window.confirm=()=>true;
      window.safeLocalStorageSet=(key,value)=>localStorage.setItem(key,value);
      window.recordDataChange=()=>{};
      window.resetDataChangeAppDataBaseline=()=>{};
      window.gsSaveAppDataKeys=()=>{};
      window.DBMTCompanyMaster={getSource:()=> 'server',getPrimaryProfile:()=>({legalName:'테스트 업체',representativeName:'담당자',registrationNo:'123',address:'주소',phoneFax:'전화'})};
      window.APP_DATA_REGISTRY={};
      window.APP_DATA_LABELS={};
      window.DATA_CHANGE_MENU_BY_APP_KEY={};
      window.DATA_CHANGE_MENU_ORDER=[];
    },html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
    await page.addScriptTag({content:quotation});
    await page.evaluate(()=>initQuotationPage());
    for(const width of [1400,360]){
      await page.setViewportSize({width,height:1000});
      const fit=await page.evaluate(()=>{
        const group=document.querySelector('.quote-price-formula').getBoundingClientRect();
        const select=document.getElementById('qt-price-operator').getBoundingClientRect();
        const input=document.getElementById('qt-price-multiplier').getBoundingClientRect();
        return {inputWidth:input.width,selectLeft:select.left,inputRight:input.right,groupLeft:group.left,groupRight:group.right};
      });
      assert(fit.inputWidth>=100 && fit.selectLeft>=fit.groupLeft-1 && fit.inputRight<=fit.groupRight+1,`Formula controls fit at ${width}px`);
    }
    await page.setViewportSize({width:1400,height:1000});

    const rows=page.locator('#qt-row-body tr[data-quote-row]');
    const field=(index,column)=>rows.nth(index).locator(`td:nth-child(${column}) input`);
    const stored=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('dbmt_quotations')));

    await page.evaluate(()=>loadQuotation('legacy'));
    assert.equal(await page.locator('#qt-price-operator').inputValue(),'*','Older quotations use multiplication');
    assert.equal(await page.locator('#qt-price-multiplier').inputValue(),'');
    assert.equal(await field(0,7).inputValue(),'777');
    assert.equal(await field(0,7).isEditable(),true,'Older quotations retain manual prices');
    await page.evaluate(()=>loadQuotation('legacy-multiply'));
    assert.equal(await page.locator('#qt-price-operator').inputValue(),'*','Existing multipliers remain multiplication');
    assert.equal(await field(0,7).inputValue(),'150');

    await page.evaluate(()=>newQuotation());
    await page.locator('#qt-customer').fill('첫 거래처');
    await field(0,2).fill('품목 A');
    await field(0,6).fill('101');
    await page.evaluate(()=>addQuotationRow());
    await field(1,2).fill('품목 B');
    await field(1,6).fill('200');
    await page.locator('#qt-price-multiplier').fill('1.5');
    assert.deepEqual([await field(0,7).inputValue(),await field(1,7).inputValue()],['152','300'],'Multiplier applies to every row and rounds to won');
    assert.equal(await field(0,7).isEditable(),false,'Calculated price cannot be overridden per row');
    await field(0,6).fill('125');
    assert.equal(await field(0,7).inputValue(),'188','Changing price 1 recalculates price 2');
    await page.locator('#qt-price-multiplier').fill('2');
    assert.deepEqual([await field(0,7).inputValue(),await field(1,7).inputValue()],['250','400']);
    await page.evaluate(()=>saveQuotation());
    let saved=await stored();
    assert.equal(saved[0].priceMultiplier,'2');
    assert.deepEqual(saved[0].rows.map(row=>row.price2),[250,400]);
    const firstId=saved[0].id;

    await page.evaluate(id=>duplicateQuotation(id),firstId);
    await page.locator('#qt-customer').fill('두 번째 거래처');
    await page.locator('#qt-price-operator').selectOption('/');
    await page.locator('#qt-price-multiplier').fill('1.25');
    assert.deepEqual([await field(0,7).inputValue(),await field(1,7).inputValue()],['100','160']);
    await page.locator('#qt-price-operator').selectOption('*');
    assert.deepEqual([await field(0,7).inputValue(),await field(1,7).inputValue()],['156','250'],'Switching operator recalculates every row');
    await page.locator('#qt-price-operator').selectOption('/');
    await page.evaluate(()=>saveQuotation());
    saved=await stored();
    assert.equal(saved[0].priceMultiplier,'1.25');
    assert.equal(saved[0].priceOperator,'/');
    assert.deepEqual(saved[0].rows.map(row=>row.price2),[100,160]);
    const secondId=saved[0].id;
    assert.equal(saved.find(record=>record.id===firstId).priceMultiplier,'2','Each quotation stores its own multiplier');
    assert.equal(saved.find(record=>record.id===firstId).priceOperator,'*','Other quotations retain their operator');

    await page.evaluate(id=>loadQuotation(id),firstId);
    assert.equal(await page.locator('#qt-price-operator').inputValue(),'*');
    assert.equal(await page.locator('#qt-price-multiplier').inputValue(),'2');
    assert.equal(await field(0,7).inputValue(),'250');
    await page.locator('#qt-price-multiplier').fill('');
    assert.equal(await field(0,7).isEditable(),true);
    await field(0,7).fill('999');
    await page.evaluate(()=>saveQuotation());
    saved=await stored();
    assert.equal(saved.find(record=>record.id===firstId).rows[0].price2,'999','Clearing multiplier restores manual entry');
    assert.equal(saved[0].priceMultiplier,'1.25','Other quotations remain unchanged');

    await page.evaluate(()=>newQuotation());
    await page.locator('#qt-customer').fill('세 번째 거래처');
    await field(0,2).fill('품목 C');
    await field(0,10).fill('1000');
    await page.locator('#qt-price-multiplier').fill('1.2');
    assert.equal(await field(0,7).inputValue(),'1200','Displayed suggested price 1 is used when price 1 is blank');
    await page.locator('#qt-price-operator').selectOption('/');
    assert.equal(await field(0,7).inputValue(),'833','Division uses the suggested price when price 1 is blank');
    await page.locator('#qt-price-operator').selectOption('*');
    await page.evaluate(()=>applyQuotationSuggested(document.querySelector('#qt-row-body tr[data-quote-row]').dataset.quoteRow));
    assert.equal(await field(0,6).inputValue(),'1000');
    assert.equal(await field(0,7).inputValue(),'1200');
    await page.locator('#qt-price-operator').selectOption('/');
    await page.locator('#qt-price-multiplier').fill('0');
    await page.evaluate(()=>saveQuotation());
    assert.equal((await stored()).length,4,'Division by zero is not saved');
    await page.locator('#qt-price-operator').selectOption('*');
    await page.locator('#qt-price-multiplier').fill('-1');
    await page.evaluate(()=>saveQuotation());
    assert.equal((await stored()).length,4,'Invalid multiplier is not saved');
    assert.match((await page.evaluate(()=>window.qaToasts)).at(-1),/계산값은 0보다 큰 숫자/);

    await page.evaluate(id=>loadQuotation(id),secondId);
    assert.equal(await page.locator('#qt-price-operator').inputValue(),'/');
    assert.deepEqual([await field(0,7).inputValue(),await field(1,7).inputValue()],['100','160'],'Saved division formula survives reload');
    await page.evaluate(id=>duplicateQuotation(id),secondId);
    assert.equal(await page.locator('#qt-price-operator').inputValue(),'/','Copy preserves the division formula');

    await page.evaluate(()=>loadQuotation('legacy'));
    assert.equal(await field(0,7).inputValue(),'777','Legacy price is still available after other quotations change');
    assert.deepEqual(errors,[]);
    console.log('PASS: legacy manual prices, multiply/divide switching, all-row recalculation, rounding, save/load/duplicate independence, suggested price, zero divisor and invalid values');
  }finally{
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
