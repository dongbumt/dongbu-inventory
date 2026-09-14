// Production page with isolated RPC/serial/printer fixtures. Never contacts ERP or hardware.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),vm=require('node:vm');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-touch-live-'));
const pure={window:{}};vm.runInNewContext(fs.readFileSync(path.join(repo,'label-scale.js'),'utf8'),pure);
const parse=pure.window.DBMTScale.parse;
assert.equal(parse('ST,+00000.24 kg').value,.24);assert.equal(parse('US,+00003.24 kg').stable,false);
for(const input of ['noise','ST,+00001.23 g','ST,+00150.02 kg','ST,+00001.234 kg','OL,+00020.00 kg'])assert.equal(parse(input),null,input);
const server=http.createServer((req,res)=>{const file=path.resolve(repo,new URL(req.url,'http://local').pathname.slice(1)||'label-print.html');if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:1024}}),page=await context.newPage(),errors=[];
    let saves=0,completeIds=[],fail=false,logs=[],done=false;
    const order={id:'a',title:'돈등심 작업',product:'돈등심(작업)',date:'2026-09-15',mfgdate:'2026-09-15',expdate:'2027-09-14',lot:'903112100182',origin:'미국산',inputWeight:100,weight:20};
    const completion=()=>done?[{workOrderId:'a',productionId:'qa-production',date:'2026-09-15',jobNo:'1',deleted:false}]:[];
    await context.route('https://**/*',async route=>{
      const name=route.request().url().split('/').pop(),body=route.request().postDataJSON();let result={};
      if(name==='dbmt_label_print_get_data')result={appData:{workOrders:[order,{...order,id:'b',product:'LA갈비(작업)',title:'LA갈비 작업',lot:'OTHER-LOT',weight:5},{...order,id:'c'},{...order,id:'d'}],labelProducts:[],labelPrintLogs:logs},completions:completion()};
      else if(name==='dbmt_label_print_save_logs'){
        if(fail){await route.fulfill({status:500,contentType:'application/json',body:'{"message":"QA save fail"}'});return;}
        saves++;logs=body.p_logs;result={ok:true,logs,completions:completion()};
      }else if(name==='dbmt_label_complete_production'){completeIds=body.p_log_ids;done=true;result={ok:true,completions:completion()};}
      await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
    });
    await context.addInitScript(()=>{
      window.__prints=[];window.__portOptions=null;window.__portRequests=0;window.__portClosed=0;
      window.print=()=>{if(parent!==window){parent.__prints.push({count:document.querySelectorAll('.print-label').length,text:document.querySelector('#label-print-pages').textContent});setTimeout(()=>dispatchEvent(new Event('afterprint')),0);}};
      const port={readable:null,async open(options){window.__portOptions=options;this.readable=new ReadableStream({start(controller){window.__serialController=controller;}});},async close(){window.__portClosed++;}};
      Object.defineProperty(navigator,'serial',{configurable:true,value:{async requestPort(){window.__portRequests++;return port;}}});
      window.__send=text=>window.__serialController.enqueue(new TextEncoder().encode(text));
    });
    page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    await page.goto(base+'/label-print.html');await page.locator('#app-password').fill('0000');await page.locator('#connect-btn').click();await page.waitForFunction(()=>!state.loading&&state.workOrders.length);
    const edit=async(kind,field,value)=>{await page.locator(`#${kind}-${field==='weight'?'weight':'copies'}-btn`).click();await page.locator('#number-input').fill(String(value));await page.locator('#number-apply').click();};
    const wait=()=>page.waitForFunction(()=>!state.loading);
    const production=()=>page.locator('#metric-output').textContent();
    async function layout(width){
      await page.setViewportSize({width,height:1024});
      const bad=await page.evaluate(()=>{
        const visible=[...document.querySelectorAll('.shell button,.shell input,.shell select,.pack-fields small')].filter(el=>el.getClientRects().length);
        return visible.filter(el=>!el.closest('.order-list')).filter(el=>{const b=el.getBoundingClientRect(),p=el.closest('.panel')?.getBoundingClientRect();return b.right>innerWidth+1||b.left<0||(p&&b.bottom>p.bottom+1);}).map(el=>({id:el.id,text:el.textContent.slice(0,20),bottom:el.getBoundingClientRect().bottom,p:el.closest('.panel')?.getBoundingClientRect().bottom}));
      });
      assert.deepEqual(bad,[],`No panel overflow at ${width}`);assert(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)));
      const panels=await page.locator('.touch-pack').evaluateAll(els=>els.map(el=>{const b=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();return b.top>=p.top-1&&b.bottom<=p.bottom+1;}));assert(panels.every(Boolean),'Packages fit their grid; do not overlap transfer buttons');
      await page.screenshot({path:path.join(dir,`layout-${width}.png`),fullPage:true});
    }
    await layout(1280);
    assert.equal(await page.evaluate(()=>__portRequests),0,'Never auto-probe office computer');
    await edit('inner','weight',2);await edit('inner','copies',3);await page.locator('#inner-print-btn').click();await wait();
    assert.equal(saves,0);assert.equal(logs.length,0);assert.equal(await page.evaluate(()=>__prints[0].count),3);
    await edit('outer','weight',5);await edit('outer','copies',5);await page.locator('#print-btn').click();await wait();assert.equal(saves,1);assert.equal(logs.length,5);assert.equal(await production(),'25 kg');
    await page.locator('#reprint-open').click();await page.locator('#history-body input').first().check();await page.locator('#history-next').click();await page.locator('#history-body input').first().check();
    await page.locator('#history-body [data-act=preview]').first().click();const frame=page.frameLocator('#label-preview-frame');await frame.locator('.print-label').waitFor();assert.match(await frame.locator('.print-label').textContent(),/5\.00/);assert.equal(await frame.locator('img').count(),2);
    assert.equal(context.pages().length,1);await page.locator('#label-preview-dialog').screenshot({path:path.join(dir,'preview.png')});
    await page.locator('#label-preview-close').click();assert.match(await page.locator('#history-print').textContent(),/선택 2장/);await page.locator('#history-print').click();await wait();assert.equal(logs.length,5);assert.equal(await production(),'25 kg');assert.equal(await page.evaluate(()=>__prints.at(-1).count),2);
    await page.locator('#history-dialog').screenshot({path:path.join(dir,'history.png')});await page.locator('[data-close=history-dialog]').click();
    // A separate job has no history. Original settings survive switching back.
    await page.evaluate(()=>selectOrder('b'));await page.locator('#reprint-open').click();assert.match(await page.locator('#history-body').textContent(),/이 작업의 외포장 출력이력이 없습니다/);await page.locator('[data-close=history-dialog]').click();
    await page.evaluate(()=>selectOrder('a'));assert.equal(await page.evaluate(()=>DBMTLabelTouch.weight('outer')),5);assert.equal(await page.evaluate(()=>DBMTLabelTouch.copies('outer')),5);
    await page.locator('#scale-open').click();await page.locator('#scale-connect').click();await page.waitForFunction(()=>__portOptions);assert.deepEqual(await page.evaluate(()=>__portOptions),{baudRate:2400,dataBits:7,stopBits:1,parity:'even',flowControl:'none'});await page.locator('[data-close=scale-dialog]').click();
    await page.locator('[data-kind=outer][data-mode=scale]').click();assert(await page.locator('#print-btn').isDisabled());
    await page.evaluate(()=>__send('ST,+00002.'));assert(await page.locator('#print-btn').isDisabled());await page.evaluate(()=>__send('48 kg\r\n'));await page.waitForFunction(()=>!document.getElementById('print-btn').disabled);
    assert.equal(await page.evaluate(()=>DBMTLabelTouch.copies('outer')),1);await page.locator('#print-btn').click();await wait();assert.equal(await production(),'27.48 kg');assert.equal(logs.at(0).labelWeight,2.48);
    for(const line of ['US,+00003.00 kg\r\n','ST,+00000.00 kg\r\n','ST,-00001.00 kg\r\n','bad frame\r\n']){await page.evaluate(line=>__send(line),line);await page.waitForFunction(()=>document.getElementById('print-btn').disabled);}
    await page.evaluate(()=>__send('ST,+00004.20 kg\r\n'));await page.waitForFunction(()=>!document.getElementById('print-btn').disabled);
    await page.waitForFunction(()=>document.getElementById('print-btn').disabled,{},{timeout:5000});assert.equal(await page.locator('#scale-value').textContent(),'—','Stale weight cleared');
    await page.locator('#scale-open').click();await page.locator('#scale-disconnect').click();await page.waitForFunction(()=>__portClosed===1);await page.locator('[data-close=scale-dialog]').click();
    await page.locator('[data-kind=outer][data-mode=fixed]').click();assert.equal(await page.evaluate(()=>DBMTLabelTouch.weight('outer')),5);await edit('outer','copies',1);
    fail=true;const before=await page.evaluate(()=>__prints.length);await page.locator('#print-btn').click();await wait();assert.equal(await page.evaluate(()=>__prints.length),before);assert.equal(logs.length,6);assert.match(await page.locator('#status').textContent(),/출력 저장 실패/);fail=false;
    await page.locator('#complete-production-btn').click();await wait();assert.equal(completeIds.length,6);assert(await page.locator('#print-btn').isDisabled());assert(await page.locator('#inner-print-btn').isEnabled());
    const saved=saves;await page.locator('#inner-print-btn').click();await wait();assert.equal(saves,saved);assert.equal(await production(),'27.48 kg');
    await page.locator('#reprint-open').click();await page.locator('#history-body input').first().check();await page.locator('#history-print').click();await wait();assert.equal(await production(),'27.48 kg');await page.locator('[data-close=history-dialog]').click();
    for(const k of ['2','.','5','×','4','='])await page.getByRole('button',{name:`계산기 ${k}`,exact:true}).click();assert.equal(await page.locator('#calc-output').textContent(),'10');
    await layout(1024);await layout(736);await layout(360);
    await page.reload();await page.locator('#app-password').fill('0000');await page.locator('#connect-btn').click();await wait();await page.evaluate(()=>selectOrder('a'));assert.equal(await production(),'27.48 kg');assert(await page.locator('#print-btn').isDisabled());assert.equal(await page.evaluate(()=>__portRequests),0);
    assert.deepEqual(errors,[]);assert.equal(context.pages().length,1);console.log('PASS: real layout 2, inner exclusion/no RPC, outer accounting, selected historical reprint, actual inline preview, keypad, calculator, per-job weights, completion/reload, 7E1 serial framing/stale/unstable/disconnect, save failure, no popup.');console.log('Artifacts: '+dir);
  }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
