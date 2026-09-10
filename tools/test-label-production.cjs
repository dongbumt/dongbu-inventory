/* Real DOM + isolated RPC fixtures. No production data, real logins, or printer jobs. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),index=fs.readFileSync(path.join(repo,'index.html'),'utf8');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-label-completion-'));
const block=(start,end)=>{const at=index.indexOf(start);assert(at>=0,start);const stop=index.indexOf(end,at);assert(stop>at,end);return index.slice(at,stop);};
const order={id:'qa-wo',date:'2026-09-10',title:'QA 생산완료',product:'냉장돈등심',labelProductId:'qa-product',inputWeight:100,weight:0,lot:'OUT-LOT',origin:'국내산',mfgdate:'2026-09-10',sourceStock:{key:'qa-stock',product:'돈등심 원료',lot:'RAW-LOT',origin:'국내산',price:5000,stock:100,stockLocation:'가공장'}};
const logs=[{id:'a',labelWeight:5,status:'active'},{id:'b',labelWeight:7.35,status:'active'},{id:'c',labelWeight:10,status:'void'}].map(row=>({...row,workOrderId:order.id,product:order.product,workOrderSnapshot:{...order,weight:row.labelWeight},reprintCount:0}));
const entry={id:'prod_label_qa',date:'2026/09/10',job_no:'1',job_type:'생산',key:['2026/09/10','1'],note:'QA 생산완료',_isUser:true,
  _labelCompletion:{workOrderId:order.id,lockedInputCount:1,completedAt:'2026-09-10T01:00:00Z'},
  inputs:[{product:'돈등심 원료',lot:'RAW-LOT',qty:100,price:5000,amount:500000,origin:'국내산',stockLocation:'가공장',sourceStockKey:'qa-stock'}],
  outputs:[{product:'냉장돈등심',productId:'qa-product',labelProductId:'qa-product',lot:'OUT-LOT',qty:12.35,price:40486,amount:500003,origin:'국내산',proddate:'2026-09-10'}]};
const server=http.createServer((req,res)=>{const file=path.resolve(repo,new URL(req.url,'http://localhost').pathname.slice(1)||'label-print.html');if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'text/css');res.end(fs.readFileSync(file));});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const context=await browser.newContext({viewport:{width:1366,height:1000}});let calls=[],fail=true,completed=false,serverLogs=structuredClone(logs);
    const status=()=>completed?[{workOrderId:order.id,productionId:entry.id,date:entry.date,jobNo:'1',completedAt:'2026-09-10T01:00:00Z'}]:[];
    await context.addInitScript(()=>window.print=()=>{});
    await context.route('https://**/*',async route=>{
      const fn=route.request().url().split('/').pop(),body=route.request().postDataJSON();
      let result={};
      if(fn==='dbmt_label_print_get_data') result={appData:{workOrders:[order],labelProducts:[{id:'qa-product',name:order.product,packunit:'5KG'}],labelPrintLogs:serverLogs},completions:status()};
      else if(fn==='dbmt_label_complete_production'){
        calls.push(body);assert.deepEqual(body.p_log_ids.sort(),['a','b']);
        if(fail){await route.fulfill({status:500,contentType:'application/json',body:'{"message":"QA 통신 오류"}'});return;}
        completed=true;result={ok:true,productionId:entry.id,completions:status()};
      }else if(fn==='dbmt_label_print_save_logs'){serverLogs=body.p_logs;result={ok:true,logs:serverLogs,completions:status()};}
      await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
    });
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
    await page.goto(url+'/label-print.html');assert(await page.locator('#complete-production-btn').isDisabled());
    await page.locator('#app-password').fill('0927');await page.locator('#connect-btn').click();await page.waitForFunction(()=>!state.loading);
    assert.equal(await page.locator('#metric-output').textContent(),'12.35 kg');
    await page.locator('#complete-production-btn').click();await page.waitForFunction(()=>!state.loading);
    assert.match(await page.locator('#status').textContent(),/QA 통신 오류/);assert(await page.locator('#complete-production-btn').isEnabled());
    fail=false;await page.locator('#complete-production-btn').click();await page.waitForFunction(()=>!state.loading);
    assert(await page.locator('#complete-production-btn').isDisabled());assert(await page.locator('#print-btn').isDisabled());
    assert.equal(await page.locator('#history-body button[data-act="void"]:enabled').count(),0);
    assert.match(await page.locator('#completion-status').textContent(),/2026\/09\/10 #1/);
    await page.evaluate(()=>completeProduction());assert.equal(calls.length,2);
    await page.screenshot({path:path.join(artifacts,'label-completed.png'),fullPage:true});
    const popupPromise=page.waitForEvent('popup');await page.locator('#history-body button[data-act="reprint"]').first().click();const popup=await popupPromise;await popup.waitForSelector('.print-label');await popup.close();await page.waitForFunction(()=>!state.loading);
    assert.equal(await page.locator('#metric-output').textContent(),'12.35 kg');
    await page.reload();await page.locator('#app-password').fill('0927');await page.locator('#connect-btn').click();await page.waitForFunction(()=>!state.loading);assert(await page.locator('#complete-production-btn').isDisabled());assert.deepEqual(errors,[]);
    console.log('PASS: completion UI, failure/retry, void exclusion, duplicate guard, completed lock, reprint, browser restart');

    const erp=await browser.newPage({viewport:{width:1550,height:1200}});await erp.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<main></main>'}));await erp.goto(url+'/fixture');
    await erp.evaluate(html=>{const t=document.createElement('template');t.innerHTML=html;document.body.append(t.content.querySelector('#p-production'));document.getElementById('p-production').classList.add('active');},index);
    await erp.addStyleTag({content:fs.readFileSync(path.join(repo,'styles/main.css'),'utf8')});
    await erp.addScriptTag({content:`
      const SUPABASE_ENABLED_KEY='qa-enabled',STOCK_LOCATION_DEFAULT='가공장',EXCEL_TRANSACTIONS=[],today='2026-09-10';
      localStorage.setItem(SUPABASE_ENABLED_KEY,'1');let userProdEntries=[${JSON.stringify(entry)}],userTransactions=[],transactions=[];
      window.messages=[];window.requests=[];window.modalIds=[];window.failSave=false;
      window.confirm=()=>true;window.alert=s=>messages.push(s);const toast=s=>messages.push(s);
      const showPage=()=>initProdForm(),autoSetJobNo=()=>{},getProdEntryNote=e=>e.note,getProdJobType=e=>e.job_type;
      const getProdInputStockLabel=e=>e.product,normalizeSamsungMeta=()=>null,samsungMetaOptionKey=()=>'';
      const refreshProdInputSamsungOptions=()=>{},refreshProdOutSamsungProducts=()=>{},getCommonProdInputOrigin=()=>'';
      const updateProdOutputOriginField=(el,value)=>el.value=value,samsungVendorOptionsHtml=()=>'<option value="">선택 안 함</option>';
      const getProdInputSamsungMeta=()=>null,normalizeStockLocation=v=>v||'가공장',parseAppNumber=v=>Number(v)||0;
      const personalServerWriteToken=()=> 'fixture-token',normalizeRowsForUpsert=v=>v;
      const assertPersonalServerResult=r=>{if(!r.ok)throw Error('permission denied');};
      let localCoreRevision=0;const markLocalCoreChanged=()=>localCoreRevision++,normalizeLocalTransactionIds=()=>{},recordProductionChange=()=>{},safeLocalStorageSet=()=>{},gsShowSync=()=>{};
      const getSupabasePassword=()=> 'fixture-token';window.remoteProduction=null;
      const refreshProtectedCoreAfterFailure=async()=>{},syncSubMaterialUsageProductionMetadata=()=>{},renderProduction=()=>{};
      const openSubMaterialUsageModal=id=>modalIds.push(id);
      const sbRpc=async(fn,body)=>{
        if(fn==='dbmt_erp_get_label_productions') return remoteProduction;
        requests.push({fn,body});if(failSave)throw Error('QA 저장 실패');
        const entry=JSON.parse(JSON.stringify(body.p_entry));const cost=entry.inputs.reduce((sum,row)=>sum+row.qty*row.price,0);
        entry.outputs.forEach(row=>{row.price=Math.ceil(cost/12.35);row.amount=Math.ceil(row.price*row.qty);});
        return {ok:true,entry,transactionRows:entry.inputs.map((row,i)=>({...row,id:'tx-'+i,_prodId:entry.id,weight:row.qty}))};
      };
      ${block('let prodInputRowCount = 0;','function getStockOptions(){')}
      ${block('function addProdInputRow(){','function selectProdInputStock(')}
      ${block('function addProdOutputRow(){','function labelProductPackUnitText(')}
      ${block('async function supabaseSaveProductionRows(','async function supabaseLoadSubMaterialUsages(')}
      ${block('async function saveProdEntry(){','async function deleteProdEntry(')}
      ${block('let _editProdId=null;','// ─── 생산일보 ─')}
      openEditProdEntry('prod_label_qa');
    `});
    assert(await erp.locator('#prod-label-notice').isVisible());assert(await erp.locator('#prod-date').isDisabled());assert(await erp.locator('#prod-out-qty-1').isDisabled());assert(await erp.locator('#prod-in-qty-1').isDisabled());assert(await erp.locator('#prod-output-add-btn').isDisabled());
    await erp.locator('button[onclick="addProdInputRow()"]').click();assert(await erp.locator('#prod-in-qty-2').isEnabled());
    for(const [field,value] of [['product','추가 돈등심'],['lot','ADD-LOT'],['qty','10'],['price','6000']]) await erp.locator('#prod-in-'+field+'-2').fill(value);
    await erp.screenshot({path:path.join(artifacts,'erp-additional-input.png'),fullPage:true});
    await erp.evaluate(()=>failSave=true);await erp.locator('button[onclick="saveProdEntry()"]').click();assert.equal(await erp.locator('#prod-in-qty-2').inputValue(),'10');assert(await erp.locator('#prod-out-qty-1').isDisabled());
    await erp.evaluate(()=>failSave=false);await erp.locator('button[onclick="saveProdEntry()"]').click();
    const saved=await erp.evaluate(()=>({entry:userProdEntries[0],requests,modalIds}));
    assert.deepEqual(saved.entry.inputs[0],entry.inputs[0]);assert.equal(saved.entry.inputs[1].qty,10);assert.equal(saved.entry.outputs[0].qty,12.35);assert.equal(saved.entry.outputs[0].price,45345);assert.deepEqual(saved.modalIds,[entry.id]);
    assert.deepEqual(saved.requests[1].body.p_transaction_rows,[]);assert(await erp.locator('#prod-date').isEnabled());assert(await erp.locator('#prod-output-add-btn').isEnabled());assert(await erp.locator('#prod-label-notice').isHidden());
    assert.equal(await erp.evaluate(()=>_editProdId),null);
    await erp.evaluate(()=>openEditProdEntry('prod_label_qa'));assert.equal(await erp.locator('#prod-in-qty-2').inputValue(),'10');assert(await erp.locator('#prod-in-qty-2').isEnabled());
    await erp.locator('#prod-in-2 button.btn-danger').click();await erp.locator('button[onclick="saveProdEntry()"]').click();assert.equal(await erp.evaluate(()=>userProdEntries[0].inputs.length),1);
    await erp.evaluate(async()=>{
      const normal={id:'normal',inputs:[],outputs:[]};userProdEntries.push(normal);userTransactions.push({id:'normal-tx',_prodId:'normal'});
      remoteProduction={ok:true,productionIds:['prod_label_qa','prod_label_remote'],entries:[{...userProdEntries[0],id:'prod_label_remote'}],transactions:[{id:'remote-tx',_prodId:'prod_label_remote',weight:12.35}]};
      await refreshLabelProductions();
    });
    assert.deepEqual(await erp.evaluate(()=>userProdEntries.map(e=>e.id)),['normal','prod_label_remote']);
    assert.deepEqual(await erp.evaluate(()=>userTransactions.map(e=>e.id)),['normal-tx','remote-tx']);
    await erp.evaluate(async()=>{productionWritePending=1;remoteProduction={ok:true,productionIds:['normal'],entries:[],transactions:[]};await refreshLabelProductions();productionWritePending=0;});
    assert.equal(await erp.evaluate(()=>userProdEntries.length),2,'Refresh must not race a pending production save');
    console.log('PASS: ERP imported locks, editable extra inputs, server-authoritative transactions/cost, failure retention, re-edit, extra removal, reset to normal form');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
