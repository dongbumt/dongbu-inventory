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
    await page.evaluate(()=>{
      window.qaCanvasText=[];
      const original=CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.qaCanvasText.push(String(text));return original.call(this,text,...args);};
    });
    await page.locator('#qt-form-type').selectOption('samsung_welstory');
    assert.equal(await page.locator('#qt-customer').inputValue(),'기존 거래처','Choosing a form preserves the existing customer');
    assert.equal(await page.locator('#qt-editor-price-head-1').textContent(),'수수료 전 단가');
    assert(await page.locator('#qt-editor-price-head-2').isHidden());
    assert(await page.locator('#qt-price-multiplier').isHidden());
    assert(await field(0,7).isHidden());
    await field(0,6).fill('10000');
    await page.evaluate(()=>{window.qaCanvasText=[];setQuotationPreviewType('external');});
    await page.waitForFunction(()=>window.qaCanvasText.includes('10,526'));
    let painted=await page.evaluate(()=>window.qaCanvasText);
    for(const value of ['10,526','11,186','11,001','11,062','용인·오산·평택센터','김해센터','광주센터','왜관센터'])assert(painted.includes(value),value);
    assert(!painted.includes('10,000'),'The commission-free base price is absent from the external document');
    assert(!painted.some(value=>value.includes('수수료 전')),'The base-price heading is absent from the external document');
    assert(!painted.includes('777'),'The legacy second price is not exposed in the Welstory form');
    await page.evaluate(()=>saveQuotation());
    saved=await stored();
    const welstoryId=saved.find(record=>record.id==='legacy').id;
    let welstory=saved.find(record=>record.id===welstoryId);
    assert.equal(welstory.formType,'samsung_welstory');
    assert.deepEqual(welstory.centerFees.map(center=>center.rate),[5,10.6,9.1,9.6]);
    assert.equal(welstory.rows[0].price1,'10000');
    assert.equal(welstory.rows[0].price2,'777','The second price is retained for switching back to the standard form');
    await page.evaluate(records=>APP_DATA_REGISTRY.quotationList.set(JSON.parse(JSON.stringify(records))),saved);
    await page.evaluate(id=>loadQuotation(id),welstoryId);
    assert.equal(await page.locator('#qt-form-type').inputValue(),'samsung_welstory','The form survives a server-style JSON reload');
    await page.evaluate(()=>{window.qaCanvasText=[];setQuotationPreviewType('internal');});
    painted=await page.evaluate(()=>window.qaCanvasText);
    assert(painted.some(value=>value.includes('수수료 전 10,000')),'Internal costing still shows the base price');
    await page.evaluate(id=>duplicateQuotation(id),welstoryId);
    assert.equal(await page.locator('#qt-form-type').inputValue(),'samsung_welstory','Copy retains the selected form');
    await field(0,6).fill('20000');
    await page.evaluate(()=>{window.qaCanvasText=[];setQuotationPreviewType('external');});
    await page.waitForFunction(()=>window.qaCanvasText.includes('21,053'));
    assert.equal((await stored()).find(record=>record.id===welstoryId).rows[0].price1,'10000','Copy edits do not alter the saved quotation');
    await page.locator('#qt-form-type').selectOption('standard');
    assert.equal(await field(0,7).inputValue(),'777');
    assert(await field(0,7).isVisible());
    await page.evaluate(()=>newQuotation());
    await page.locator('#qt-form-type').selectOption('samsung_welstory');
    assert.equal(await page.locator('#qt-customer').inputValue(),'삼성웰스토리','A new Welstory quotation fills the empty customer');
    for(let i=0;i<8;i++){
      if(i)await page.evaluate(()=>addQuotationRow());
      await field(i,2).fill(['목전지(작업)','냉장돈등심','삼겹살(작업)','우민찌(지방15%)','부채살(작업)','후지','한우차돌박이','삼겹양지'][i]);
      await field(i,3).fill('1등급');
      await field(i,4).fill('미국산');
      await field(i,6).fill(String(10000+i*1000));
      await rows.nth(i).locator('td:nth-child(8) input').fill('센터별 동일 스펙');
      await page.locator('.quote-spec-input').nth(i).fill('3mm 슬라이스 · 5KG 실링포장');
    }
    await page.evaluate(()=>{window.qaCanvasText=[];setQuotationPreviewType('external');});
    await page.waitForFunction(()=>window.qaCanvasText.includes('17,895'));
    for(const width of [1400,360]){
      await page.setViewportSize({width,height:1000});
      const bounds=await page.locator('#qt-form-type').boundingBox();
      assert(bounds.x>=0 && bounds.x+bounds.width<=width+1,`Form selection fits ${width}px`);
    }
    await page.setViewportSize({width:1400,height:1100});
    const artifacts=path.join(root,'output/playwright/quotation-welstory');
    fs.mkdirSync(artifacts,{recursive:true});
    await page.screenshot({path:path.join(artifacts,'editor.png'),fullPage:true});
    await page.locator('#qt-preview-canvas').screenshot({path:path.join(artifacts,'external-preview.png')});
    const [download]=await Promise.all([page.waitForEvent('download'),page.evaluate(()=>downloadQuotationImage('external'))]);
    await download.saveAs(path.join(artifacts,'external-quotation.png'));
    await page.evaluate(()=>{window.qaCanvasText=[];setQuotationPreviewType('internal');});
    await page.locator('#qt-preview-canvas').screenshot({path:path.join(artifacts,'internal-preview.png')});
    assert.deepEqual(errors,[]);
    console.log('PASS: standard quotation regression; Welstory gross-up for all four commission groups, base-price privacy, internal costing, save/load/copy, eight-row PNG export and mobile form layout.');
    console.log('Artifacts: '+artifacts);
  }finally{
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
