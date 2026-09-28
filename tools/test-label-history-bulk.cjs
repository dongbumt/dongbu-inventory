// Isolated label-screen RPC fixture; never changes live labels or production data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-label-history-'));
const server=http.createServer((request,response)=>{
  const file=path.resolve(root,new URL(request.url,'http://local').pathname.slice(1)||'label-print.html');
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){response.writeHead(404);response.end();return;}
  response.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');
  response.end(fs.readFileSync(file));
});

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:960}}),page=await context.newPage(),errors=[];
    const order={id:'a',title:'작업 A',product:'품목 A',date:'2026-09-28',lot:'LOT-A',inputWeight:100,weight:1};
    const other={...order,id:'b',title:'작업 B',product:'품목 B',lot:'LOT-B'};
    const make=(workOrderId,index,status='active')=>({id:`${workOrderId}-${index}`,code:`LABEL-${workOrderId}-${index}`,workOrderId,status,
      product:workOrderId==='a'?'품목 A':'품목 B',labelWeight:1,printedAt:new Date(Date.UTC(2026,8,28,0,index)).toISOString(),reprintCount:0,
      workOrderSnapshot:{product:workOrderId==='a'?'품목 A':'품목 B',packunit:'1KG'}});
    const initial=[...Array.from({length:13},(_,i)=>make('a',i)),make('a',13,'void'),make('b',0),make('b',1)];
    let logs=structuredClone(initial),attempts=0,fail=false,completed=false,lastSubmitted=null;
    await context.route('https://**/*',async route=>{
      const name=route.request().url().split('/').pop(),body=route.request().postDataJSON();
      if(name==='dbmt_label_print_get_data'){
        await route.fulfill({contentType:'application/json',body:JSON.stringify({appData:{workOrders:[order,other],labelProducts:[],labelPrintLogs:logs},completions:completed?[{workOrderId:'a',productionId:'prod-a',deleted:false}]:[]})});
        return;
      }
      if(name==='dbmt_label_print_save_logs'){
        attempts++;lastSubmitted=body.p_logs;
        if(fail){await route.fulfill({status:500,contentType:'application/json',body:'{"message":"QA save failed"}'});return;}
        logs=structuredClone(body.p_logs);
        await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,logs,completions:[]})});
        return;
      }
      await route.fulfill({contentType:'application/json',body:'{}'});
    });
    const dialogs=[];let confirmMode='dismiss';
    page.on('dialog',async dialog=>{
      dialogs.push({type:dialog.type(),message:dialog.message()});
      if(dialog.type()==='confirm'&&confirmMode==='dismiss')await dialog.dismiss();
      else if(dialog.type()==='prompt')await dialog.accept('전체삭제 테스트');
      else await dialog.accept();
    });
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/label-print.html`);
    await page.locator('#app-password').fill('0000');await page.locator('#connect-btn').click();
    await page.waitForFunction(()=>!state.loading&&state.workOrders.length===2);
    await page.locator('#reprint-open').click();
    assert.equal(await page.locator('#history-body .touch-history-row').count(),10,'Ten labels per page');
    assert.equal(await page.locator('#history-page').textContent(),'1 / 2');
    assert.match(await page.locator('#history-meta').textContent(),/정상 13장 · 삭제 1장/);
    assert(await page.locator('#history-delete-all').isEnabled());
    const firstSelected=await page.locator('#history-body input[data-log]:enabled').first().getAttribute('data-log');
    await page.locator('#history-body input[data-log]:enabled').first().check();
    await page.locator('#history-next').click();
    assert.equal(await page.locator('#history-body .touch-history-row').count(),4);
    await page.locator('#history-body input[data-log]:enabled').first().check();
    assert.match(await page.locator('#history-print').textContent(),/선택 2장/,'Selection survives pagination');
    await page.locator('#history-prev').click();
    assert(await page.locator(`#history-body input[data-log="${firstSelected}"]`).isChecked());
    await page.locator('#history-dialog').screenshot({path:path.join(artifacts,'history-desktop.png')});
    assert(await page.locator('#history-body').evaluate(element=>element.scrollHeight>element.clientHeight),'Long page scrolls inside dialog');
    assert(await page.locator('#history-dialog footer').evaluate(element=>element.getBoundingClientRect().bottom<=innerHeight),'Actions remain visible');

    await page.locator('#history-delete-all').click();
    assert.equal(attempts,0,'Cancel leaves history unchanged');
    assert.match(dialogs[0].message,/13장을 모두 삭제/);
    assert.match(dialogs[0].message,/전체 출력이력/);
    confirmMode='accept';fail=true;
    await page.locator('#history-delete-all').click();
    await page.waitForFunction(()=>!state.loading&&document.getElementById('status').textContent.includes('전체삭제 실패'));
    assert.equal(attempts,1);
    assert.equal(logs.filter(log=>log.workOrderId==='a'&&log.status==='active').length,13,'Server failure leaves persisted labels active');
    assert.equal(await page.locator('#active-count').textContent(),'13장','Client totals roll back on failure');
    assert.equal(await page.locator('#history-page').textContent(),'1 / 2');
    assert(await page.locator('#history-delete-all').isEnabled());

    fail=false;
    await page.locator('#history-delete-all').click();
    await page.waitForFunction(()=>!state.loading&&document.getElementById('status').textContent.includes('13장 삭제 처리됨'));
    assert.equal(attempts,2,'All selected-job labels saved in one request');
    assert.equal(lastSubmitted.length,initial.length,'Other jobs and prior voided records are retained');
    assert.equal(logs.filter(log=>log.workOrderId==='a'&&log.status!=='void').length,0);
    assert.equal(logs.filter(log=>log.workOrderId==='b'&&log.status==='active').length,2);
    assert.equal(logs.find(log=>log.id==='a-13').status,'void');
    assert(logs.filter(log=>log.workOrderId==='a'&&log.voidReason==='전체삭제 테스트').length===13);
    assert.equal(await page.locator('#active-count').textContent(),'0장');
    assert.match(await page.locator('#history-meta').textContent(),/정상 0장 · 삭제 14장/);
    assert(await page.locator('#history-delete-all').isDisabled());
    assert.match(await page.locator('#history-print').textContent(),/선택 0장/);

    await page.locator('[data-close=history-dialog]').click();
    await page.evaluate(()=>selectOrder('b'));
    await page.locator('#reprint-open').click();
    assert.match(await page.locator('#history-title').textContent(),/품목 B · 외포장 2건/);
    assert(await page.locator('#history-delete-all').isEnabled(),'Other work remains independently editable');
    await page.locator('[data-close=history-dialog]').click();
    logs=structuredClone(initial);completed=true;
    await page.locator('#reload-btn').click();await page.waitForFunction(()=>!state.loading);
    await page.evaluate(()=>selectOrder('a'));
    await page.locator('#reprint-open').click();
    assert(await page.locator('#history-delete-all').isDisabled(),'Completed production blocks bulk deletion');
    assert(await page.locator('#history-body [data-act=void]').first().isDisabled());
    await page.setViewportSize({width:360,height:700});
    assert(await page.locator('#history-dialog footer').evaluate(element=>element.getBoundingClientRect().bottom<=innerHeight));
    assert(await page.locator('#history-dialog').evaluate(element=>element.scrollWidth<=element.clientWidth+1));
    assert(await page.locator('#history-body').evaluate(element=>element.scrollHeight>element.clientHeight));
    await page.locator('#history-dialog').screenshot({path:path.join(artifacts,'history-mobile.png')});
    assert.deepEqual(errors,[]);
    console.log('PASS: 10/page, internal scrolling, cross-page selection, cancel/failure/rollback, all-record deletion, other-work isolation, completion lock, mobile layout');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
