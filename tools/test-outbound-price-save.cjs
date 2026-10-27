/* Actual form/module in an isolated browser. Fictional data, mocked RPC, no business writes. */
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'), html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const source=name=>{const m=html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));assert(m,name);return m[0];};
for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(m[1]);
new vm.Script(fs.readFileSync(path.join(root,'outbound-price-save.js'),'utf8'));
const authSource=fs.readFileSync(path.join(root,'m02-auth.js'),'utf8');
assert.match(authSource,/saveOutboundPrices:\['prices','write'\]/);

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1390,height:1000}}), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.fulfill({body:'<html><body></body></html>',contentType:'text/html'}));
    await page.goto('http://fixture.invalid/');
    await page.evaluate(markup=>{
      const t=document.createElement('template');t.innerHTML=markup;
      for(const id of ['p-transactions','p-prices']){const p=t.content.querySelector('#'+id);p.classList.add('active');document.body.append(p);}
    },html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')+'body{padding:16px}'});
    await page.addScriptTag({content:`
      var prices=[],labelProducts=[{id:'qa',name:'가상 목전지(작업)',origin:'미국산'}],notices=[],calls=[],answers=[],confirmations=[],audit=[];
      var token='qa-token', permitted=true,connected=true, reply=null, pendingResolve=null;
      const SUPABASE_ENABLED_KEY='qa-supabase'; localStorage.setItem(SUPABASE_ENABLED_KEY,'1');
      var DBMTAuth={isPersonal:()=>true,can:()=>permitted,getSessionToken:()=>token};
      function requireSupabasePassword(){return token}
      function safeLocalStorageSet(key,value){localStorage.setItem(key,value)}
      function recordPriceChange(rows){audit.push(rows)}
      function toast(message){notices.push(message)}
      function ensurePriceProductSourceReady(){}
      function showPriceProductSuggestions(){}
      function hidePriceProductSuggestionsSoon(){}
      function confirm(message){confirmations.push(message);return answers.shift()??true}
      function sbRpc(name,args){calls.push({name,args:structuredClone(args)});return reply(args)}
      function resetSingle(){
        document.getElementById('t-type').value='출고';
        document.getElementById('t-product-select').innerHTML='<option selected>가상 목전지(작업)</option>';
        document.getElementById('t-stock-key').value='qa-stock';
        document.getElementById('t-origin-managed').style.display='none';
        document.getElementById('t-origin-display').style.display='block';
        document.getElementById('t-origin-display').value='미국산';
        document.getElementById('t-trader').value='가상 납품처';
        document.getElementById('t-price').value='8500';
        document.getElementById('t-weight').value='25.5';
        document.getElementById('t-box-count').value='3';
        document.getElementById('t-note').value='작성 중인 출고';
      }
      function serverRow(price=8500){return{id:'qa-price',product:'가상 목전지(작업)',origin:'미국산',trader:'가상 납품처',price}}
      function ok(rows=[serverRow()],counts={inserted:1,updated:0,skipped:0}){return{ok:true,rows,changedRows:counts.skipped?[]:rows,...counts}}
      ${['htmlEscape','priceKey','normalizeOriginName','originKey','samePriceText','sameOriginText','getPriceProductNames','getCanonicalPriceProductName',
        'getTProduct','getTOrigin','editPrice','renderPrices','refreshPriceProductInput',
        'addBulkOutboundRow','addBulkOutboundRows','clearBulkOutbound'].map(source).join('\n')}
      var priceSortKey='product',priceSortDir='asc';
      resetSingle();
      document.getElementById('bulk-outbound-body').style.display='block';
      addBulkOutboundRows(3);
      function bulk(index,price=8500){
        const tr=document.querySelectorAll('#bulk-outbound-tbody tr')[index];
        for(const [field,value] of Object.entries({key:'qa-stock',product:'가상 목전지(작업)',origin:'미국산',trader:'가상 납품처','price-input':String(price)}))tr.querySelector('.bulk-out-'+field).value=value;
      }
    `});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'outbound-price-save.js'),'utf8')});
    assert.equal(await page.locator('#t-save-price-wrap').evaluate(e=>e.hidden),false);
    await page.evaluate(()=>{document.getElementById('t-type').value='입고';updateOutboundPriceButtons()});
    assert.equal(await page.locator('#t-save-price-wrap').evaluate(e=>e.hidden),true);
    await page.evaluate(()=>{resetSingle();updateOutboundPriceButtons();reply=()=>new Promise(resolve=>pendingResolve=resolve);window.savingTask=saveOutboundPrices('single')});
    assert.equal(await page.locator('#t-save-price-btn').isDisabled(),true);
    assert.equal(await page.locator('#bulk-out-save-price-btn').isDisabled(),true);
    assert.equal(await page.evaluate(()=>prices.length),0,'No optimistic local save');
    await page.evaluate(()=>saveOutboundPrices('bulk'));
    assert.equal(await page.evaluate(()=>calls.length),1,'Double-click/shared save guard');
    await page.evaluate(async()=>{pendingResolve(ok());await savingTask});
    assert.equal(await page.evaluate(()=>prices[0].id),'qa-price');
    assert.equal(await page.locator('#t-weight').inputValue(),'25.5');
    assert.equal(await page.locator('#t-box-count').inputValue(),'3');
    assert.equal(await page.locator('#t-note').inputValue(),'작성 중인 출고');
    assert.match(await page.locator('#t-price-save-status').innerText(),/신규 1건/);
    assert.equal(await page.locator('#t-save-price-btn').isDisabled(),false);
    await page.evaluate(()=>editPrice(0));
    assert.equal(await page.locator('#pr-price').inputValue(),'8500');
    assert.equal(await page.locator('#pr-trader').inputValue(),'가상 납품처');
    assert.equal(await page.locator('#pr-edit-idx').inputValue(),'0','Existing edit screen opens saved row');
    await page.evaluate(async()=>{reply=()=>Promise.resolve(ok([serverRow()],{inserted:0,updated:0,skipped:1}));await saveOutboundPrices('single')});
    assert.equal(await page.evaluate(()=>prices.length),1);
    assert.equal(await page.evaluate(()=>audit.length),1,'No duplicate change event for same price');

    const conflict={ok:false,confirmationRequired:true,conflicts:[{id:'qa-price',product:'가상 목전지(작업)',origin:'미국산',trader:'가상 납품처',oldPrice:8500,price:9000,updatedAt:'qa-revision'}]};
    await page.evaluate(async conflict=>{
      document.getElementById('t-price').value='9000';answers=[false];reply=()=>Promise.resolve(conflict);await saveOutboundPrices('single');
    },conflict);
    assert.equal(await page.evaluate(()=>prices[0].price),8500);
    assert.match(await page.locator('#t-price-save-status').innerText(),/취소/);
    await page.evaluate(async conflict=>{
      let n=0;answers=[true];reply=()=>Promise.resolve(n++?ok([serverRow(9000)],{inserted:0,updated:1,skipped:0}):conflict);
      await saveOutboundPrices('single');
    },conflict);
    assert.equal(await page.evaluate(()=>prices[0].price),9000);
    assert.deepEqual(await page.evaluate(()=>calls.at(-1).args.p_expected),conflict.conflicts);
    await page.evaluate(async conflict=>{answers=[true];reply=()=>Promise.resolve(conflict);await saveOutboundPrices('single')},conflict);
    assert.match(await page.locator('#t-price-save-status').innerText(),/다른 PC/);
    assert.equal(await page.evaluate(()=>prices[0].price),9000);
    await page.evaluate(async()=>{reply=()=>Promise.reject(new Error('가상 서버 오류'));await saveOutboundPrices('single')});
    assert.match(await page.locator('#t-price-save-status').innerText(),/가상 서버 오류/);
    assert.equal(await page.locator('#t-price').inputValue(),'9000');
    assert.equal(await page.evaluate(()=>prices[0].price),9000);

    for(const field of ['t-trader','t-price','t-stock-key']){
      const before=await page.evaluate(()=>calls.length);
      await page.evaluate(async id=>{resetSingle();document.getElementById(id).value='';await saveOutboundPrices('single')},field);
      assert.equal(await page.evaluate(()=>calls.length),before,field+' validation');
    }
    await page.evaluate(async()=>{resetSingle();permitted=false;await saveOutboundPrices('single');permitted=true});
    assert.match(await page.locator('#t-price-save-status').innerText(),/권한/);
    await page.evaluate(async()=>{localStorage.setItem(SUPABASE_ENABLED_KEY,'0');await saveOutboundPrices('single');localStorage.setItem(SUPABASE_ENABLED_KEY,'1')});
    assert.match(await page.locator('#t-price-save-status').innerText(),/서버에 연결/);
    const beforeBulk=await page.evaluate(()=>calls.length);
    await page.evaluate(async()=>{bulk(0);bulk(1);reply=()=>Promise.resolve(ok());await saveOutboundPrices('bulk')});
    assert.equal(await page.evaluate(()=>calls.length),beforeBulk+1);
    assert.equal(await page.evaluate(()=>calls.at(-1).args.p_rows.length),1,'Duplicate batch keys collapse');
    assert.equal(await page.locator('#bulk-outbound-tbody .bulk-out-product').nth(0).inputValue(),'가상 목전지(작업)');
    await page.evaluate(async()=>{bulk(1,9999);await saveOutboundPrices('bulk')});
    assert.equal(await page.evaluate(()=>calls.length),beforeBulk+1);
    assert.match(await page.locator('#bulk-out-price-save-status').innerText(),/단가가 서로 다릅니다/);
    await page.evaluate(async()=>{bulk(1);document.querySelectorAll('#bulk-outbound-tbody tr')[1].querySelector('.bulk-out-trader').value='다른 가상 거래처';reply=args=>Promise.resolve(ok(args.p_rows.map((r,i)=>({...r,id:'qa-bulk-'+i}))));await saveOutboundPrices('bulk')});
    assert.equal(await page.evaluate(()=>calls.at(-1).args.p_rows.length),2);
    await page.evaluate(()=>{resetSingle();reply=()=>new Promise(resolve=>pendingResolve=resolve);window.savingTask=saveOutboundPrices('single')});
    const auditBefore=await page.evaluate(()=>JSON.stringify(prices));
    const prompts=await page.evaluate(()=>confirmations.length);
    await page.evaluate(async conflict=>{token='another-login';pendingResolve(conflict);await savingTask},conflict);
    assert.equal(await page.evaluate(()=>confirmations.length),prompts,'Do not confirm after login changed');
    assert.equal(await page.evaluate(()=>JSON.stringify(prices)),auditBefore);
    // Both new controls remain within the actual desktop form at common screen sizes.
    await page.evaluate(()=>{token='qa-token';resetSingle();updateOutboundPriceButtons();document.getElementById('t-price-save-status').hidden=true});
    for(const width of [1280,1366,1440]){
      await page.setViewportSize({width,height:1000});
      for(const id of ['t-save-price-btn','bulk-out-save-price-btn']){
        const box=await page.locator('#'+id).boundingBox();assert(box && box.x>=0 && box.x+box.width<=width,id+' fits '+width);
      }
    }
    const out=path.join(root,'output/playwright/outbound-price-save');fs.mkdirSync(out,{recursive:true});
    await page.locator('#t-save-price-btn').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(out,'outbound-price-button.png')});
    assert.deepEqual(errors,[]);
    console.log('PASS: outbound single/bulk prices, actual forms and existing edit screen; normalized batch dedupe; conflicting update confirmation/version; server errors/login race/permissions; draft preservation; desktop layout');
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
