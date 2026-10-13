// Isolated browser fixtures: all remote requests intercepted; no hardware or business writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),vm=require('node:vm');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-pda-'));
new vm.Script(fs.readFileSync(path.join(repo,'pda.js'),'utf8'));
const server=http.createServer((req,res)=>{
  const file=path.resolve(repo,new URL(req.url,'http://local').pathname.slice(1)||'pda.html');
  if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const testUrl=process.env.DBMT_PDA_TEST_URL||`http://127.0.0.1:${server.address().port}/pda.html`;
  const testBase=new URL('.',testUrl);
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const context=await browser.newContext({viewport:{width:320,height:533},isMobile:true,hasTouch:true});
    const user={id:'qa-user',displayName:'테스트',loginId:'qa'};
    const fixture={labelId:'qa-label',code:'DB2610131200-ABC120',product:'돈등심(치즈돈까스용 10mm 슬라이스)',weight:5,lot:'L12610134894005',origin:'국내산',storage:'냉동',packunit:'5KG',mfgdate:'2026-10-13',expdate:'2027-10-12',registered:false,state:'in_stock',revision:0,location:'가공장'};
    let current={...fixture},commits=[],lookups=[],failAfterSave=false,canSave=true,canView=true,lookupDelay=0,denyCommit=false,expireCommit=false;
    const saved=new Map(),errors=[];
    const result=body=>({ok:true,requestId:body.p_request_id,count:body.p_items.length,weight:5*body.p_items.length,received:body.p_mode==='inbound'&&current.state!=='shipped'?body.p_items.length:0,returned:body.p_mode==='inbound'&&current.state==='shipped'?body.p_items.length:0,shipped:body.p_mode==='outbound'?body.p_items.length:0,items:body.p_items.map(item=>({...fixture,code:item.barcode,action:body.p_mode==='outbound'?'ship':current.state==='shipped'?'return':'receive'})),savedAt:new Date().toISOString()});
    await context.route('https://**/*',async route=>{
      const url=new URL(route.request().url());
      if(route.request().method()==='GET'){
        if(url.origin===testBase.origin&&url.pathname.startsWith(testBase.pathname))return route.continue();
        return route.abort();
      }
      const name=new URL(route.request().url()).pathname.split('/').pop(),body=route.request().postDataJSON();
      let data;
      if(name==='dbmt_erp_login'||name==='dbmt_erp_session')data={ok:true,token:'qa-token',user};
      else if(name==='dbmt_erp_logout')data=true;
      else if(name==='dbmt_pda_bootstrap'){
        if(!canView){await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({code:'42501',message:'PDA 입출고 조회·등록 권한을 확인해주세요.'})});return;}
        data={ok:true,locations:['가공장','물류창고'],partners:[{id:'qa-partner',name:'테스트 매출처'}],canSave};
      }
      else if(name==='dbmt_pda_lookup'){
        lookups.push(body.p_code);if(lookupDelay)await new Promise(resolve=>setTimeout(resolve,lookupDelay));
        if(body.p_code==='LOT-ONLY'){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:'P0001',message:'제품 고유바코드를 읽어주세요.'})});return;}
        data={ok:true,item:{...current,...(body.p_code.endsWith('1')?{labelId:'qa-label-2',code:'DB2610131200-ABC121'}:{})}};
      }else if(name==='dbmt_pda_commit'){
        commits.push(body);
        if(expireCommit){await route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({code:'28000',message:'로그인이 만료되었습니다.'})});return;}
        if(denyCommit){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:'P0001',message:'다른 작업자가 처리한 라벨입니다.'})});return;}
        if(!saved.has(body.p_request_id)){saved.set(body.p_request_id,result(body));current={...current,registered:true,state:body.p_mode==='outbound'?'shipped':'in_stock',revision:current.revision+1,location:body.p_location};}
        if(failAfterSave){failAfterSave=false;await route.abort();return;}
        data=saved.get(body.p_request_id);
      }else if(name==='dbmt_pda_history')data={ok:true,rows:[...saved.values()].map(r=>({id:r.requestId,created_at:r.savedAt,request:{mode:r.shipped?'outbound':'inbound',location:'가공장',note:'QA'},result:r}))};
      else throw Error('Unexpected remote request: '+name);
      await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
    await page.goto(testUrl);
    assert(await page.locator('#workspace').isHidden());
    await page.locator('#login-id').fill('qa');await page.locator('#login-password').fill('0000');await page.locator('#login-submit').click();await page.locator('#workspace').waitFor({state:'visible'});
    const scan=async(code='9826101312000623598584')=>{await page.locator('#barcode').fill(code);await page.locator('#barcode').press('Enter');await page.waitForFunction(()=>!document.getElementById('save-detail').textContent.includes('조회 중'));};
    await scan();assert.equal(await page.locator('#items li').count(),1);assert.equal(commits.length,0,'Scanning must not save');assert.match(await page.locator('#items').textContent(),/생산입고 확인/);
    await scan();assert.equal(await page.locator('#items li').count(),1);assert.match(await page.locator('#status').textContent(),/이미 목록/);
    await scan('LOT-ONLY');assert.match(await page.locator('#status').textContent(),/제품 고유바코드/);assert.equal(commits.length,0);
    await page.locator('.scan-remove').click();assert.equal(await page.locator('#items li').count(),0);
    lookupDelay=100;await page.locator('#barcode').fill('A0');await page.locator('#barcode').press('Enter');await page.locator('#barcode').fill('A1');await page.locator('#barcode').press('Enter');await page.waitForFunction(()=>document.getElementById('item-count').textContent==='2');lookupDelay=0;
    assert.equal(commits.length,0);await page.locator('#clear-items').click();await scan();
    await page.locator('#save').click();assert(await page.locator('#confirm-dialog').isVisible());assert.equal(commits.length,0);await page.locator('#confirm-cancel').click();assert.equal(commits.length,0);
    await page.locator('#save').click();await page.locator('#confirm-save').click();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('저장 완료'));
    assert.equal(commits.length,1);assert.equal(saved.size,1);assert.equal(await page.locator('#items li').count(),0);
    await page.locator('[name=mode][value=outbound]').check();await page.locator('#partner').selectOption('qa-partner');await scan();
    await page.screenshot({path:path.join(artifacts,'pm351-outbound.png'),fullPage:true});
    failAfterSave=true;await page.locator('#save').click();await page.locator('#confirm-save').click();await page.waitForFunction(()=>document.getElementById('save').textContent==='같은 요청 재시도');
    assert(await page.locator('#barcode').isDisabled());assert(await page.locator('#clear-items').isDisabled());const requestId=commits.at(-1).p_request_id;
    await page.reload();await page.locator('#workspace').waitFor({state:'visible'});assert.equal(await page.locator('#save').textContent(),'같은 요청 재시도');
    expireCommit=true;await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('로그인이 만료'));
    assert.equal(await page.locator('#save').textContent(),'같은 요청 재시도');assert(await page.locator('#barcode').isDisabled());expireCommit=false;
    await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('저장 완료'));
    assert.equal(commits.at(-1).p_request_id,requestId);assert.equal(saved.size,2,'Lost response/reload/retry must not duplicate the saved batch');
    await page.locator('[name=mode][value=inbound]').check();await page.locator('#location').selectOption('물류창고');await scan();assert.match(await page.locator('#items').textContent(),/반입/);
    await page.locator('#save').click();await page.locator('#confirm-save').click();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('저장 완료'));assert.equal(saved.size,3);
    await scan();assert.equal(await page.locator('#items li').count(),0);assert.match(await page.locator('#status').textContent(),/이미 입고 확인/);
    current={...fixture};await page.locator('#settings-summary').click();await page.locator('#location').selectOption('가공장');await scan();denyCommit=true;
    await page.locator('#save').click();await page.locator('#confirm-save').click();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('저장되지'));
    assert(await page.locator('#barcode').isEnabled());assert.equal(await page.locator('#items li').count(),1);assert.equal(await page.locator('#save').textContent(),'입고 확인');denyCommit=false;
    await page.locator('#clear-items').click();await page.locator('#manual-entry').check();assert.equal(await page.locator('#barcode').getAttribute('inputmode'),'text');
    await page.locator('#history-open').click();await page.locator('#history-list details').nth(2).waitFor();assert.equal(await page.locator('#history-list details').count(),3);await page.locator('#history-close').click();
    await context.setOffline(true);assert(await page.locator('#save').isDisabled());await context.setOffline(false);
    await scan();
    for(const viewport of [{width:320,height:533},{width:480,height:800},{width:390,height:844},{width:1280,height:900}]){
      await page.setViewportSize(viewport);await page.screenshot({path:path.join(artifacts,`${viewport.width}x${viewport.height}.png`),fullPage:true});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow');
      const bounds=await page.locator('#save').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=viewport.width&&bounds.y+bounds.height<=viewport.height);
      const item=await page.locator('#items li').first().boundingBox(),footer=await page.locator('#save-bar').boundingBox();
      assert(item.y+item.height<=footer.y,'First scanned item must be visible above the save bar');
      assert(await page.locator('.brand img').evaluate(img=>img.complete&&img.naturalWidth>0));
    }
    await page.locator('#logout').click();canSave=false;await page.locator('#login-id').fill('qa');await page.locator('#login-password').fill('0000');await page.locator('#login-submit').click();await page.locator('#workspace').waitFor({state:'visible'});
    assert.match(await page.locator('#status').textContent(),/PDA 입출고 등록 권한/);
    await scan();assert(await page.locator('#save').isDisabled());
    await page.locator('#logout').click();canView=false;await page.locator('#login-id').fill('qa');await page.locator('#login-password').fill('0000');await page.locator('#login-submit').click();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('조회·등록 권한'));
    assert(await page.locator('#workspace').isHidden(),'Direct URL/login must not show the PDA workspace without view permission');
    assert.deepEqual(errors,[]);
    console.log('PASS: keyboard scans, rapid scanning queue, LOT rejection, duplicate/removal, no save before confirmation, receive/ship/return, retry after reload, stale-state error, permission/offline guards, history, responsive 320/480/390/1280px');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
