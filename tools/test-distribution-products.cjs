// Real catalog form/module; all RPCs are in-memory and business data stays fictional.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
for(const file of ['distribution-products.js','manual-label.js','m02-auth.js'])new vm.Script(fs.readFileSync(path.join(root,file),'utf8'));
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-distribution-'));
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<!doctype html><meta charset="utf-8"><main></main>');
    await page.evaluate(markup=>{const template=document.createElement('template');template.innerHTML=markup;document.querySelector('main').append(template.content.querySelector('#p-distribution-products'));document.getElementById('p-distribution-products').classList.add('active')},html);
    for(const file of ['styles/main.css','styles/distribution-products.css'])await page.addStyleTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    await page.addScriptTag({content:`
      var session='qa-session',rights={view:true,create:true,update:true,delete:true},labelView=true;
      var labelProducts=[{id:'mt-one',name:'같은 제품명',itemno:'MT-REPORT'}],rows=[],calls=[],messages=[],fail=false,holdRead=false,holdWrite=false,releaseRead=null,releaseWrite=null;
      window.DBMTAuth={isPersonal:()=>!!session,getSessionToken:()=>session,can:(menu,action)=>menu==='distribution_products'?!!rights[action]:menu==='label'?labelView:true};
      const htmlEscape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
      const toast=message=>messages.push(message);window.confirm=()=>true;
      async function sbRpc(name,args){
        calls.push({name,args:structuredClone(args)});
        if(name==='dbmt_erp_get_distribution_products'){
          const response={ok:true,products:structuredClone(rows)};
          return holdRead?new Promise(resolve=>{releaseRead=()=>resolve(response)}):response;
        }
        if(name==='dbmt_erp_save_distribution_product'){
          const run=()=>{if(fail)throw Error('QA save rejected');const product={...args.p_record,id:args.p_id||'qa-dist-'+calls.length,revision:(args.p_revision||0)+1,kind:'제품',isActive:true};rows=rows.filter(row=>row.id!==product.id).concat(product);return {ok:true,product:structuredClone(product)}};
          if(holdWrite)return new Promise((resolve,reject)=>{releaseWrite=()=>{try{resolve(run())}catch(error){reject(error)}}});
          await new Promise(resolve=>setTimeout(resolve,25));return run();
        }
        if(name==='dbmt_erp_delete_distribution_product'){rows=rows.filter(row=>row.id!==args.p_id);return {ok:true,id:args.p_id}};
        throw Error('Unexpected RPC: '+name);
      }
    `});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'distribution-products.js'),'utf8')});
    await page.evaluate(()=>DBMTDistributionProducts.init());assert.match(await page.locator('#dist-count').innerText(),/0건/);
    await page.locator('#dist-name').fill('같은 제품명');await page.locator('#dist-itemno').fill('DIST-REPORT');
    await page.locator('#dist-origin').fill('미국산/국내산');await page.locator('#dist-brand').fill('QA 브랜드');
    await page.locator('#dist-meattype').selectOption('소고기');await page.locator('#dist-ingredientDetails').fill('전각(미국산) 85%, 지방(국내산) 15%');
    await page.locator('#dist-save').click();await page.evaluate(()=>DBMTDistributionProducts.save());
    await page.waitForFunction(()=>rows.length===1&&!document.getElementById('dist-save').disabled);
    assert.equal(await page.evaluate(()=>calls.filter(call=>call.name==='dbmt_erp_save_distribution_product').length),1,'Duplicate saves are blocked');
    const saved=await page.evaluate(()=>rows[0]);assert(saved.id!=='mt-one');assert.equal(saved.itemno,'DIST-REPORT');
    assert.equal(await page.locator('#dist-name').inputValue(),'');assert.match(await page.locator('#dist-body').innerText(),/DIST-REPORT/);
    await page.locator('[data-dist-edit]').click();await page.locator('#dist-itemno').fill('DIST-UPDATED');
    await page.evaluate(()=>fail=true);await page.locator('#dist-save').click();await page.waitForFunction(()=>!document.getElementById('dist-save').disabled);
    assert.match(await page.locator('#dist-status').innerText(),/QA save rejected/);assert.equal(await page.locator('#dist-itemno').inputValue(),'DIST-UPDATED');
    await page.evaluate(()=>fail=false);await page.locator('#dist-save').click();await page.waitForFunction(()=>rows[0].revision===2&&!document.getElementById('dist-save').disabled);
    assert.equal(await page.evaluate(()=>rows[0].itemno),'DIST-UPDATED');
    await page.locator('#dist-search').fill('QA 브랜드');assert.match(await page.locator('#dist-count').innerText(),/^1건/);
    await page.locator('#dist-search').fill('없는 검색');assert.match(await page.locator('#dist-count').innerText(),/^0건/);await page.locator('#dist-search').fill('');
    await page.locator('#dist-name').fill('작성 중 내용');await page.evaluate(()=>DBMTDistributionProducts.refresh());assert.equal(await page.locator('#dist-name').inputValue(),'작성 중 내용','List refresh retains the draft');
    await page.screenshot({path:path.join(artifacts,'desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:path.join(artifacts,'mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});
    await page.evaluate(()=>{rights={view:true};DBMTDistributionProducts.applyPermissions()});
    assert(await page.locator('#dist-name').isDisabled());assert(await page.locator('#dist-save').isHidden());assert.equal(await page.locator('[data-dist-edit]').count(),0);
    const before=await page.evaluate(()=>calls.length);await page.evaluate(async()=>{DBMTDistributionProducts.edit(rows[0].id);await DBMTDistributionProducts.save();await DBMTDistributionProducts.remove(rows[0].id)});
    assert.equal(await page.evaluate(()=>calls.length),before,'Read-only users cannot issue writes through direct calls');
    await page.evaluate(async()=>{rights={};DBMTDistributionProducts.applyPermissions();await DBMTDistributionProducts.refresh()});
    assert.equal(await page.locator('#dist-body tr button').count(),0);assert.equal(await page.evaluate(()=>DBMTDistributionProducts.catalogProducts().length),1,'Label operators can choose without catalog menu rights');
    await page.evaluate(()=>{rights={view:true,create:true,update:true,delete:true};DBMTDistributionProducts.applyPermissions();holdRead=true;window.oldRead=DBMTDistributionProducts.refresh()});
    await page.waitForFunction(()=>!!releaseRead);await page.locator('#dist-name').fill('새 품목');await page.locator('#dist-save').click();
    await page.waitForFunction(()=>rows.length===2&&!document.getElementById('dist-save').disabled);
    await page.evaluate(async()=>{holdRead=false;releaseRead();await oldRead});
    assert.equal(await page.evaluate(()=>DBMTDistributionProducts.catalogProducts().length),2,'Late reads cannot overwrite a successful save');
    await page.locator('[data-dist-delete]').first().click();await page.waitForFunction(()=>rows.length===1&&!document.getElementById('dist-save').disabled);
    assert.match(await page.locator('#dist-status').innerText(),/삭제/);
    await page.locator('#dist-name').fill('이전 사용자 저장');await page.evaluate(()=>holdWrite=true);await page.locator('#dist-save').click();await page.waitForFunction(()=>!!releaseWrite);
    await page.evaluate(()=>{session='new-session';rights={};labelView=false;DBMTDistributionProducts.applyPermissions();releaseWrite()});
    await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>DBMTDistributionProducts.catalogProducts().length),0);
    assert.equal(await page.locator('#dist-name').inputValue(),'');assert.equal(await page.locator('[data-dist-edit]').count(),0,'Previous-session save cannot expose its record to the next user');
    assert.deepEqual(await page.evaluate(()=>labelProducts),[{id:'mt-one',name:'같은 제품명',itemno:'MT-REPORT'}]);assert.deepEqual(errors,[]);
    console.log('PASS: real isolated catalog CRUD/search, exact report mapping, create/update/delete guards, failure drafts, duplicate-save/read races, permission/session isolation, MT preservation and desktop/mobile layout');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
