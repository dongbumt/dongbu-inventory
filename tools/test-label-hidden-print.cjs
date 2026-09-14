// Real local DOM/iframe flow. All RPCs and native printing are mocked.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const {setOuter}=require('./label-touch-test-helpers.cjs');
const repo=path.resolve(__dirname,'..');
const server=http.createServer((req,res)=>{
  const file=path.resolve(repo,new URL(req.url,'http://localhost').pathname.slice(1)||'label-print.html');
  if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:1024}});
    let saves=[],failSave=false,failImage=false,imageDelay=0;
    await context.route('https://**/*',async route=>{
      if(route.request().url().endsWith('/dbmt_label_print_save_logs')){
        if(failSave){await route.fulfill({status:500,contentType:'application/json',body:'{"message":"QA save failed"}'});return;}
        saves.push(route.request().postDataJSON());
        await route.fulfill({contentType:'application/json',body:'{"ok":true}'});return;
      }
      await route.abort();
    });
    await context.route('**/HACCP2.png',async route=>{
      if(failImage){await route.fulfill({status:404,body:''});return;}
      if(imageDelay) await new Promise(resolve=>setTimeout(resolve,imageDelay));
      await route.continue();
    });
    await context.addInitScript(()=>{
      window.__requests=[];window.__waitingFrames=[];window.__printMode='async';window.__topPrints=0;
      window.print=()=>{
        if(window.parent===window){window.__topPrints++;return;}
        const parent=window.parent,mode=parent.__printMode;
        if(mode==='throw') throw new Error('QA print unavailable');
        parent.__requests.push({
          text:document.getElementById('label-print-pages').textContent,
          count:document.querySelectorAll('.print-label').length,
          imagesReady:[...document.images].every(img=>img.complete&&img.naturalWidth>0),
          frameStyle:window.frameElement.getAttribute('style'),
          hidden:window.frameElement.getAttribute('aria-hidden'),
          focus:parent.document.activeElement?.id,
          css:document.querySelector('style').textContent
        });
        if(mode==='hold'){parent.__waitingFrames.push(window);return;}
        if(mode==='sync'){window.dispatchEvent(new Event('afterprint'));return;}
        setTimeout(()=>window.dispatchEvent(new Event('afterprint')),10);
      };
    });
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/label-print.html');
    await page.evaluate(()=>{
      state.pin='qa-pin';state.workOrders=[{id:'qa-order',date:'2026-09-14',product:'돈등심(작업)',inputWeight:100,weight:0,origin:'미국산',lot:'903112100182',mfgdate:'2026-09-14',expdate:'2027-09-13',temptype:'냉동',itemno:'202502930933'}];
      state.selectedId='qa-order';state.allDates=true;renderAll();
      window.__originalOpen=window.open;window.__openCalls=0;
      window.open=()=>{window.__openCalls++;return null;};
    });
    await setOuter(page,5,2);
    imageDelay=250;
    await page.evaluate(()=>{printSelectedLabels();printSelectedLabels();});
    await page.waitForFunction(()=>!state.loading);
    let requests=await page.evaluate(()=>__requests);
    assert.equal(requests.length,1,await page.locator('#status').textContent());
    assert.equal(saves.length,1,'Rapid duplicate click must not duplicate saved logs');
    assert.equal(requests[0].count,2);assert(requests[0].imagesReady);
    assert.equal(requests[0].hidden,'true');assert.match(requests[0].frameStyle,/opacity:\s*0/);
    assert(!/display:\s*none|visibility:\s*hidden/.test(requests[0].frameStyle));
    assert.match(requests[0].css,/size:70mm 100mm/);assert.match(requests[0].css,/width:67mm/);
    assert.equal(await page.locator('iframe[data-dbmt-label-print]').count(),0);
    assert.equal(await page.evaluate(()=>__openCalls),0);assert.equal(context.pages().length,1);
    assert.equal(await page.locator('#metric-output').textContent(),'10 kg');
    imageDelay=0;
    const originalId=await page.evaluate(()=>state.logs[0].id);
    await setOuter(page,20);
    await page.evaluate(id=>reprintLog(id),originalId);
    requests=await page.evaluate(()=>__requests);
    assert.equal(requests.length,2);assert.match(requests[1].text,/5\.00/);
    assert.equal(await page.evaluate(()=>state.logs.length),2);assert.equal(await page.locator('#metric-output').textContent(),'10 kg');
    console.log('PASS: hidden normal/reprint, popup-blocker independence, rapid-click guard, delayed artwork, original reprint weight and unchanged production totals');

    failSave=true;
    const savedBefore=saves.length;
    await page.locator('#print-btn').click();await page.waitForFunction(()=>!state.loading);
    assert.equal(await page.evaluate(()=>__requests.length),2);assert.equal(saves.length,savedBefore);
    assert.equal(await page.evaluate(()=>state.logs.length),2);assert.equal(await page.locator('iframe[data-dbmt-label-print]').count(),0);
    assert.match(await page.locator('#status').textContent(),/출력 저장 실패/);
    failSave=false;failImage=true;
    await setOuter(page,undefined,1);
    await page.locator('#print-btn').click();await page.waitForFunction(()=>!state.loading);
    assert.equal(await page.evaluate(()=>__requests.length),2,'Missing certification image must not print');
    assert.equal(await page.evaluate(()=>state.logs.length),3,'A committed print log must survive image preparation failure');
    assert.equal(await page.locator('#metric-output').textContent(),'30 kg');
    assert.match(await page.locator('#status').textContent(),/출력이력은 저장됐습니다/);
    failImage=false;
    const failedId=await page.evaluate(()=>state.logs[0].id);
    await page.evaluate(id=>reprintLog(id),failedId);
    assert.equal(await page.evaluate(()=>__requests.length),3);assert.equal(await page.evaluate(()=>state.logs.length),3);
    assert.equal(await page.locator('#metric-output').textContent(),'30 kg','Retry via history must not add production weight');
    await page.evaluate(()=>__printMode='throw');
    await page.evaluate(id=>reprintLog(id),failedId);
    assert.equal(await page.evaluate(()=>__requests.length),3);assert.match(await page.locator('#status').textContent(),/재출력 기록은 저장됐습니다/);
    assert.equal(await page.locator('iframe[data-dbmt-label-print]').count(),0);
    console.log('PASS: no print on save failure; preserve committed logs on image/native-print failure; history retry without duplicate production');

    // Queue two jobs while the native print lifecycle remains open.
    await page.evaluate(()=>{
      __printMode='hold';window.__queueDone=[];
      DBMTLabelPrint.printHidden({labelsHtml:'<section class="print-label">queue first</section>'}).then(()=>__queueDone.push(1));
      DBMTLabelPrint.printHidden({labelsHtml:'<section class="print-label">queue second</section>'}).then(()=>__queueDone.push(2));
    });
    await page.waitForFunction(()=>__waitingFrames.length===1);
    assert.equal(await page.locator('iframe[data-dbmt-label-print]').count(),1);
    assert.equal(await page.evaluate(()=>__queueDone.length),0);
    await page.evaluate(()=>__waitingFrames.shift().dispatchEvent(new Event('afterprint')));
    await page.waitForFunction(()=>__queueDone.length===1&&__waitingFrames.length===1);
    await page.evaluate(()=>__waitingFrames.shift().dispatchEvent(new Event('afterprint')));
    await page.waitForFunction(()=>__queueDone.length===2);
    assert.deepEqual(await page.evaluate(()=>__queueDone),[1,2]);assert.equal(await page.locator('iframe[data-dbmt-label-print]').count(),0);
    await page.evaluate(async()=>{__printMode='sync';await DBMTLabelPrint.printHidden({labelsHtml:'<section class="print-label">sync afterprint</section>'});});
    assert.equal(await page.locator('iframe[data-dbmt-label-print]').count(),0);

    // Accelerate only the print-notification deadline, not native printing.
    await page.evaluate(()=>{
      __printMode='hold';window.__savedTimeout=window.setTimeout;
      window.setTimeout=(fn,ms,...args)=>__savedTimeout(fn,ms===120000?100:ms,...args);
      window.__timeoutMessage='';DBMTLabelPrint.printHidden({labelsHtml:'<section class="print-label">missing afterprint</section>'}).catch(error=>__timeoutMessage=error.message);
    });
    await page.waitForFunction(()=>__timeoutMessage);
    assert.match(await page.evaluate(()=>__timeoutMessage),/인쇄 종료 알림/);
    assert.equal(await page.locator('iframe[data-dbmt-label-print]').count(),1,'Do not destroy a possibly active print document on timeout');
    const printCount=await page.evaluate(()=>__requests.length);
    const busyError=await page.evaluate(()=>DBMTLabelPrint.printHidden({labelsHtml:'retry'}).then(()=>'',error=>error.message));
    assert.match(busyError,/이전 인쇄/);assert.equal(await page.evaluate(()=>__requests.length),printCount);
    await page.evaluate(()=>{window.setTimeout=__savedTimeout;__waitingFrames.shift().dispatchEvent(new Event('afterprint'));});
    await page.waitForFunction(()=>document.querySelectorAll('iframe[data-dbmt-label-print]').length===0);
    console.log('PASS: serialized native requests, synchronous/asynchronous afterprint, safe timeout, no automatic retry and late cleanup');

    // Explicit preview stays in-page and never auto-prints.
    await page.evaluate(()=>{window.open=__originalOpen;__printMode='async';});
    const beforePreview=await page.evaluate(()=>__requests.length);await page.locator('#preview-btn').click();
    await page.frameLocator('#label-preview-frame').locator('.print-label').waitFor();
    assert.equal(await page.evaluate(()=>__requests.length),beforePreview);assert.equal(await page.evaluate(()=>__topPrints),0);
    await page.locator('#label-preview-close').click();assert.equal(context.pages().length,1);assert.deepEqual(errors,[]);
    console.log('PASS: explicit preview preserved, no automatic preview printing, no page errors');
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
