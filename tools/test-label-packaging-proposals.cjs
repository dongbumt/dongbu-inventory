// Isolated interactive proposals. No real ERP data, printer, scale or browser profile.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {chromium}=require('playwright');
const source=path.resolve(__dirname,'../prototypes/label-touch-packaging-proposals.html');
const html=fs.readFileSync(source,'utf8');
assert(Buffer.byteLength(html)<1_000_000);
assert(!/<\/?(?:html|head|body)(?:\s|>)/i.test(html),'Fragment only');
assert(!html.includes('\\"')&&!html.includes('\\n'),'Literal markup');
assert(!/\b(?:fetch|XMLHttpRequest|WebSocket|requestPort|localStorage|sessionStorage)\b|window\.print|\.supabase\b/.test(html),'No live integrations');
assert.equal((html.match(/class="dp-proposal"/g)||[]).length,1);
require('node:child_process').execFileSync(process.execPath,[path.join(__dirname,'build-label-proposal-preview.cjs'),'--check'],{stdio:'inherit'});
for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-packaging-proposals-'));
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:1024},deviceScaleFactor:1});
    await context.route('**/*',route=>route.abort());
    await context.addInitScript(()=>{window.print=()=>{throw Error('Must not print');};window.open=()=>{throw Error('Must not open windows');};});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>'+html+'</body></html>');
    for(const layout of ['rows']){
      const proposal=page.locator(`.dp-proposal[data-layout="${layout}"]`),screen=proposal.locator('.dp-screen');
      await screen.screenshot({path:path.join(dir,`${layout}-1280.png`)});
      const bounds=await screen.evaluate(el=>{
        const s=el.getBoundingClientRect();
        const outside=[...el.querySelectorAll('button,input,.dp-panel,.dp-status')].filter(n=>n.getClientRects().length).filter(n=>{const b=n.getBoundingClientRect();return b.right>s.right+1||b.bottom>s.bottom+1||b.left<s.left-1;}).map(n=>({text:n.textContent.slice(0,40),cls:n.className,rect:n.getBoundingClientRect().toJSON()}));
        const tiny=[...el.querySelectorAll('button,input')].filter(n=>n.getClientRects().length).filter(n=>{const b=n.getBoundingClientRect();return b.width<43||b.height<43;}).map(n=>n.textContent);
        const panelOverflow=[...el.querySelectorAll('.dp-panel button')].filter(n=>n.getClientRects().length).filter(n=>{const b=n.getBoundingClientRect(),p=n.closest('.dp-panel').getBoundingClientRect();return b.bottom>p.bottom+1||b.right>p.right+1;}).map(n=>n.textContent);
        return {width:s.width,height:s.height,outside,tiny,panelOverflow,calcHeight:el.querySelector('.dp-calc-keys button').getBoundingClientRect().height};
      });
      console.log(layout,JSON.stringify(bounds));
      assert.equal(bounds.width,1280);assert.equal(bounds.height,1024);assert.deepEqual(bounds.outside,[],'All controls inside target monitor');assert.deepEqual(bounds.tiny,[],'44px minimum hit targets');assert.deepEqual(bounds.panelOverflow,[],'No controls overlapping adjacent panels');
      assert.equal(await screen.locator('.dp-order').count(),4);
      assert((await screen.locator('.dp-order-panel').boundingBox()).height>400,'Expanded work list');
      assert.equal(await screen.locator('.dp-left .dp-scale-readout').count(),0);
      assert.equal(await screen.locator('.dp-job-head .dp-scale-readout').count(),1);
      const production=()=>screen.locator('[data-metric="production"]').textContent();
      const visiblePrint=kind=>screen.locator(`button[data-action="print"][data-kind="${kind}"]:visible`);
      const history=async()=>{await screen.getByRole('button',{name:'외포장 이력 선택 재출력',exact:true}).click();return screen.getByRole('dialog');};
      assert.match(await screen.locator('[data-metric="scale"]').textContent(),/2\.48/);
      assert.match(await screen.locator('[data-applied="outer"]').textContent(),/2\.48/);
      await screen.getByRole('button',{name:'외포장 고정중량',exact:true}).click();
      assert.equal(await production(),'120 kg');
      await visiblePrint('inner').click();await visiblePrint('inner').click();
      assert.equal(await production(),'120 kg');assert.equal(await screen.locator('[data-metric="inner"]').textContent(),'20장');
      await screen.getByRole('button',{name:'외포장 매수 늘리기',exact:true}).click();
      await visiblePrint('outer').click();assert.equal(await production(),'160 kg');assert.equal(await screen.locator('[data-metric="outer"]').textContent(),'8장');
      let h=await history();assert.match(await h.textContent(),/돈등심\(작업\) · 8건/);assert(!/LA갈비/.test(await h.textContent()));assert(await h.locator('[data-action="history-print"]').isDisabled());
      await h.locator('input[type="checkbox"]').first().check();await h.getByRole('button',{name:'다음',exact:true}).click();await h.locator('input[type="checkbox"]').last().check();
      await h.locator('[data-action="history-preview"]').last().click();assert.match(await screen.locator('.dp-actual-label').textContent(),/20\.00/);assert.match(await screen.locator('.dp-actual-label').textContent(),/903112100182/);
      await screen.screenshot({path:path.join(dir,'actual-label-preview-1280.png')});
      const label=screen.locator('.dp-actual-label');
      for(const text of ['품목보고번호','소고기를 사용한 제품','주식회사 동부엠티','032-766-1812','1399'])assert((await label.textContent()).includes(text),text);
      assert.equal(await label.locator('img').count(),2);
      assert(await label.locator('img').evaluateAll(images=>images.every(img=>img.complete&&img.naturalWidth>0)),'Actual logo bytes decoded');
      const dimensions=await label.evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,scroll:el.scrollHeight,client:el.clientHeight}));
      assert(Math.abs(dimensions.width-67*96/25.4*1.4)<1);assert(Math.abs(dimensions.height-100*96/25.4*1.4)<1);assert(dimensions.scroll<=dimensions.client+1,'Full label fits');
      await screen.getByRole('button',{name:'목록으로',exact:true}).click();h=screen.getByRole('dialog');assert.equal(await h.locator('input:checked').count(),1);assert.match(await h.locator('[data-action="history-print"]').textContent(),/선택 2장/);
      await h.getByRole('button',{name:'이전',exact:true}).click();assert.equal(await h.locator('input:checked').count(),1);await screen.screenshot({path:path.join(dir,'outer-history-1280.png')});
      await h.locator('[data-action="history-print"]').click();assert.equal(await production(),'160 kg');assert.equal(await screen.locator('[data-metric="outer"]').textContent(),'8장');assert.equal(await screen.locator('[data-metric="inner"]').textContent(),'20장');
      h=await history();assert.match(await h.textContent(),/8건/);assert.match(await h.textContent(),/재출력 1회/);await page.keyboard.press('Escape');
      await screen.getByRole('button',{name:'내포장 중량 수정',exact:true}).click();
      let dialog=screen.getByRole('dialog');await dialog.getByRole('button',{name:'2',exact:true}).click();await dialog.getByRole('button',{name:'.',exact:true}).click();await dialog.getByRole('button',{name:'5',exact:true}).click();await dialog.getByRole('button',{name:'적용',exact:true}).click();
      assert.match(await screen.getByRole('button',{name:'내포장 중량 수정',exact:true}).textContent(),/2\.50/);
      assert.match(await screen.getByRole('button',{name:'외포장 중량 수정',exact:true}).textContent(),/20\.00/);
      await screen.getByRole('button',{name:'내포장 매수 입력',exact:true}).click();dialog=screen.getByRole('dialog');await dialog.getByLabel('라벨 숫자 입력').fill('1.2');await dialog.getByRole('button',{name:'적용',exact:true}).click();assert.match(await dialog.getByRole('alert').textContent(),/정수/);await page.keyboard.press('Escape');
      for(const key of ['2','.','5','×','4','='])await screen.getByRole('button',{name:`계산기 ${key}`,exact:true}).click();
      assert.equal(await screen.locator('.dp-calc-output').textContent(),'10');assert.equal(await production(),'160 kg');
      await screen.locator('.dp-order[data-job="1"]').click();assert.equal(await production(),'30 kg');await screen.locator('.dp-order[data-job="0"]').click();assert.equal(await production(),'160 kg');
      await screen.getByRole('button',{name:'생산완료 · 전송',exact:true}).click();dialog=screen.getByRole('dialog');assert.match(await dialog.textContent(),/160 kg/);assert.match(await dialog.textContent(),/20장 · 전송량에서 제외/);await dialog.getByRole('button',{name:'전송 시연',exact:true}).click();
      assert(await visiblePrint('outer').isDisabled());assert(!(await visiblePrint('inner').isDisabled()));await visiblePrint('inner').click();assert.equal(await production(),'160 kg');
      h=await history();await h.locator('input[type="checkbox"]').first().check();await h.locator('[data-action="history-print"]').click();assert.equal(await production(),'160 kg');
      await screen.locator('button[data-action="preview"]:visible').first().click();assert(await screen.getByRole('dialog').isVisible());await page.keyboard.press('Escape');
      assert.equal(context.pages().length,1);
      console.log(`PASS ${layout}: inner exclusion, outer accumulation, independent weights/copies, keypad validation, calculator, job retention, outer-only completion, preview`);
      await screen.locator('.dp-order[data-job="1"]').click();
      const setScale=async(value,status)=>{
        await screen.getByRole('button',{name:'계근중량 시연 설정',exact:true}).click();
        const d=screen.getByRole('dialog');await d.getByLabel('시연 중량',{exact:true}).fill(String(value));await d.getByLabel('시연 수신 상태').selectOption(status);await d.getByRole('button',{name:'시연 적용',exact:true}).click();
      };
      assert.equal(await production(),'30 kg');
      await visiblePrint('outer').click();assert.equal(await production(),'32.48 kg');
      await screen.getByRole('button',{name:'내포장 계근중량',exact:true}).click();await visiblePrint('inner').click();assert.equal(await production(),'32.48 kg');
      assert(await screen.getByRole('button',{name:'외포장 매수 늘리기',exact:true}).isDisabled());
      await setScale(4.2,'stable');assert.match(await screen.locator('[data-applied="outer"]').textContent(),/4\.20/);assert.match(await screen.locator('[data-applied="inner"]').textContent(),/4\.20/);
      h=await history();assert.match(await h.textContent(),/LA갈비\(작업\) · 7건/);assert(!/돈등심/.test(await h.textContent()));await h.locator('input[type="checkbox"]').first().check();
      await h.locator('[data-action="history-preview"]').first().click();assert.match(await screen.locator('.dp-actual-label').textContent(),/2\.48/);assert.match(await screen.locator('.dp-actual-label').textContent(),/돼지고기를 사용한 제품/);
      await screen.getByRole('button',{name:'목록으로',exact:true}).click();await screen.locator('[data-action="history-print"]').click();assert.match(await screen.locator('.dp-status').textContent(),/2\.48 kg/);assert.equal(await production(),'32.48 kg');
      await visiblePrint('outer').click();assert.equal(await production(),'36.68 kg');
      for(const [weight,status] of [[3,'moving'],[3,'offline'],[0,'stable']]){
        await setScale(weight,status);assert(await visiblePrint('outer').isDisabled());assert(await visiblePrint('inner').isDisabled());assert.match(await screen.locator('[data-applied="outer"]').textContent(),/—/);assert.equal(await production(),'36.68 kg');
      }
      await screen.getByRole('button',{name:'외포장 고정중량',exact:true}).click();assert(!(await visiblePrint('outer').isDisabled()));assert.match(await screen.getByRole('button',{name:'외포장 중량 수정',exact:true}).textContent(),/5\.00/);
      await setScale(2.48,'stable');await screen.getByRole('button',{name:'외포장 계근중량',exact:true}).click();
      await screen.locator('.dp-order[data-job="2"]').click();h=await history();assert.match(await h.textContent(),/이 작업의 외포장 출력이력이 없습니다/);assert(await h.locator('[data-action="history-print"]').isDisabled());await page.keyboard.press('Escape');
      await screen.locator('.dp-order[data-job="1"]').click();
      console.log(`PASS ${layout}: live sample -> label weight, separate modes, one-per-weigh, inner exclusion, reprint snapshot, moving/offline/zero interlocks, fixed-weight fallback`);
    }
    for(const width of [1024,736,320]){
      await page.setViewportSize({width,height:1024});
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
      assert(!overflow,`No page horizontal overflow at ${width}`);
      for(const layout of ['rows']){
        const screen=page.locator(`.dp-proposal[data-layout="${layout}"] .dp-screen`);
        const outside=await screen.evaluate(el=>{const s=el.getBoundingClientRect();return [...el.querySelectorAll('button,input,.dp-panel')].filter(n=>n.getClientRects().length).filter(n=>{const b=n.getBoundingClientRect(),p=n.closest('.dp-panel')?.getBoundingClientRect()||s;return b.right>s.right+1||b.bottom>s.bottom+1||b.bottom>p.bottom+1||b.right>p.right+1;}).map(n=>n.className);});
        assert.deepEqual(outside,[],`${layout} within bounds at ${width}`);
        if(width===1024||width===320)await screen.screenshot({path:path.join(dir,`${layout}-${width}.png`)});
        await screen.locator('button[data-action="preview"]:visible').first().click();
        assert(await screen.locator('.dp-actual-label').isVisible());
        const previewBounds=await screen.locator('.dp-actual-page').boundingBox();assert(previewBounds.x>=0&&previewBounds.x+previewBounds.width<=width+1,'Preview fits viewport');
        await screen.getByRole('dialog').screenshot({path:path.join(dir,`preview-${width}.png`)});await page.keyboard.press('Escape');
        await screen.locator('[data-action="reprint"]').click();
        const historyBounds=await screen.getByRole('dialog').boundingBox();assert(historyBounds.x>=0&&historyBounds.x+historyBounds.width<=width+1,'History fits viewport');
        await screen.getByRole('dialog').screenshot({path:path.join(dir,`history-${width}.png`)});await page.keyboard.press('Escape');
      }
    }
    assert.deepEqual(errors,[]);console.log('PASS: responsive 1024/736/320px, zero script errors');console.log('Artifacts: '+dir);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
