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
    await page.setContent('<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body><main></main></body></html>');
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
    await page.locator('#spec-trader').fill('삼성웰스토리');
    await page.locator('#spec-material').fill('돈등심');
    await page.locator('#spec-origin').fill('국내산');
    await page.locator('#spec-cutting').fill('3mm 슬라이스');
    await page.locator('#spec-packaging').fill('5KG × 2팩');
    await page.locator('#spec-price-kg').fill('12000');
    await page.locator('#spec-price-box').fill('120000');
    await page.locator('#spec-note').fill('납품용');
    await page.locator('#spec-save').click();
    assert.equal(await page.locator('#spec-rows tr[data-id]').count(),1);
    assert.match(await page.locator('#spec-rows').textContent(),/120,000/);
    assert.equal(await page.locator('#spec-trader').inputValue(),'');
    await page.locator('#spec-trader').fill('가상 거래처');
    await page.locator('#spec-material').fill('우둔살');
    await page.locator('#spec-origin').fill('호주산');
    await page.locator('#spec-cutting').fill('큐브');
    await page.locator('#spec-packaging').fill('1KG 진공');
    await page.locator('#spec-note').fill('특수 주문');
    await page.locator('#spec-save').click();
    assert.equal(await page.locator('#spec-rows tr[data-id]').count(),2);
    assert.equal(await page.evaluate(()=>qaRows.find(row=>row.material==='우둔살').price_kg),null);
    const screenshot=path.join(os.tmpdir(),'dbmt-product-specs-qa.png');
    await page.screenshot({path:screenshot,fullPage:true});
    const filters={trader:'삼성',material:'등심',origin:'국내',cutting:'슬라이스',packaging:'2팩','price-kg':'12000','price-box':'120000',note:'납품'};
    for(const [key,value] of Object.entries(filters)){
      await page.locator('#spec-filter-'+key).fill(value);
      assert.equal(await page.locator('#spec-rows tr[data-id]').count(),1,key+' filter');
      assert.match(await page.locator('#spec-rows').textContent(),/돈등심/);
      await page.locator('#spec-filter-'+key).fill('');
    }
    await page.locator('#spec-filter-origin').fill('국내');
    await page.locator('#spec-filter-packaging').fill('진공');
    assert.equal(await page.locator('#spec-rows tr[data-id]').count(),0,'Combined filters');
    await page.getByRole('button',{name:'검색 초기화'}).click();
    assert.equal(await page.locator('#spec-rows tr[data-id]').count(),2);
    await page.locator('[data-id="qa-1"] [data-action="edit"]').click();
    await page.locator('#spec-note').fill('수정한 비고');
    await page.locator('#spec-price-kg').fill('12500.50');
    await page.locator('#spec-save').click();
    assert.match(await page.locator('#spec-rows tr[data-id="qa-1"]').textContent(),/12,500.5/);
    await page.evaluate(()=>DBMTProductSpecs.load());
    assert.equal(await page.locator('#spec-rows tr[data-id]').count(),2,'Server reload');
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
    await page.locator('[data-id="qa-2"] [data-action="delete"]').click();
    assert.equal(await page.locator('#spec-rows tr[data-id]').count(),1);
    await page.evaluate(()=>{qaRights={view:true,create:false,update:false,delete:false};DBMTProductSpecs.applyPermissions();});
    assert.equal(await page.locator('#spec-editor').isVisible(),false);
    assert.equal(await page.locator('#spec-rows button').count(),0);
    await page.evaluate(()=>{qaToken='';DBMTProductSpecs.applyPermissions();});
    assert.equal(await page.locator('#spec-rows tr[data-id]').count(),0,'Logout clears private specs');
    assert.deepEqual(errors,[]);
    assert.match(fs.readFileSync(path.join(root,'m02-auth.js'),'utf8'),/'nav-product-specs':'product_specs'/);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Mobile table scroll stays inside its card');
    console.log('PASS: product spec create, edit, delete, all eight filters, combined filters, optional prices, reload, conflicts, failure, permissions, logout');
    console.log('Screenshot: '+screenshot);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
