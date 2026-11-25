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
    const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
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
        for(const changed of body.p_logs){const index=logs.findIndex(log=>log.id===changed.id);if(index<0)logs.push(structuredClone(changed));else logs[index]=structuredClone(changed);}
        await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,logs,completions:[]})});
        return;
      }
      await route.fulfill({contentType:'application/json',body:'{}'});
    });
    const dialogs=[];let confirmMode='dismiss',promptReason='전체삭제 테스트';
    page.on('dialog',async dialog=>{
      dialogs.push({type:dialog.type(),message:dialog.message()});
      if(dialog.type()==='confirm'&&confirmMode==='dismiss')await dialog.dismiss();
      else if(dialog.type()==='prompt')await dialog.accept(promptReason);
      else await dialog.accept();
    });
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/label-print.html`);
    await page.locator('#app-password').fill('0000');await page.locator('#connect-btn').click();
    await page.waitForFunction(()=>!state.loading&&state.workOrders.length===2);
    await page.locator('#reprint-open').click();
    const desktopCount=await page.locator('#history-body .touch-history-row').count();
    assert(desktopCount>=10,'Show at least twice the original five rows on the label PC');
    assert.equal(await page.locator('#history-dialog').evaluate(element=>element.offsetWidth),1104,'Popup is 120% of the original desktop width');
    assert.equal(await page.locator('#history-page').textContent(),`1 / ${Math.ceil(14/desktopCount)}`);
    assert.match(await page.locator('#history-meta').textContent(),/정상 13장 · 삭제 1장/);
    assert(await page.locator('#history-delete-all').isEnabled());
    const deleteSelected=page.locator('#history-delete-selected');
    assert(await deleteSelected.isDisabled(),'Select at least one label before deleting');
    const seen=new Set();
    for(;;){
      const ids=await page.locator('#history-body input[data-log]').evaluateAll(elements=>elements.map(element=>element.dataset.log));
      ids.forEach(id=>seen.add(id));
      assert(await page.locator('#history-body').evaluate(element=>element.scrollHeight<=element.clientHeight+1),'No page has an inner scrollbar');
      if(await page.locator('#history-next').isDisabled())break;
      await page.locator('#history-next').click();
    }
    assert.equal(seen.size,14,'Pagination covers every label');
    while(await page.locator('#history-prev').isEnabled())await page.locator('#history-prev').click();
    const firstSelected=await page.locator('#history-body input[data-log]:enabled').first().getAttribute('data-log');
    await page.locator('#history-body input[data-log]:enabled').first().check();
    await page.locator('#history-next').click();
    assert.equal(await page.locator('#history-body .touch-history-row').count(),Math.min(desktopCount,14-desktopCount));
    const secondSelected=await page.locator('#history-body input[data-log]:enabled').first().getAttribute('data-log');
    await page.locator('#history-body input[data-log]:enabled').first().check();
    assert.match(await page.locator('#history-print').textContent(),/선택 2장/,'Selection survives pagination');
    await page.locator('#history-prev').click();
    assert(await page.locator(`#history-body input[data-log="${firstSelected}"]`).isChecked());
    await page.locator('#history-dialog').screenshot({path:path.join(artifacts,'history-desktop.png')});
    assert(await page.locator('#history-body').evaluate(element=>element.scrollHeight<=element.clientHeight+1),'Visible page needs no list scroll');
    assert(await page.locator('#history-dialog footer').evaluate(element=>element.getBoundingClientRect().bottom<=innerHeight),'Actions remain visible');

    assert(await deleteSelected.isEnabled());
    const selectedIds=[firstSelected,secondSelected].sort();
    await deleteSelected.click();
    assert.equal(attempts,0,'Cancelling selected deletion never calls the server');
    assert.match(dialogs.at(-1).message,/2장/);
    assert(await page.locator(`#history-body input[data-log="${firstSelected}"]`).isChecked());
    assert.match(await page.locator('#history-print').textContent(),/선택 2장/);

    confirmMode='accept';fail=true;promptReason='선택삭제 테스트';
    await deleteSelected.click();
    await page.waitForFunction(()=>!state.loading&&document.getElementById('status').textContent.includes('선택삭제 실패'));
    assert.equal(attempts,1);
    assert.deepEqual(lastSubmitted.map(log=>log.id).sort(),selectedIds);
    assert.deepEqual(logs,initial,'A rejected request leaves all persisted history unchanged');
    assert.equal(await page.locator('#active-count').textContent(),'13장');
    assert(await page.locator('#history-body').evaluate(element=>element.scrollHeight<=element.clientHeight+1),'The failure notice leaves the full page visible');
    assert(await page.locator(`#history-body input[data-log="${firstSelected}"]`).isChecked());
    await page.locator('#history-next').click();
    assert(await page.locator(`#history-body input[data-log="${secondSelected}"]`).isChecked());
    await page.locator('#history-prev').click();
    assert(await deleteSelected.isEnabled(),'Keep the selection ready to retry after failure');

    fail=false;
    await deleteSelected.click();
    await page.waitForFunction(()=>!state.loading&&document.getElementById('status').textContent.includes('2장 삭제 처리됨'));
    assert.equal(attempts,2);
    assert.deepEqual(lastSubmitted.map(log=>log.id).sort(),selectedIds);
    assert(lastSubmitted.every(log=>log.workOrderId==='a'&&log.status==='void'&&log.voidReason==='선택삭제 테스트'));
    assert.deepEqual(logs.filter(log=>!selectedIds.includes(log.id)),initial.filter(log=>!selectedIds.includes(log.id)));
    assert.equal(await page.locator('#active-count').textContent(),'11장');
    assert.match(await page.locator('#history-meta').textContent(),/정상 11장 · 삭제 3장/);
    assert(await deleteSelected.isDisabled());
    assert.match(await page.locator('#history-print').textContent(),/선택 0장/);

    confirmMode='dismiss';promptReason='전체삭제 테스트';
    await page.locator('#history-delete-all').click();
    assert.equal(attempts,2,'Cancel leaves history unchanged');
    assert.match(dialogs.at(-1).message,/11장을 모두 삭제/);
    assert.match(dialogs.at(-1).message,/전체 출력이력/);
    confirmMode='accept';fail=true;
    await page.locator('#history-delete-all').click();
    await page.waitForFunction(()=>!state.loading&&document.getElementById('status').textContent.includes('전체삭제 실패'));
    assert.equal(attempts,3);
    assert.equal(logs.filter(log=>log.workOrderId==='a'&&log.status==='active').length,11,'Server failure leaves persisted labels active');
    assert.equal(await page.locator('#active-count').textContent(),'11장','Client totals roll back on failure');
    assert.equal(await page.locator('#history-page').textContent(),`1 / ${Math.ceil(14/desktopCount)}`);
    assert(await page.locator('#history-delete-all').isEnabled());

    fail=false;
    await page.locator('#history-delete-all').click();
    await page.waitForFunction(()=>!state.loading&&document.getElementById('status').textContent.includes('11장 삭제 처리됨'));
    assert.equal(attempts,4,'All selected-job labels saved in one request');
    assert.equal(lastSubmitted.length,11,'Only this work order’s active labels are sent for deletion');
    assert(lastSubmitted.every(log=>log.workOrderId==='a'&&log.status==='void'));
    assert.equal(logs.filter(log=>log.workOrderId==='a'&&log.status!=='void').length,0);
    assert.equal(logs.filter(log=>log.workOrderId==='b'&&log.status==='active').length,2);
    assert.equal(logs.find(log=>log.id==='a-13').status,'void');
    assert(logs.filter(log=>log.workOrderId==='a'&&log.voidReason==='전체삭제 테스트').length===11);
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
    await page.locator('#history-body input[data-log]:enabled').first().check();
    assert(await deleteSelected.isDisabled(),'Completed production permits choosing reprints only');
    await page.setViewportSize({width:360,height:700});
    const mobileCount=await page.locator('#history-body .touch-history-row').count();
    assert(mobileCount<desktopCount,'Smaller screens show fewer labels');
    assert(await page.locator('#history-dialog footer').evaluate(element=>element.getBoundingClientRect().bottom<=innerHeight));
    assert(await page.locator('#history-dialog').evaluate(element=>element.scrollWidth<=element.clientWidth+1));
    assert(await page.locator('#history-body').evaluate(element=>element.scrollHeight<=element.clientHeight+1),'Mobile page needs no list scroll');
    await page.locator('#history-dialog').screenshot({path:path.join(artifacts,'history-mobile.png')});
    assert.deepEqual(errors,[]);
    console.log(`PASS: ${desktopCount} visible rows at 1280×900, ${mobileCount} at 360×700, cross-page selected deletion, cancel/failure/retry, all-record deletion, other-work isolation, completion lock`);
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
