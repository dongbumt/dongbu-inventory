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
    let saves=0,completeIds=[],fail=false,logs=[],done=false,cancelled=false,cancelMode='',cancelCalls=0,generation=1;
    const order={id:'a',title:'돈등심 작업',product:'돈등심(작업)',date:'2026-09-15',mfgdate:'2026-09-15',expdate:'2027-09-14',lot:'903112100182',origin:'미국산',inputWeight:100,weight:20};
    const completion=()=>done?[{workOrderId:'a',productionId:'qa-production-'+generation,date:'2026-09-15',jobNo:String(generation),deleted:cancelled}]:[];
    await context.route('https://**/*',async route=>{
      const name=route.request().url().split('/').pop(),body=route.request().postDataJSON();let result={};
      if(name==='dbmt_label_print_get_data')result={appData:{workOrders:[order,{...order,id:'b',product:'LA갈비(작업)',title:'LA갈비 작업',lot:'OTHER-LOT',weight:5},{...order,id:'c'},{...order,id:'d'}],labelProducts:[],labelPrintLogs:logs},completions:completion()};
      else if(name==='dbmt_label_print_save_logs'){
        if(fail){await route.fulfill({status:500,contentType:'application/json',body:'{"message":"QA save fail"}'});return;}
        saves++;logs=body.p_logs;result={ok:true,logs,completions:completion()};
      }else if(name==='dbmt_label_complete_production'){completeIds=body.p_log_ids;done=true;result={ok:true,completions:completion()};}
      else if(name==='dbmt_label_cancel_production'){
        cancelCalls++;assert.equal(body.p_work_order_id,'a');assert.equal(body.p_production_id,'qa-production-'+generation);assert.equal(body.p_pin,'0000');
        if(cancelMode==='reject'){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({message:'출고에 연결된 생산품은 삭제할 수 없습니다.'})});return;}
        if(cancelMode==='malformed')result={ok:true,completions:[]};
        else {cancelled=true;if(cancelMode==='lost'){await route.abort();return;}result={ok:true,productionId:body.p_production_id,completions:completion()};}
      }else if(name==='dbmt_label_resubmit_production'){
        assert.equal(body.p_previous_production_id,'qa-production-'+generation);assert(cancelled);generation++;cancelled=false;result={ok:true,completions:completion()};
      }
      await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
    });
    // The link test must not run the real ERP or contact its backend.
    await context.route('**/index.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>ERP link fixture</title><p>ERP</p>'}));
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
    assert.equal(await page.locator('.shell #order-list').count(),0,'Work list moved out of operator workspace');
    await page.locator('#work-order-open').click();await page.locator('#search-filter').fill('LA갈비');assert.equal(await page.evaluate(()=>state.selectedId),'a');
    await page.locator('#search-filter').fill('no-such-work');assert.equal(await page.evaluate(()=>state.selectedId),'a');
    await page.locator('[data-close=work-order-dialog]').click();assert.equal(await page.evaluate(()=>state.selectedId),'a');
    await page.locator('#reload-btn').click();await wait();assert.equal(await page.evaluate(()=>state.selectedId),'a','Reload preserves current work even when popup filter excludes it');
    await page.locator('#work-order-open').click();await page.locator('#clear-search-btn').click();await page.locator('#work-order-dialog').screenshot({path:path.join(dir,'orders.png')});
    await page.locator('#order-list [data-id=b]').click();assert(!(await page.locator('#work-order-dialog').evaluate(d=>d.open)));assert.equal(await page.evaluate(()=>state.selectedId),'b');
    await page.locator('#work-order-open').click();await page.locator('#order-list [data-id=a]').click();
    assert.equal(await page.evaluate(()=>__portRequests),0,'Never auto-probe office computer');
    // Inner packaging can deliberately use 0kg: it prints with the weight
    // omitted, and must never create production history or inventory output.
    await edit('inner','weight',0);assert(await page.evaluate(()=>DBMTLabelTouch.isWeightOmitted('inner')));assert(await page.locator('#inner-print-btn').isEnabled());
    await edit('inner','copies',3);await page.locator('#inner-preview-btn').click();const innerPreview=page.frameLocator('#label-preview-frame');await innerPreview.locator('.print-label').waitFor();assert.doesNotMatch(await innerPreview.locator('.print-label').textContent(),/0\.00|Kg/);await page.locator('#label-preview-close').click();
    await page.locator('#inner-print-btn').click();await wait();
    assert.equal(saves,0);assert.equal(logs.length,0);assert.equal(await page.evaluate(()=>__prints[0].count),3);assert.doesNotMatch(await page.evaluate(()=>__prints[0].text),/0\.00|Kg/);
    await edit('outer','weight',0);assert.match(await page.locator('#number-error').textContent(),/0 초과/);await page.locator('[data-close=number-dialog]').click();
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
    const originalUrl=page.url();
    const labelState=()=>page.evaluate(()=>({id:state.selectedId,pin:state.pin,logs:state.logs,innerWeight:DBMTLabelTouch.weight('inner'),outerWeight:DBMTLabelTouch.weight('outer'),copies:DBMTLabelTouch.copies('outer'),portRequests:__portRequests,portClosed:__portClosed,printCount:__prints.length}));
    const beforeErp=await labelState();
    const [erpPage]=await Promise.all([context.waitForEvent('page'),page.locator('.connect a[href="index.html"]').click()]);
    await erpPage.waitForLoadState();assert.equal(erpPage.url(),base+'/index.html');assert.equal(await erpPage.evaluate(()=>window.opener),null);
    assert.equal(page.url(),originalUrl,'ERP must not replace the connected label screen');assert.deepEqual(await labelState(),beforeErp,'Keep work, weights, logs and serial connection when opening ERP');
    await erpPage.close();await page.bringToFront();console.log('PASS: ERP opens separately without navigating/reloading the label page or disconnecting the scale.');
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
    await page.locator('#cancel-transfer-open').click();await page.locator('[data-close=cancel-transfer-dialog]').click();assert.equal(cancelCalls,0,'Dismissing confirmation must not delete anything');
    const original=JSON.stringify(logs);
    await page.locator('#cancel-transfer-open').click();
    await page.locator('#cancel-transfer-dialog').screenshot({path:path.join(dir,'cancel-confirm.png')});
    assert(await page.locator('#cancel-transfer-open').isVisible());
    for(const mode of ['reject','malformed','lost']){
      cancelMode=mode;await page.locator('#cancel-transfer-confirm').click();await wait();assert(await page.locator('#print-btn').isDisabled(),'Failure/ambiguous success never unlocks optimistically');assert(await page.locator('#cancel-transfer-error').textContent());
    }
    cancelMode='';await page.locator('#cancel-transfer-confirm').click();await wait();assert(await page.locator('#print-btn').isEnabled());assert.equal(JSON.stringify(logs),original);assert(!(await page.locator('#cancel-transfer-dialog').evaluate(d=>d.open)));
    await page.locator('#reprint-open').click();assert(await page.locator('#history-body [data-act=void]').first().isEnabled());await page.locator('[data-close=history-dialog]').click();
    await page.reload();await page.locator('#app-password').fill('0000');await page.locator('#connect-btn').click();await wait();assert(await page.locator('#print-btn').isEnabled(),'Cancellation survives restart');
    await edit('outer','weight',5);await page.locator('#print-btn').click();await wait();assert.equal(await production(),'32.48 kg');
    await page.locator('#complete-production-btn').click();await wait();assert.equal(generation,2);assert(await page.locator('#print-btn').isDisabled());
    // Many orders scroll inside the popup, not the operator workspace. Filters
    // and Escape keep both the selected job and its already-entered weights.
    const originalOrders=await page.evaluate(()=>state.workOrders);
    await page.evaluate(()=>{const sample=state.workOrders[0];state.workOrders.push(...Array.from({length:35},(_,i)=>({...sample,id:'extra-'+i,title:'추가 작업 '+i})));});
    for(const width of [1280,360]){
      await page.setViewportSize({width,height:1024});await page.locator('#work-order-open').click();
      assert(await page.locator('#order-list').evaluate(el=>el.scrollHeight>el.clientHeight));
      assert(await page.locator('[data-close=work-order-dialog]').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight));
      assert(!(await page.locator('#work-order-dialog').evaluate(el=>el.scrollWidth>el.clientWidth)));
      await page.locator('#search-filter').fill('OTHER-LOT');assert.equal(await page.evaluate(()=>state.selectedId),'a');
      await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>DBMTLabelTouch.weight('outer')),5);
      await page.locator('#work-order-open').click();await page.locator('#clear-search-btn').click();await page.locator('[data-close=work-order-dialog]').click();
    }
    await page.evaluate(rows=>{state.workOrders=rows;renderAll();},originalOrders);
    await page.setViewportSize({width:1280,height:1024});await page.screenshot({path:path.join(dir,'completed-1280.png'),fullPage:true});
    for(const k of ['2','.','5','×','4','='])await page.getByRole('button',{name:`계산기 ${k}`,exact:true}).click();assert.equal(await page.locator('#calc-output').textContent(),'10');
    await layout(1024);await layout(736);await layout(360);
    await page.reload();await page.locator('#app-password').fill('0000');await page.locator('#connect-btn').click();await wait();await page.evaluate(()=>selectOrder('a'));assert.equal(await production(),'32.48 kg');assert(await page.locator('#print-btn').isDisabled());assert.equal(await page.evaluate(()=>__portRequests),0);
    assert.deepEqual(errors,[]);assert.equal(context.pages().length,1);console.log('PASS: touch layout, work selection popup/filter isolation, cancel confirmation/no-op/failure/ambiguous retry/reload/resubmit, preserved labels, inner/outer accounting, reprint, actual preview, keypad, calculator, serial, no print popup.');console.log('Artifacts: '+dir);
  }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
