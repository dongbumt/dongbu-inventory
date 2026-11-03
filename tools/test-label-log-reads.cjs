// Actual label screen and mocked scoped RPCs; no printer, serial or production writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-label-log-reads-'));
const index=fs.readFileSync(path.join(root,'index.html'),'utf8');
for(const name of ['index.html','label-print.html'])for(const m of fs.readFileSync(path.join(root,name),'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(m[1]);
// Deferred app data must be retained rather than cleared or persisted as an empty history.
const apply=index.match(/function applySupabasePayload\([^]*?\n\}/)[0];
const vars={window:{},APP_DATA_REGISTRY:{labelPrintLogs:{readOnly:true,set(){throw Error('Deferred history overwritten');}},other:{set(value){vars.other=value;},get:()=>[]}},EXCEL_TRANSACTIONS:[],prices:[],localStorage:{removeItem(){}},safeLocalStorageSet(){},cleanupSupabaseLegacyCoreCache(){},cacheAppDataValue(){},invalidateStockMap(){},scheduleProductionPickerWarmup(){}};
vm.runInNewContext(apply+';applySupabasePayload({transactions:[],prod:[],appData:{},deferredAppData:["labelPrintLogs"]});',vars);
assert.deepEqual(Array.from(vars.other),[]);
const server=http.createServer((req,res)=>{
 const file=path.resolve(root,new URL(req.url,'http://local').pathname.slice(1)||'label-print.html');
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 try{
  const context=await browser.newContext({viewport:{width:1280,height:1024}}),page=await context.newPage(),errors=[],calls=[],printed=[],dialogs=[];
  const order={id:'a',date:'2026-11-04',title:'작업 A',product:'가상 제품',lot:'LOT-A',origin:'미국산',mfgdate:'2026-11-04',inputWeight:100,weight:5,sourceStock:{key:'qa-raw',product:'가상 원료',lot:'LOT-A',price:5000}};
  const orders=[order,{...order,id:'b',title:'과거 작업 B',lot:'LOT-B'},{...order,id:'c',title:'새 작업 C',lot:'LOT-C'}];
  const makeLog=(row,id,weight,status='active')=>({id,code:'DB2611041200-'+id.toUpperCase(),workOrderId:row.id,status,printedAt:'2026-11-04T03:00:00Z',product:row.product,lot:row.lot,labelWeight:weight,reprintCount:0,workOrderSnapshot:structuredClone({...row,weight,brand:'출력 당시 브랜드',ingredients:'출력 당시 원료'})});
  let logs=[makeLog(order,'a1',5),makeLog(order,'a2',7.35),makeLog(order,'a3',9,'void'),...Array.from({length:1500},(_,i)=>makeLog(orders[1],'b'+i,2))];
  const historicalOther=structuredClone(logs.filter(row=>row.workOrderId==='b'));
  const originalA=structuredClone(logs[0]);
  const summary=()=>orders.map(row=>{const all=logs.filter(l=>l.workOrderId===row.id),active=all.filter(l=>l.status!=='void');return {workOrderId:row.id,count:active.length,weight:active.reduce((s,l)=>s+l.labelWeight,0),totalCount:all.length};});
  let hold='a',release,fail='',wrongScope='',complete=false,confirmInputs;
  const completions=()=>complete?[{workOrderId:'a',productionId:'qa-production',deleted:false}]:[];
  await context.route('https://**/*',async route=>{
   const name=new URL(route.request().url()).pathname.split('/').pop(),body=route.request().postDataJSON();
   if(!body)return route.abort();
   calls.push({name,body});let result={};
   if(name==='dbmt_label_print_get_data'){
    assert(Object.hasOwn(body,'p_work_order_id'),'No full-history requests');
    const id=body.p_work_order_id;
    if(id&&hold===id)await new Promise(resolve=>release=resolve);
    if(id&&fail===id)return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({message:'QA 이력 조회 실패'})});
    const scope=id&&wrongScope===id?'b':id;
    result={appData:{workOrders:orders,labelProducts:[],labelPrintLogs:id?logs.filter(l=>l.workOrderId===scope):[]},logScope:{workOrderId:scope},logSummaries:summary(),completions:completions()};
   }else if(name==='dbmt_label_print_save_logs'){
    assert.equal(body.p_work_order_id,'a');assert(body.p_logs.every(l=>l.workOrderId==='a'));
    for(const row of body.p_logs){const i=logs.findIndex(l=>l.id===row.id);if(i<0)logs.push(row);else logs[i]=row;}
    result={ok:true,logs:logs.filter(l=>l.workOrderId==='a'),logScope:{workOrderId:'a'},logSummaries:summary(),completions:completions()};
   }else if(name.startsWith('dbmt_label_complete_production')){
    assert.equal(body.p_work_order_id,'a');assert.deepEqual(body.p_log_ids.slice().sort(),logs.filter(l=>l.workOrderId==='a'&&l.status!=='void').map(l=>l.id).sort());
    confirmInputs=body.p_confirmed_work_order;complete=true;result={ok:true,completions:completions()};
   }else if(name==='dbmt_label_inner_prints')result={ok:true,logs:[],totals:[]};
   else if(name!=='dbmt_label_print_get_company_master')throw Error('Unexpected RPC: '+name);
   await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
  });
  await context.addInitScript(()=>{
   window.__printed=[];
   window.print=()=>{if(parent!==window){parent.__printed.push(document.getElementById('label-print-pages').textContent);setTimeout(()=>dispatchEvent(new Event('afterprint')),0);}};
  });
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{dialogs.push(d.message());await d.accept();});
  await page.goto(`http://127.0.0.1:${server.address().port}/label-print.html?workOrderId=a`);
  await page.locator('#app-password').fill('0927');await page.locator('#connect-btn').click();
  await page.waitForFunction(()=>state.loading&&state.scopedLogs&&state.selectedId==='a');
  assert(await page.locator('#print-btn').isDisabled());assert(await page.locator('#complete-production-btn').isDisabled());
  assert.equal(await page.evaluate(()=>state.logs.length),0,'Bootstrap contains no full history');
  hold='';release();
  const wait=()=>page.waitForFunction(()=>!state.loading);
  await wait();assert.equal(await page.locator('#metric-output').textContent(),'12.35 kg');
  assert.equal(await page.evaluate(()=>state.logs.length),3,'Only selected work snapshots enter memory');
  assert(calls.filter(c=>c.name==='dbmt_label_print_get_data').every(c=>c.body.p_work_order_id===null||c.body.p_work_order_id==='a'));
  await page.locator('#work-order-open').click();
  assert.match(await page.locator('#order-list [data-id=b]').textContent(),/3,000 kg/,'Other job totals remain correct without its snapshots');
  await page.locator('[data-close=work-order-dialog]').click();
  // Failed or mismatched scope cannot make an unknown work look like empty production.
  fail='b';await page.evaluate(()=>selectOrder('b'));await wait();
  assert.match(await page.locator('#status').textContent(),/조회 실패/);assert(await page.locator('#print-btn').isDisabled());
  assert(await page.locator('#inner-print-btn').isDisabled());assert(await page.locator('#complete-production-btn').isDisabled());
  const writes=calls.filter(c=>c.name==='dbmt_label_print_save_logs').length;
  await page.evaluate(()=>printSelectedLabels());assert.equal(calls.filter(c=>c.name==='dbmt_label_print_save_logs').length,writes);
  fail='';await page.evaluate(()=>selectOrder('c'));await wait();
  assert.equal(await page.evaluate(()=>state.logs.length),0);assert(await page.locator('#print-btn').isEnabled());assert(await page.locator('#complete-production-btn').isDisabled());
  wrongScope='a';await page.evaluate(()=>selectOrder('a'));await wait();
  assert.match(await page.locator('#status').textContent(),/확인하지 못했습니다/);assert(await page.locator('#print-btn').isDisabled());
  wrongScope='';await page.evaluate(()=>selectOrder('a'));await wait();
  // Reprint uses historical content; scoped save does not pull or mutate 1,500 other labels.
  await page.evaluate(()=>reprintLog('a1'));await wait();
  assert.equal(logs.find(l=>l.id==='a1').reprintCount,1);
  assert.deepEqual(logs[0].workOrderSnapshot,originalA.workOrderSnapshot);assert.equal(logs[0].code,originalA.code);
  assert.equal(await page.evaluate(()=>state.logs.length),3);
  assert.match((await page.evaluate(()=>__printed)).join(' '),/5\.00/);
  await page.evaluate(()=>voidLog('a2'));await wait();assert.equal(await page.locator('#metric-output').textContent(),'5 kg');
  assert.deepEqual(logs.filter(l=>l.workOrderId==='b'),historicalOther);
  await page.screenshot({path:path.join(artifacts,'selected-work-only.png')});
  // Recheck the latest input using a scoped read before completing; old barcode stays intact.
  order.inputWeight=110;order.sourceStock={...order.sourceStock,stock:110};
  await page.evaluate(()=>completeProduction());await wait();
  assert.equal(confirmInputs.inputWeight,110);assert(complete);assert.equal(await page.evaluate(()=>state.logs.length),3);
  assert.match(dialogs.at(-1),/투입내역이 변경/);
  assert.deepEqual(logs[0].workOrderSnapshot,originalA.workOrderSnapshot);
  assert.deepEqual(logs.filter(l=>l.workOrderId==='b'),historicalOther);
  assert.deepEqual(errors,[]);
  console.log('PASS: lightweight bootstrap, selected-work reads, other-work summaries, deferred-state preservation, failed/mismatched read guards, empty work, historical reprint/barcode, scoped save/void isolation and fresh-input completion.');
  console.log('Artifacts: '+artifacts);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
