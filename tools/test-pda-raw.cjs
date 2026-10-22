// All RPCs are fictional; never send a scan or a business write to production.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os'),vm=require('node:vm');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-pda-raw-'));
new vm.Script(fs.readFileSync(path.join(repo,'pda-raw.js'),'utf8'));
const server=http.createServer((req,res)=>{
  const file=path.resolve(repo,new URL(req.url,'http://local').pathname.slice(1)||'pda-raw.html');
  if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.md':'text/plain'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=process.env.DBMT_RAW_TEST_URL||`http://127.0.0.1:${server.address().port}/pda-raw.html`,base=new URL('.',url);
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',args:['--mute-audio']});
  try{
    const context=await browser.newContext({viewport:{width:480,height:800},isMobile:true,hasTouch:true,timezoneId:'Asia/Seoul'}),page=await context.newPage();
    const user={id:'qa-raw-user',displayName:'원료육 테스트'},product={id:'qa-raw-product',name:'삼겹살(원료육)',origin:'독일산',storage:'냉동',brand:'테스트 브랜드',factoryNo:'DE123',kind:'원료육'};
    const cases=[
      {id:'qa-gs1',code:'01040199194722001126031231020017261052476119',rule:'GS1 3102',ruleKey:'gs1',weight:17.26,conversion:1,barcodeLot:'52476119',requiresReview:false},
      {id:'qa-sm',code:'07662300206004601597009456',rule:'SM 26|17|4|2|1.00000000|3',ruleKey:'26|17|4|2|1.00000000|3',weight:15.97,conversion:1,requiresReview:true},
      {id:'qa-lb',code:'019001933617340432010007741125092421256481',rule:'GS1 3201',ruleKey:'gs1',weight:35.11,conversion:.45359237,requiresReview:true}
    ];
    const registered=new Map(),saved=new Map(),calls=[],commits=[],lookups=[],errors=[],blocked=[];
    let canSave=true,loseResponse=false,denyCommit=false,lookupDelay=0;
    page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
    await context.route('**/*',async route=>{
      const request=route.request(),target=new URL(request.url());
      if(request.method()==='GET'){
        if(target.origin===base.origin&&target.pathname.startsWith(base.pathname))return route.continue();
        blocked.push(target.href);return route.abort();
      }
      if(target.origin!=='https://hdwjwtmbsxfjrlvicgnn.supabase.co'){blocked.push(target.href);return route.abort();}
      const headers={'access-control-allow-origin':'*','access-control-allow-headers':'apikey,authorization,content-type','access-control-allow-methods':'POST,OPTIONS'};
      if(request.method()==='OPTIONS')return route.fulfill({status:204,headers,body:''});
      const name=target.pathname.split('/').at(-1),body=request.postDataJSON();calls.push(name);let data;
      const fail=message=>route.fulfill({status:400,headers,contentType:'application/json',body:JSON.stringify({code:'P0001',message})});
      if(name==='dbmt_erp_login'||name==='dbmt_erp_session')data={ok:true,token:'qa-token',user};
      else if(name==='dbmt_erp_logout')data={ok:true};
      else if(name==='dbmt_pda_raw_bootstrap')data={ok:true,canSave,locations:['가공장','물류창고'],products:[product],partners:[{id:'qa-partner',name:'테스트 거래처',tradeType:'매입/매출'},{id:'sales-only',name:'매출 전용',tradeType:'매출'}],rules:[{key:cases[1].ruleKey,label:'사진 검증 국내산',length:26}]};
      else if(name==='dbmt_pda_raw_sources')data={ok:true,rows:[{id:'qa-existing',date:'2026-10-20',lot:'QA-EXISTING',available:100}]};
      else if(name==='dbmt_pda_raw_lookup'){
        lookups.push(body.p_code);if(lookupDelay)await new Promise(resolve=>setTimeout(resolve,lookupDelay));
        const source=cases.find(item=>item.code===body.p_code);if(!source)return fail('검증된 원료육 박스 바코드가 아닙니다.');
        data={ok:true,item:{...source,calculatedWeight:source.weight,registered:false,revision:0,...registered.get(source.id)}};
      }else if(name==='dbmt_pda_raw_commit'){
        commits.push(body);if(denyCommit)return fail('다른 작업자가 처리했습니다. 스캔 목록을 다시 조회해주세요.');
        if(body.p_mode==='inbound'&&!String(body.p_lot||'').trim())return fail('별도 이력번호를 입력해주세요.');
        if(!saved.has(body.p_request_id)){
          const result={ok:true,requestId:body.p_request_id,count:body.p_items.length,weight:body.p_items.reduce((sum,item)=>sum+item.labelWeight,0),items:body.p_items.map(scan=>{
            const source=cases.find(item=>item.code===scan.barcode),pack=registered.get(source.id);
            const lot=body.p_mode==='outbound'?pack.lot:body.p_lot.trim();
            registered.set(source.id,{registered:true,revision:(pack?.revision||0)+1,state:body.p_mode==='outbound'?'shipped':'in_stock',location:body.p_location,product:product.name,productId:product.id,lot,weight:scan.labelWeight,origin:product.origin});
            return {id:source.id,product:product.name,lot,weight:scan.labelWeight,action:body.p_mode==='outbound'?'ship':body.p_source_id?'bind':'receive'};
          }),savedAt:new Date().toISOString()};saved.set(body.p_request_id,{body,result});
        }
        if(loseResponse){loseResponse=false;return route.abort();}data=saved.get(body.p_request_id).result;
      }else if(name==='dbmt_pda_raw_history')data={ok:true,rows:[...saved].map(([id,value])=>({id,created_at:value.result.savedAt,request:{mode:value.body.p_mode,date:value.body.p_date,location:value.body.p_location,sourceId:value.body.p_source_id},result:value.result}))};
      else{blocked.push(name);return route.abort();}
      return route.fulfill({headers,contentType:'application/json',body:JSON.stringify(data)});
    });
    await page.goto(url);assert(await page.locator('#workspace').isHidden());
    await page.locator('#login-id').fill('qa');await page.locator('#login-password').fill('0123');await page.locator('#login-submit').click();await page.locator('#workspace').waitFor({state:'visible'});
    assert.equal(await page.locator('#partner option[value="sales-only"]').count(),0,'Only purchase partners for raw receipt');
    await page.locator('#product-search').fill('DE123');await page.locator('#product').selectOption(product.id);await page.locator('#partner').selectOption('qa-partner');await page.locator('#unit-price').fill('5000');
    await page.locator('#barcode').fill('0104');await page.locator('#barcode').press('Control+]');assert.equal(await page.locator('#barcode').inputValue(),'0104|');
    const scan=async code=>{await page.locator('#barcode').fill(code);await page.locator('#barcode').press('Enter');};
    const idle=()=>page.waitForFunction(()=>!document.getElementById('save-detail').textContent.includes('조회 중'));
    const confirm=async()=>{await page.locator('#save').click();assert(await page.locator('#confirm-save').isDisabled());await page.locator('#confirm-checked').check();await page.locator('#confirm-save').click();};
    await scan(cases[0].code);await idle();assert.equal(await page.locator('#items li').count(),0,'Manufacturer GS1 LOT must not become a domestic traceability number');
    assert.match(await page.locator('#status').innerText(),/별도로 이력번호/);assert.equal(await page.locator('#lot').inputValue(),'');assert(await page.locator('#save').isDisabled());assert.equal(commits.length,0);
    await page.locator('#lot').fill('   ');await scan(cases[1].code);await idle();assert.equal(await page.locator('#items li').count(),0,'Domestic weight barcodes also require a separate traceability number');
    assert(await page.locator('#raw-review').isHidden());assert.match(await page.locator('#status').innerText(),/별도로 이력번호/);
    const traceability='801091101169';await page.locator('#lot').fill(traceability);await page.locator('#lot').press('Enter');assert(await page.locator('#barcode').evaluate(el=>el===document.activeElement));
    await scan(cases[0].code);await idle();assert.equal(await page.locator('#items li').count(),1);assert.match(await page.locator('#items').innerText(),/17\.26 KG/);assert.equal(commits.length,0);
    assert.match(await page.locator('#items').innerText(),new RegExp('이력번호 '+traceability));assert(!(await page.locator('#items .scan-meta').innerText()).includes(cases[0].barcodeLot));
    assert(await page.locator('#product').isDisabled(),'Freeze receiving identity while boxes are queued');
    await scan(cases[0].code);await idle();assert.match(await page.locator('#status').innerText(),/이미 목록/);assert.equal(await page.locator('#items li').count(),1);
    await scan('L12610134894005');await idle();assert.match(await page.locator('#status').innerText(),/검증된/);
    loseResponse=true;await confirm();await page.waitForFunction(()=>document.getElementById('save').textContent==='같은 요청 재시도');assert.equal(commits.length,1);
    const requestId=commits[0].p_request_id;
    assert.equal(commits[0].p_lot,traceability,'Only the separately scanned number is committed');
    assert.equal(await page.locator('#logout').isDisabled(),false,'An uncertain request must not prevent reauthentication');
    await page.reload();await page.locator('#workspace').waitFor({state:'visible'});assert.equal(await page.locator('#items li').count(),1);assert.equal(await page.locator('#save').innerText(),'같은 요청 재시도');
    await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('items').children.length===0);assert.equal(commits.length,2);assert.equal(commits[1].p_request_id,requestId);
    await page.locator('[name="mode"][value="outbound"]').check();await page.locator('#partner').selectOption('qa-partner');await scan(cases[0].code);await idle();
    assert.match(await page.locator('#items').innerText(),new RegExp('이력번호 '+traceability),'Outbound retrieves the saved domestic traceability number');
    denyCommit=true;await confirm();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('다른 작업자'));assert.equal(await page.locator('#items li').count(),1);assert.equal(await page.locator('#save').innerText(),'출고 확인');
    denyCommit=false;await confirm();await page.waitForFunction(()=>document.getElementById('items').children.length===0);
    await scan(cases[0].code);await idle();assert.match(await page.locator('#status').innerText(),/이미 출고/);
    await page.locator('[name="mode"][value="inbound"]').check();await page.locator('#receive-kind').selectOption('bind');
    await page.waitForFunction(()=>document.getElementById('source').options.length===2);await page.locator('#source').selectOption('qa-existing');assert.equal(await page.locator('#lot').inputValue(),'QA-EXISTING');
    await scan(cases[1].code);await page.locator('#raw-review').waitFor({state:'visible'});assert(await page.locator('#raw-review-weight').getAttribute('readonly')!==null);
    assert.equal(await page.locator('#items li').count(),0,'Reviewed SM boxes are not appended before checking');
    await page.locator('#raw-review-checked').check();await page.locator('#raw-review-add').click();await idle();assert.equal(await page.locator('#items li').count(),1);
    await page.locator('#save').click();assert.match(await page.locator('#confirm-title').innerText(),/중량 증가 없음/);
    await page.locator('#confirm-checked').check();await page.locator('#confirm-save').click();await page.waitForFunction(()=>document.getElementById('items').children.length===0);
    assert.equal(commits.at(-1).p_source_id,'qa-existing');assert.equal(commits.at(-1).p_items[0].labelWeight,15.97);
    await page.locator('#receive-kind').selectOption('new');await page.locator('#partner').selectOption('qa-partner');
    await scan(cases[2].code);await page.locator('#raw-review').waitFor({state:'visible'});assert.equal(await page.locator('#raw-review-weight').getAttribute('readonly'),null);
    await page.locator('#raw-review-weight').fill('35.10');await page.locator('#raw-review-checked').check();await page.locator('#raw-review-add').click();await idle();
    assert.match(await page.locator('#items').innerText(),/35\.10 KG/);assert.match(await page.locator('#items').innerText(),/계산 35\.11KG/);
    await confirm();await page.waitForFunction(()=>document.getElementById('items').children.length===0);assert.equal(commits.at(-1).p_items[0].labelWeight,35.1);
    await page.locator('#history-open').click();await page.waitForFunction(()=>document.querySelectorAll('#history-list .history-row').length===4);await page.locator('#history-close').click();
    const extra={...cases[1],id:'qa-extra',code:'07662300206004601597009457'};cases.push(extra);
    await scan(extra.code);await page.locator('#raw-review').waitFor({state:'visible'});await page.keyboard.press('Escape');await idle();assert.equal(await page.locator('#items li').count(),0);
    lookupDelay=80;await scan(extra.code);assert(await page.locator('#save').isDisabled());await page.locator('#raw-review').waitFor({state:'visible'});await page.locator('#raw-review-cancel').click();await idle();lookupDelay=0;
    await context.setOffline(true);assert(await page.locator('#save').isDisabled());await context.setOffline(false);
    canSave=false;await page.reload();await page.locator('#workspace').waitFor({state:'visible'});assert.match(await page.locator('#status').innerText(),/조회만/);
    await page.locator('#product').selectOption(product.id);await page.locator('#lot').fill('QA-READONLY');await scan(extra.code);
    await page.locator('#raw-review').waitFor({state:'visible'});await page.locator('#raw-review-checked').check();await page.locator('#raw-review-add').click();await idle();assert(await page.locator('#save').isDisabled());
    for(const width of [320,390,480,1280]){
      await page.setViewportSize({width,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`No overflow at ${width}px`);
      await page.screenshot({path:path.join(artifacts,`raw-${width}.png`),fullPage:true});
    }
    assert.match(await page.locator('.pda-kind-mini a').first().getAttribute('href'),/^pda\.html$/);
    const stored=await page.evaluate(()=>({...sessionStorage}));assert.deepEqual(Object.keys(stored),['dbmt_pda_session_token'],'Never persist a draft or business data outside pending retries');
    await page.locator('#logout').click();assert(await page.locator('#workspace').isHidden());
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert(calls.every(name=>name.startsWith('dbmt_pda_raw_')||['dbmt_erp_login','dbmt_erp_session','dbmt_erp_logout'].includes(name)),'Raw screen never calls product commit');
    console.log('PASS: separate domestic traceability input for domestic/imported meat, no GS1 manufacturer LOT fallback, outbound traceability preserved, raw keyboard scans/GS1 parser, SM and LB label review, unchanged product navigation, no writes before confirmation, trade-type filters, existing-stock binding, duplicate/error/stale guards, lost-response reload/retry, readonly/offline, history and 320/390/480/1280px');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
