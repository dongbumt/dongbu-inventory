const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
    await page.setContent('<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body><main class="main"></main></body></html>');
    await page.evaluate(markup=>{
      const template=document.createElement('template');template.innerHTML=markup;
      const panel=template.content.querySelector('#p-product-specs');panel.classList.add('active');
      document.querySelector('main').append(panel);
    },html);
    for(const file of ['styles/main.css','styles/product-specs.css'])await page.addStyleTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    await page.addScriptTag({content:`
      var qaToken='qa-session',qaRights={view:true,create:true,update:true,delete:true},qaRows=[],qaCalls=[],qaFailure=false,qaSeq=0;
      var DBMTAuth={isPersonal:()=>!!qaToken,can:(_,action)=>qaRights[action],getSessionToken:()=>qaToken};
      window.confirm=()=>true;
      async function sbRpc(name,params){
        qaCalls.push({name,params});
        if(qaFailure)throw new Error('QA 서버 오류');
        if(name==='dbmt_erp_get_product_specs')return {ok:true,specs:structuredClone(qaRows)};
        if(name==='dbmt_erp_save_product_spec'){
          const old=qaRows.find(row=>row.id===params.p_id);
          if(old&&old.revision!==params.p_revision)throw new Error('다른 사용자가 변경했습니다.');
          const spec={...params.p_record,id:params.p_id||'qa-'+(++qaSeq),revision:(old?.revision||0)+1};
          qaRows=qaRows.filter(row=>row.id!==spec.id).concat(spec);return {ok:true,spec:structuredClone(spec)};
        }
        qaRows=qaRows.filter(row=>row.id!==params.p_id);return {ok:true,id:params.p_id};
      }
    `});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'product-specs.js'),'utf8')});
    await page.evaluate(()=>DBMTProductSpecs.init());
    assert.deepEqual(await page.locator('#spec-distribution-choice option').allTextContents(),['선택','삼성웰스토리','동원홈푸드','CJ프레시웨이','동부축산유통','직납','직접입력']);
    for(const value of ['삼성웰스토리','동원홈푸드','CJ프레시웨이','동부축산유통','직납']){
      await page.locator('#spec-distribution-choice').selectOption(value);
      assert.equal(await page.locator('#spec-distribution').inputValue(),value);
      assert.equal(await page.locator('#spec-distribution').isVisible(),false);
    }
    await page.locator('#spec-distribution-choice').selectOption('__custom__');
    assert.equal(await page.locator('#spec-distribution').isVisible(),true);
    assert.equal(await page.locator('#spec-distribution').inputValue(),'','Direct entry starts blank');
    await page.locator('#spec-distribution').fill('임시 유통처');
    await page.locator('#spec-distribution-choice').selectOption('직납');
    await page.locator('#spec-distribution-choice').selectOption('__custom__');
    assert.equal(await page.locator('#spec-distribution').inputValue(),'','Switching to direct entry clears the previous selection');
    await page.locator('#spec-distribution-choice').selectOption('삼성웰스토리');
    await page.locator('#spec-trader').fill('삼성웰스토리');
    await page.locator('#spec-material').fill('돈등심');
    await page.locator('#spec-origin').fill('국내산');
    await page.locator('#spec-cutting').fill('3mm 슬라이스');
    await page.locator('#spec-inner-packaging').fill('1KG 진공포장');
    await page.locator('#spec-outer-packaging').fill('5KG × 2팩 / 박스');
    await page.locator('#spec-price-kg').fill('12000');
    await page.locator('#spec-price-box').fill('120000');
    await page.locator('#spec-note').fill('납품용');
    await page.locator('#spec-save').click();
    assert.equal(await page.locator('#spec-rows tr[data-id]').count(),1);
    assert.match(await page.locator('#spec-rows').textContent(),/1KG 진공포장/);
    assert.match(await page.locator('#spec-rows').textContent(),/5KG × 2팩 \/ 박스/);
    assert.deepEqual(await page.evaluate(()=>[qaRows[0].inner_packaging_spec,qaRows[0].outer_packaging_spec]),['1KG 진공포장','5KG × 2팩 / 박스']);
    assert.equal(await page.evaluate(()=>qaRows[0].distribution),'삼성웰스토리');
    assert.match(await page.locator('#spec-rows').textContent(),/120,000/);
    assert.equal(await page.locator('#spec-trader').inputValue(),'');
    assert.equal(await page.locator('#spec-distribution-choice').inputValue(),'');
    assert.equal(await page.locator('#spec-distribution').isVisible(),false,'Reset hides direct entry');
    await page.locator('#spec-trader').fill('가상 거래처');
    await page.locator('#spec-distribution-choice').selectOption('__custom__');
    await page.locator('#spec-distribution').fill('지역 급식유통');
    await page.locator('#spec-material').fill('우둔살');
    await page.locator('#spec-origin').fill('호주산');
    await page.locator('#spec-cutting').fill('큐브');
    await page.locator('#spec-inner-packaging').fill('1KG 실링');
    await page.locator('#spec-outer-packaging').fill('10KG 박스');
    await page.locator('#spec-note').fill('특수 주문');
    await page.locator('#spec-save').click();
    assert.equal(await page.locator('#spec-rows tr[data-id]').count(),2);
    assert.equal(await page.evaluate(()=>qaRows.find(row=>row.material==='우둔살').price_kg),null);
    assert.equal(await page.evaluate(()=>qaRows.find(row=>row.material==='우둔살').distribution),'지역 급식유통');
    const sortFields=['trader','distribution','material','origin','cutting_spec','inner_packaging_spec','outer_packaging_spec','price_kg','price_box','note'];
    const rowIds=()=>page.locator('#spec-rows tr[data-id]').evaluateAll(rows=>rows.map(row=>row.dataset.id));
    await page.evaluate(keys=>{
      window.qaOriginalRows=structuredClone(qaRows);
      qaRows=[10,2,1,null].map(number=>({id:'sort-'+number,revision:1,...Object.fromEntries(keys.map(key=>[key,number===null?null:key.startsWith('price_')?String(number===1?0:number===10?10000:number):'테스트 '+number]))}));
      qaRows[1].packaging_spec=qaRows[1].inner_packaging_spec;
      delete qaRows[1].inner_packaging_spec;
      return DBMTProductSpecs.load();
    },sortFields);
    const callsBeforeSort=await page.evaluate(()=>qaCalls.length);
    for(const key of sortFields){
      const button=page.locator(`.spec-sort[data-sort="${key}"]`),header=page.locator(`th:has(.spec-sort[data-sort="${key}"])`);
      await button.click();
      if(await header.getAttribute('aria-sort')!=='ascending')await button.click();
      assert.equal(await header.getAttribute('aria-sort'),'ascending',key+' ascending indicator');
      assert.deepEqual(await rowIds(),['sort-1','sort-2','sort-10','sort-null'],key+' natural/numeric ascending with blanks last');
      await button.press('Enter');
      assert.equal(await header.getAttribute('aria-sort'),'descending',key+' descending indicator');
      assert.deepEqual(await rowIds(),['sort-10','sort-2','sort-1','sort-null'],key+' descending with blanks last');
      assert.equal(await page.locator('th[aria-sort="descending"]').count(),1,'Only the selected column shows a direction');
    }
    assert.equal(await page.evaluate(()=>qaCalls.length),callsBeforeSort,'Sorting does not write or fetch records');
    await page.locator('#spec-search').fill('테스트 2');
    assert.deepEqual(await rowIds(),['sort-2'],'Search filters the sorted list');
    await page.getByRole('button',{name:'검색 초기화'}).click();
    assert.deepEqual(await rowIds(),['sort-10','sort-2','sort-1','sort-null'],'Clearing search preserves sorting');
    await page.evaluate(()=>DBMTProductSpecs.load());
    assert.deepEqual(await rowIds(),['sort-10','sort-2','sort-1','sort-null'],'Reload preserves sorting');
    await page.evaluate(()=>{qaRows=qaOriginalRows;return DBMTProductSpecs.load();});
    await page.locator('.spec-sort[data-sort="price_kg"]').click();
    await page.locator('.spec-sort[data-sort="price_kg"]').click();
    const screenshot=path.join(os.tmpdir(),'dbmt-product-specs-qa.png');
    for(const width of [1440,1366,1280]){
      await page.setViewportSize({width,height:900});
      const layout=await page.evaluate(()=>{
        const wrap=document.querySelector('.spec-table-wrap'),bounds=wrap.getBoundingClientRect();
        return {fits:wrap.scrollWidth<=wrap.clientWidth,buttonsFit:[...document.querySelectorAll('.spec-table button')].every(button=>{
          const rect=button.getBoundingClientRect();return rect.left>=bounds.left&&rect.right<=bounds.right;
        })};
      });
      assert.equal(layout.fits,true,`Table fits at ${width}px`);
      assert.equal(layout.buttonsFit,true,`Management buttons remain fully visible at ${width}px`);
    }
    await page.setViewportSize({width:1366,height:900});
    await page.screenshot({path:screenshot,fullPage:true});
    assert.equal(await page.locator('.spec-search input').count(),1);
    for(const [value,material] of [['가상','우둔살'],['급식','우둔살'],['등심','돈등심'],['호주','우둔살'],['  삼성 국내 돈등심  ','돈등심']]){
      await page.locator('#spec-search').fill(value);
      assert.equal(await page.locator('#spec-rows tr[data-id]').count(),1,value+' search');
      assert.match(await page.locator('#spec-rows').textContent(),new RegExp(material));
    }
    for(const value of ['국내 우둔살','슬라이스','진공포장','12000','납품용']){
      await page.locator('#spec-search').fill(value);
      assert.equal(await page.locator('#spec-rows tr[data-id]').count(),0,value+' has no matching trader/distribution/material/origin');
    }
    await page.getByRole('button',{name:'검색 초기화'}).click();
    assert.equal(await page.locator('#spec-rows tr[data-id]').count(),2);
    await page.locator('[data-id="qa-1"] [data-action="edit"]').click();
    assert.equal(await page.locator('#spec-distribution-choice').inputValue(),'삼성웰스토리');
    await page.locator('#spec-distribution-choice').selectOption('CJ프레시웨이');
    assert.equal(await page.locator('#spec-inner-packaging').inputValue(),'1KG 진공포장');
    assert.equal(await page.locator('#spec-outer-packaging').inputValue(),'5KG × 2팩 / 박스');
    await page.locator('#spec-outer-packaging').fill('6KG 박스');
    await page.locator('#spec-note').fill('수정한 비고');
    await page.locator('#spec-price-kg').fill('12500.50');
    await page.locator('#spec-save').click();
    assert.match(await page.locator('#spec-rows tr[data-id="qa-1"]').textContent(),/12,500.5/);
    assert.equal(await page.evaluate(()=>qaRows.find(row=>row.id==='qa-1').outer_packaging_spec),'6KG 박스');
    assert.equal(await page.evaluate(()=>qaRows.find(row=>row.id==='qa-1').distribution),'CJ프레시웨이');
    assert.equal(await page.locator('th:has([data-sort="price_kg"])').getAttribute('aria-sort'),'descending','Saving preserves the selected sort');
    assert.deepEqual(await rowIds(),['qa-1','qa-2'],'Saved numeric values remain sorted with blanks last');
    await page.evaluate(()=>DBMTProductSpecs.load());
    assert.equal(await page.locator('#spec-rows tr[data-id]').count(),2,'Server reload');
    await page.locator('#spec-search').fill('cj프레시웨이');
    assert.equal(await page.locator('#spec-rows tr[data-id]').count(),1,'Case-insensitive distribution search');
    await page.getByRole('button',{name:'검색 초기화'}).click();
    await page.locator('[data-id="qa-2"] [data-action="edit"]').click();
    assert.equal(await page.locator('#spec-distribution-choice').inputValue(),'__custom__');
    assert.equal(await page.locator('#spec-distribution').isVisible(),true);
    assert.equal(await page.locator('#spec-distribution').inputValue(),'지역 급식유통','Custom value survives reload and edit');
    await page.locator('[data-id="qa-1"] [data-action="edit"]').click();
    await page.evaluate(()=>{qaRows.find(row=>row.id==='qa-1').revision++;});
    await page.locator('#spec-save').click();
    assert.match(await page.locator('#spec-message').textContent(),/다른 사용자/);
    assert.equal(await page.locator('#spec-note').inputValue(),'수정한 비고');
    await page.evaluate(()=>{qaFailure=true;DBMTProductSpecs.reset();});
    await page.locator('#spec-trader').fill('실패 보존');
    await page.locator('#spec-material').fill('실패 보존');
    await page.locator('#spec-save').click();
    assert.match(await page.locator('#spec-message').textContent(),/QA 서버 오류/);
    assert.equal(await page.locator('#spec-trader').inputValue(),'실패 보존');
    await page.evaluate(()=>{qaFailure=false;DBMTProductSpecs.reset();});
    await page.locator('[data-id="qa-1"] [data-action="edit"]').click();
    const beforeCopy=await page.evaluate(()=>({rows:structuredClone(qaRows),calls:qaCalls.length}));
    await page.locator('[data-id="qa-2"] [data-action="copy"]').click();
    assert.equal(await page.locator('#spec-editor-title').textContent(),'제품스펙 등록','Copy exits edit mode');
    assert.equal(await page.locator('#spec-save').textContent(),'+ 스펙 등록');
    assert.equal(await page.locator('#spec-trader').inputValue(),'가상 거래처');
    assert.equal(await page.locator('#spec-distribution-choice').inputValue(),'__custom__');
    assert.equal(await page.locator('#spec-distribution').inputValue(),'지역 급식유통');
    assert.equal(await page.locator('#spec-inner-packaging').inputValue(),'1KG 실링');
    assert.equal(await page.locator('#spec-outer-packaging').inputValue(),'10KG 박스');
    assert.equal(await page.locator('#spec-price-kg').inputValue(),'');
    assert.equal(await page.locator('#spec-price-box').inputValue(),'');
    assert.deepEqual(await page.evaluate(()=>qaRows),beforeCopy.rows,'Copy cannot modify the source row');
    assert.equal(await page.evaluate(()=>qaCalls.length),beforeCopy.calls,'Copy only fills the form');
    await page.locator('#spec-trader').fill('복사 신규 거래처');
    await page.locator('#spec-price-kg').fill('0');
    await page.evaluate(()=>{qaFailure=true;});await page.locator('#spec-save').click();
    assert.match(await page.locator('#spec-message').textContent(),/QA 서버 오류/);
    assert.equal(await page.locator('#spec-trader').inputValue(),'복사 신규 거래처','Failed create preserves the copied draft');
    await page.evaluate(()=>{qaFailure=false;});await page.locator('#spec-save').click();
    const copiedSave=await page.evaluate(()=>qaCalls.filter(call=>call.name==='dbmt_erp_save_product_spec').at(-1));
    assert.equal(copiedSave.params.p_id,null,'Create a new record instead of overwriting the copied row');
    assert.equal(copiedSave.params.p_revision,null,'Copied source revision must never be reused');
    assert.equal(await page.evaluate(()=>qaRows.find(row=>row.id==='qa-3').price_kg),0);
    assert.deepEqual(await page.evaluate(()=>qaRows.find(row=>row.id==='qa-2')),beforeCopy.rows.find(row=>row.id==='qa-2'));
    await page.locator('[data-id="qa-3"] [data-action="delete"]').click();
    await page.locator('[data-id="qa-2"] [data-action="delete"]').click();
    assert.equal(await page.locator('#spec-rows tr[data-id]').count(),1);
    await page.evaluate(()=>{qaRows.push({id:'qa-legacy',trader:'기존 거래처',material:'기존 원재료',revision:1,packaging_spec:'기존 포장규격',price_kg:0,price_box:null});return DBMTProductSpecs.load();});
    await page.locator('[data-id="qa-legacy"] [data-action="edit"]').click();
    assert.equal(await page.locator('#spec-distribution-choice').inputValue(),'','Existing records start with no distribution');
    assert.equal(await page.locator('#spec-distribution').inputValue(),'');
    assert.equal(await page.locator('#spec-distribution').isVisible(),false);
    await page.locator('[data-id="qa-legacy"] [data-action="copy"]').click();
    assert.equal(await page.locator('#spec-editor-title').textContent(),'제품스펙 등록');
    assert.equal(await page.locator('#spec-inner-packaging').inputValue(),'기존 포장규격');
    assert.equal(await page.locator('#spec-price-kg').inputValue(),'0','Preserve explicitly recorded zero prices');
    assert.equal(await page.locator('#spec-price-box').inputValue(),'','Preserve unrecorded prices');
    await page.evaluate(()=>DBMTProductSpecs.reset());
    await page.evaluate(()=>{qaRights={view:true,create:true,update:false,delete:false};DBMTProductSpecs.applyPermissions();});
    assert.equal(await page.locator('[data-action="copy"]').count(),2,'Create-only users can copy');
    assert.equal(await page.locator('[data-action="edit"]').count(),0);
    await page.locator('[data-id="qa-legacy"] [data-action="copy"]').click();
    assert.equal(await page.locator('#spec-editor').isVisible(),true);
    await page.evaluate(()=>{qaRights={view:true,create:false,update:false,delete:false};DBMTProductSpecs.applyPermissions();});
    assert.equal(await page.locator('#spec-editor').isVisible(),false);
    assert.equal(await page.locator('#spec-rows button').count(),0);
    await page.locator('.spec-sort[data-sort="trader"]').click();
    assert.equal(await page.locator('th:has([data-sort="trader"])').getAttribute('aria-sort'),'ascending','Read-only users can sort');
    await page.evaluate(()=>{qaToken='';DBMTProductSpecs.applyPermissions();});
    assert.equal(await page.locator('#spec-rows tr[data-id]').count(),0,'Logout clears private specs');
    assert.deepEqual(errors,[]);
    assert.match(fs.readFileSync(path.join(root,'m02-auth.js'),'utf8'),/'nav-product-specs':'product_specs'/);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Mobile table scroll stays inside its card');
    console.log('PASS: product specs copy-to-create without writes/source IDs/revisions, custom distribution/legacy fields/zero and blank prices, create-only access and failed draft retention; sorting/search, keyboard controls, desktop management buttons, create/edit/delete and permissions');
    console.log('Screenshot: '+screenshot);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
