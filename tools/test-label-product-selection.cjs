// Isolated live DOM/RPC/printer fixtures. No real ERP or serial access.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),vm=require('node:vm');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-product-picker-'));
const pure={window:{}};vm.runInNewContext(fs.readFileSync(path.join(repo,'label-product-selection.js'),'utf8'),pure);
const model=pure.window.DBMTLabelProducts;
assert.equal(model.compose({date:'2024-02-29'},{id:'p',name:'P',shelfdays:2}).expdate,'2024-03-01');
assert.equal(model.compose({date:'2026-12-31'},{id:'p',name:'P',shelfdays:2}).expdate,'2027-01-01');
assert.throws(()=>model.compose({date:'2026-02-30'},{id:'p'}));
const server=http.createServer((req,res)=>{const file=path.resolve(repo,new URL(req.url,'http://local').pathname.slice(1)||'label-print.html');if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:1024}}),page=await context.newPage(),errors=[];
    const order={id:'wo-a',title:'원료 돈등심 작업',date:'2026-09-15',product:'돈등심(기본)',labelProductId:'p0',weight:5,inputWeight:100,origin:'국내산',grade:'1등급',lot:'RAW-LOT',mfgdate:'2026-09-15',expdate:'2027-09-14',itemno:'ORIGINAL',ingredients:'돼지고기 100%',temptype:'냉동',sourceStock:{key:'raw',product:'돈등심',origin:'국내산',lot:'RAW-LOT',stock:100,price:5000}};
    const p1={id:'p1',name:'돈등심(돈까스 10mm)',productCode:'P001',packunit:'2KG',origin:'국내산',storage:'냉장',kind:'제품',meattype:'돼지고기',shelfdays:30,itemno:'REPORT-10',brand:'DBMT'};
    const p2={...p1,id:'p2',name:'돈등심(잡채 3mm)',productCode:'P002',packunit:'5KG',storage:'냉동',shelfdays:60,itemno:'REPORT-3'};
    let products=[{...p1,id:'p0',name:order.product},p1,p2,...Array.from({length:15},(_,i)=>({...p1,id:'extra-'+i,name:'추가 품목 '+i}))];
    let logs=[],saves=0,done=false,fail=false;
    const completions=()=>done?[{workOrderId:order.id,productionId:'prod-qa',deleted:false}]:[];
    await context.route('https://**/*',async route=>{
      const name=route.request().url().split('/').pop(),body=route.request().postDataJSON();let data={};
      if(name==='dbmt_label_print_get_data')data={appData:{workOrders:[order,{...order,id:'wo-b',lot:'OTHER-LOT'}],labelProducts:products,labelPrintLogs:logs},completions:completions()};
      if(name==='dbmt_label_print_save_logs'){
        if(fail){await route.fulfill({status:400,body:JSON.stringify({message:'품목 기준정보 변경. 새로고침해주세요.'})});return;}
        saves++;logs=body.p_logs;data={ok:true,logs,completions:completions()};
      }
      if(name==='dbmt_label_complete_production'){done=true;data={ok:true,completions:completions()};}
      await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    await context.addInitScript(()=>{window.__prints=[];window.print=()=>{if(parent!==window){parent.__prints.push([...document.querySelectorAll('.print-label')].map(e=>e.textContent));setTimeout(()=>dispatchEvent(new Event('afterprint')),0);}};});
    page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    const connect=async()=>{await page.locator('#app-password').fill('0000');await page.locator('#connect-btn').click();await page.waitForFunction(()=>!state.loading&&state.workOrders.length);};
    const wait=()=>page.waitForFunction(()=>!state.loading);
    const choose=async(q,id,apply=true)=>{await page.locator('#product-open').click();await page.locator('#product-search').fill(q);await page.locator(`[data-product="${id}"]`).click();if(apply)await page.locator('#product-apply').click();};
    const edit=async(field,n)=>{await page.locator(`#outer-${field}-btn`).click();await page.locator('#number-input').fill(String(n));await page.locator('#number-apply').click();};
    await page.goto(`http://127.0.0.1:${server.address().port}/label-print.html`);await connect();
    await page.locator('#print-btn').click();await wait();assert.equal(logs.length,1);assert.equal(await page.evaluate(()=>__prints.length),1,await page.locator('#status').textContent());const original=JSON.stringify(logs[0]);
    await edit('copies',4);await choose('P001','p1',false);
    assert.equal(await page.evaluate(()=>DBMTLabelTouch.printOrder().product),'돈등심(기본)','Pending selection is not applied');
    assert.match(await page.locator('#product-selection-detail').textContent(),/2026-10-14/);
    await page.locator('#product-dialog').screenshot({path:path.join(dir,'product-picker.png')});
    await page.locator('[data-close=product-dialog]').click();assert.equal(await page.evaluate(()=>DBMTLabelTouch.copies('outer')),4);
    await choose('P001','p1');assert.equal(await page.evaluate(()=>DBMTLabelTouch.copies('outer')),1);assert.equal(await page.evaluate(()=>DBMTLabelTouch.weight('outer')),5);
    assert.equal(await page.locator('#selected-name').textContent(),p1.name);assert.deepEqual(await page.evaluate(()=>state.workOrders[0]),order);
    await page.locator('#preview-btn').click();const label=page.frameLocator('#label-preview-frame').locator('.print-label');await label.waitFor();
    const text=await label.textContent();for(const part of [p1.name,p1.itemno,'2026.10.14','냉장','RAW-LOT','국내산'])assert(text.includes(part),part);await page.locator('#label-preview-close').click();
    const saveBefore=saves;await page.locator('#inner-print-btn').click();await wait();assert.equal(saves,saveBefore);assert.equal(logs.length,1);
    await edit('copies',2);await page.locator('#print-btn').click();await wait();assert.equal(logs.length,3);assert.equal(JSON.stringify(logs.at(-1)),original);assert.equal(logs[0].workOrderSnapshot.productSelectionVersion,1);assert.equal(logs[0].workOrderSnapshot.itemno,p1.itemno);
    await choose('P002','p2');await edit('weight',7.35);await page.locator('#print-btn').click();await wait();assert.equal(await page.locator('#metric-output').textContent(),'22.35 kg');
    await page.locator('#product-totals-open').click();assert.equal(await page.locator('.product-total-row').count(),3);assert.match(await page.locator('#product-totals-summary').textContent(),/4장.*22.35 kg/);await page.locator('#product-totals-dialog').screenshot({path:path.join(dir,'product-totals.png')});await page.locator('[data-close=product-totals-dialog]').click();
    await page.locator('#reprint-open').click();assert.match(await page.locator('#history-body').textContent(),/돈까스 10mm/);await page.locator('[data-act=reprint]').last().click();await wait();assert.equal(logs.length,4);assert.match(await page.evaluate(()=>__prints.at(-1)[0]),/돈등심\(기본\)/);await page.locator('[data-close=history-dialog]').click();
    await page.locator('#work-order-open').click();await page.locator('[data-id=wo-b]').click();assert.equal(await page.evaluate(()=>DBMTLabelTouch.printOrder().product),order.product);await page.locator('#work-order-open').click();await page.locator('[data-id=wo-a]').click();assert.equal(await page.evaluate(()=>DBMTLabelTouch.printOrder().product),p2.name);
    await page.reload();await connect();assert.equal(await page.evaluate(()=>DBMTLabelTouch.printOrder().product),p2.name,'Product choice survives refresh, unlike weight settings');
    fail=true;const printed=await page.evaluate(()=>__prints.length);await page.locator('#print-btn').click();await wait();assert.equal(logs.length,4);assert.equal(await page.evaluate(()=>__prints.length),printed);fail=false;
    products=products.filter(p=>p.id!=='p2');await page.locator('#reload-btn').click();await wait();assert(await page.locator('#print-btn').isDisabled());assert(await page.locator('#inner-print-btn').isDisabled());assert.match(await page.locator('#selected-meta').textContent(),/削除|삭제/);
    await page.locator('#reprint-open').click();await page.locator('[data-act=reprint]').first().click();await wait();assert.match(await page.evaluate(()=>__prints.at(-1)[0]),/잡채 3mm/);await page.locator('[data-close=history-dialog]').click();
    await page.locator('#product-open').click();await page.locator('#product-default').click();await page.locator('#product-apply').click();assert(await page.locator('#print-btn').isEnabled());
    await page.locator('#complete-production-btn').click();await wait();await choose('P001','p1');assert(await page.locator('#print-btn').isDisabled());assert(await page.locator('#inner-print-btn').isEnabled());
    for(const width of [1280,1024,736,360]){
      await page.setViewportSize({width,height:1024});await page.locator('#product-open').click();
      assert(!(await page.locator('#product-dialog').evaluate(el=>el.scrollWidth>el.clientWidth)));
      assert(await page.locator('#product-apply').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight));
      await page.locator('#product-next').click();assert.match(await page.locator('#product-page').textContent(),/^2/);
      await page.keyboard.press('Escape');
      const bad=await page.evaluate(()=>[...document.querySelectorAll('.shell button,.pack-fields small')].filter(e=>e.getClientRects().length).filter(e=>{const r=e.getBoundingClientRect(),p=e.closest('.panel')?.getBoundingClientRect();return r.right>innerWidth+1||r.left<0||(p&&r.bottom>p.bottom+1);}).map(e=>e.id||e.textContent));assert.deepEqual(bad,[],`layout ${width}`);
    }
    await page.setViewportSize({width:1280,height:1024});await page.screenshot({path:path.join(dir,'operating-1280.png'),fullPage:true});
    assert.deepEqual(errors,[]);assert.equal(context.pages().length,1);
    console.log('PASS: product picker pending/apply/search/pages/reset, metadata/expiry, original input and history, inner exclusion, multi-product totals, original reprint, per-work selection/reload, deleted master protection, failure, completion lock, touch layouts.');console.log('Artifacts: '+dir);
  }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
