// Short operator viewports and print/fullscreen lifecycle. No real RPCs or print jobs.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-label-viewport-'));
const server=http.createServer((req,res)=>{
  const file=path.resolve(repo,new URL(req.url,'http://local').pathname.slice(1)||'label-print.html');
  if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
    await context.route('https://**/*',r=>r.abort());
    await context.addInitScript(()=>{
      if(parent===window){
        window.__full=null;window.__requests=0;window.__deny=false;window.__prints=0;window.__mode='exit';window.__waiting=null;
        Object.defineProperty(document,'fullscreenElement',{configurable:true,get:()=>__full});
        window.__exit=()=>{__full=null;document.dispatchEvent(new Event('fullscreenchange'));};
        document.exitFullscreen=async()=>__exit();
        Element.prototype.requestFullscreen=async function(){__requests++;if(__deny)throw new Error('Fresh user activation required');__full=this;document.dispatchEvent(new Event('fullscreenchange'));};
      }
      window.print=()=>{
        if(parent===window)throw new Error('Never print the operator page');
        parent.__prints++;
        if(parent.__mode!=='stay')parent.__exit();
        if(parent.__mode==='throw')throw new Error('QA native failure');
        if(parent.__mode==='hold'){parent.__waiting=window;return;}
        setTimeout(()=>dispatchEvent(new Event('afterprint')),10);
      };
    });
    page.on('pageerror',e=>errors.push(e.message));
    const seed=(target=page)=>target.evaluate(()=>{
      state.pin='qa';state.workOrders=[{id:'qa',title:'찌개공방·미전지',product:'미전지(작업)',origin:'미국산',date:'2026-09-16',lot:'L12609164894004',inputWeight:100,weight:12}];state.selectedId='qa';renderAll();
      document.getElementById('scale-value').textContent='0.22';
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/label-print.html`);await seed();
    const summaryClipped=()=>page.evaluate(()=>{
      const panel=document.getElementById('product-open').closest('.panel').getBoundingClientRect();
      return ['#product-open','.scale-readout','.summary-grid'].filter(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return r.top<panel.top-1||r.bottom>panel.bottom+1;});
    });
    // The previous release compressed the header in the same 900px viewport.
    const oldCss='.touch-label .right{grid-template-rows:auto minmax(540px,1fr) auto;}';
    await page.addStyleTag({content:oldCss});assert((await summaryClipped()).length,'Reproduce the old clipped product/scale panel');
    await page.reload();await seed();
    for(const [width,height] of [[1280,1024],[1280,950],[1280,900],[1280,880],[1280,832],[1280,768],[1024,768],[1024,680],[900,700],[736,620],[360,640]]){
      await page.setViewportSize({width,height});
      assert.deepEqual(await summaryClipped(),[],`Full product/scale/metrics at ${width}x${height}`);
      assert(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)),`No horizontal page overflow at ${width}x${height}`);
      const clipped=await page.evaluate(()=>[...document.querySelectorAll('.touch-pack button,.pack-fields small,.calc-keys button')].filter(el=>{
        const b=el.getBoundingClientRect(),p=el.closest('.panel').getBoundingClientRect();return b.bottom>p.bottom+1||b.top<p.top-1;
      }).map(el=>el.id||el.textContent));
      assert.deepEqual(clipped,[],`Touch controls fit panels at ${width}x${height}`);
      if(width===1280&&height>=880){
        const sizes=await page.locator('.right').evaluate(el=>({scroll:el.scrollHeight,client:el.clientHeight,rows:[...el.children].map(e=>({class:e.className,height:e.getBoundingClientRect().height})),body:getComputedStyle(document.body).gridTemplateRows}));
        assert(sizes.scroll<=sizes.client+1,`Whole workspace fits ${width}x${height}: ${JSON.stringify(sizes)}`);
      }
      if(width===1280&&height===900)await page.screenshot({path:path.join(dir,'windowed-1280x900.png')});
    }
    // Long product/status text may require scrolling, never cropped labels.
    await page.setViewportSize({width:1280,height:832});
    await page.evaluate(()=>{state.workOrders[0].product='길이가 긴 생산품목 · 돈까스용 10mm 세부 작업규격 냉동 제품';state.workOrders[0].title='길이가 긴 작업지시명 / 냉동 원료';renderAll();setStatus('통신 상태 안내 '.repeat(30),'warn');});
    assert.deepEqual(await summaryClipped(),[]);
    await page.locator('#complete-production-btn').scrollIntoViewIfNeeded();assert(await page.locator('#complete-production-btn').isVisible());
    await page.locator('#product-open').scrollIntoViewIfNeeded();assert.deepEqual(await summaryClipped(),[]);
    await page.setViewportSize({width:1280,height:900});await seed();
    const print=async()=>{await page.locator('#inner-print-btn').click();await page.waitForFunction(()=>!state.loading);};
    await print();assert.equal(await page.evaluate(()=>__requests),0,'Windowed printing must not force fullscreen');
    await page.locator('#fullscreen-btn').click();assert(await page.evaluate(()=>!!document.fullscreenElement));
    await print();await page.waitForFunction(()=>!!document.fullscreenElement);assert.equal(await page.evaluate(()=>__requests),2,'One automatic restore after printing');
    assert.match(await page.locator('#fullscreen-btn').textContent(),/해제/);
    await page.locator('#fullscreen-btn').click();await print();assert.equal(await page.evaluate(()=>__requests),2,'Respect explicit fullscreen exit');
    await page.locator('#fullscreen-btn').click();await page.evaluate(()=>__deny=true);await print();
    await page.waitForFunction(()=>__requests===4);assert.equal(await page.locator('#fullscreen-btn').textContent(),'전체화면 복귀');
    const count=await page.evaluate(()=>__prints);await page.waitForTimeout(700);assert.equal(await page.evaluate(()=>__requests),4,'No endless automatic fullscreen retry');assert.equal(await page.evaluate(()=>__prints),count,'Recovery failure must never reprint');
    await page.evaluate(()=>__deny=false);await page.locator('#fullscreen-btn').click();assert(await page.evaluate(()=>!!document.fullscreenElement));assert.equal(await page.evaluate(()=>__prints),count,'Manual recovery is not another print');
    await page.evaluate(()=>__mode='stay');await print();assert.equal(await page.evaluate(()=>__requests),5,'Do nothing if fullscreen stayed active');
    await page.evaluate(()=>__mode='hold');await page.locator('#inner-print-btn').click();await page.waitForFunction(()=>!!__waiting);
    await page.keyboard.press('Escape');await page.evaluate(()=>{__waiting.dispatchEvent(new Event('afterprint'));__waiting=null;});await page.waitForFunction(()=>!state.loading);await page.waitForTimeout(350);
    assert(!(await page.evaluate(()=>document.fullscreenElement)),'Escape during printing cancels recovery');assert.equal(await page.locator('#fullscreen-btn').textContent(),'전체화면');
    await page.locator('#fullscreen-btn').click();await page.evaluate(()=>__mode='throw');await print();await page.waitForFunction(()=>!!document.fullscreenElement);
    assert.match(await page.locator('#status').textContent(),/인쇄 확인 필요/);assert.equal(await page.evaluate(()=>state.logs.length),0,'Inner and fullscreen recovery never add production logs');
    assert.equal(context.pages().length,1);assert.equal(await page.locator('iframe[data-dbmt-label-print]').count(),0);assert.deepEqual(errors,[]);
    console.log('PASS: old clipping reproduced, short-height/long-text layout, full 1280x900/880 workspace, fullscreen recovery/denial/manual recovery, no forced entry/retry/duplicate prints, Escape, native failure.');
    // Also exercise the real browser Fullscreen API, without invoking native
    // printing or hardware. Exit is simulated by the mock print function only.
    const native=await browser.newContext({viewport:{width:1280,height:900}}),nativePage=await native.newPage(),nativeErrors=[];
    await native.route('https://**/*',r=>r.abort());
    await native.addInitScript(()=>{
      window.print=()=>{
        if(parent===window)throw new Error('No operator page printing');
        parent.__nativePrints=(parent.__nativePrints||0)+1;
        const end=()=>setTimeout(()=>dispatchEvent(new Event('afterprint')),25);
        if(parent.document.fullscreenElement)parent.document.exitFullscreen().then(end);else end();
      };
    });
    nativePage.on('pageerror',e=>nativeErrors.push(e.message));
    await nativePage.goto(`http://127.0.0.1:${server.address().port}/label-print.html`);await seed(nativePage);
    await nativePage.locator('#fullscreen-btn').click();await nativePage.waitForFunction(()=>!!document.fullscreenElement);
    await nativePage.locator('#inner-print-btn').click();await nativePage.waitForFunction(()=>!state.loading);await nativePage.waitForTimeout(600);
    if(!await nativePage.evaluate(()=>!!document.fullscreenElement)){
      assert.equal(await nativePage.locator('#fullscreen-btn').textContent(),'전체화면 복귀');
      await nativePage.locator('#fullscreen-btn').click();
    }
    await nativePage.waitForFunction(()=>!!document.fullscreenElement);
    assert.equal(await nativePage.evaluate(()=>__nativePrints),1);assert.deepEqual(nativeErrors,[]);
    await nativePage.locator('#fullscreen-btn').click();await nativePage.waitForFunction(()=>!document.fullscreenElement);
    console.log('PASS: actual browser Fullscreen API entry, print-exit simulation, recovery/fallback and explicit exit; native printing mocked.');
    await native.close();
    console.log('Artifacts: '+dir);
  }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
