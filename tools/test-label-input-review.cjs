// Real label-screen DOM; isolated RPC fixtures, no hardware or production writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..');
const sources=[870.01,1.54,4.43,5,7.66,20,5].map((qty,i)=>({sourceStock:{key:'source-'+i,product:'원료 '+i,lot:'LOT-'+i,price:5000,stock:qty},inputWeight:qty,...(i===0?{boxCount:48}:{})}));
const old={id:'qa-order',date:'2026-10-23',title:'QA 변경 투입',product:'목전지(작업)',labelProductId:'qa-product',inputWeight:875.98,sourceStock:sources[0].sourceStock,sourceInputs:sources.slice(0,3),lot:'LOT-0',weight:10,mfgdate:'2026-10-23'};
const current={...old,inputWeight:913.64,sourceInputs:sources};
const logs=Array.from({length:80},(_,i)=>({id:'label-'+i,workOrderId:old.id,status:'active',code:'DB-QA-'+i,labelWeight:i<37?(i<36?13:22):(i<79?10:8.06),workOrderSnapshot:structuredClone(i<37?old:current)}));
const server=http.createServer((req,res)=>{const file=path.resolve(repo,new URL(req.url,'http://local').pathname.slice(1));if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const context=await browser.newContext(),page=await context.newPage(),errors=[],dialogs=[],calls=[];
    let serverOrder=structuredClone(old),completed=false,deleted=false,accept=false,failRead=false,race=false;
    const completions=()=>completed?[{workOrderId:old.id,productionId:'qa-production',deleted}]:[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('dialog',async d=>{dialogs.push(d.message());await(accept?d.accept():d.dismiss());});
    await context.route('https://hdwjwtmbsxfjrlvicgnn.supabase.co/rest/v1/rpc/**',async route=>{
      const name=route.request().url().split('/').pop(),body=route.request().postDataJSON();let data={};
      if(name==='dbmt_label_print_get_data'){
        if(failRead){await route.fulfill({status:500,body:JSON.stringify({message:'QA 연결 실패'})});return;}
        data={appData:{workOrders:[serverOrder],labelProducts:[{id:'qa-product',name:old.product}],labelPrintLogs:logs},completions:completions()};
      }
      if(name.startsWith('dbmt_label_complete_production')||name.startsWith('dbmt_label_resubmit_production')){
        calls.push({name,body});
        if(race){await route.fulfill({status:400,body:JSON.stringify({message:'확인한 뒤 작업지시가 다시 변경되었습니다.'})});return;}
        completed=true;deleted=false;data={ok:true,productionId:'qa-production',completions:completions()};
      }
      await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    await page.goto(process.env.DBMT_LABEL_REVIEW_URL||`http://127.0.0.1:${server.address().port}/label-print.html`);
    await page.locator('#app-password').fill('0927');await page.locator('#connect-btn').click();
    await page.waitForFunction(()=>!state.loading&&state.workOrders.length);
    const click=async()=>{await page.locator('#complete-production-btn').click();await page.waitForFunction(()=>!state.loading);};
    const originals=JSON.stringify(logs);
    serverOrder=structuredClone(current);
    await click();
    assert.equal(calls.length,0,'Cancel does not post inventory');
    assert.equal(await page.evaluate(()=>state.workOrders[0].inputWeight),913.64,'Latest server input is shown without browser reload');
    assert.match(dialogs.at(-1),/875.98 kg.*37장/);assert.match(dialogs.at(-1),/913.64 kg.*43장/);
    assert.match(dialogs.at(-1),/918.06 kg.*80장 = 80박스/);
    assert.match(dialogs.at(-1),/48박스 · LOT LOT-0/);assert.match(dialogs.at(-1),/LOT LOT-6/);
    assert.match(await page.locator('#status').textContent(),/취소/);
    accept=true;race=true;await click();
    assert.equal(calls.at(-1).name,'dbmt_label_complete_production_reviewed');
    assert.deepEqual(calls.at(-1).body.p_confirmed_work_order,current);
    assert.equal(calls.at(-1).body.p_log_ids.length,80);
    assert.match(await page.locator('#status').textContent(),/다시 변경/);
    assert(await page.locator('#complete-production-btn').isEnabled());
    race=false;failRead=true;const before=calls.length;await click();assert.equal(calls.length,before);failRead=false;
    serverOrder={...current,date:'2026-10-24'};await click();assert.equal(calls.length,before);
    assert.match(await page.locator('#status').textContent(),/작업일/);
    serverOrder=structuredClone(current);await click();
    assert.match(await page.locator('#status').textContent(),/전송 완료: 80박스 · 918.06 kg/);
    assert(await page.locator('#complete-production-btn').isDisabled());
    await page.evaluate(()=>completeProduction());assert.equal(calls.length,before+1,'Already completed is not posted twice');
    assert.equal(JSON.stringify(logs),originals,'Every original barcode and print snapshot remains intact');
    deleted=true;await page.locator('#reload-btn').click();await page.waitForFunction(()=>!state.loading);await click();
    assert.equal(calls.at(-1).name,'dbmt_label_resubmit_production_reviewed');
    assert.equal(calls.at(-1).body.p_previous_production_id,'qa-production');
    assert.deepEqual(calls.at(-1).body.p_confirmed_work_order,current);
    // Object key order alone must not trigger an input correction.
    assert(await page.evaluate(row=>completionInputKey(row)===completionInputKey({...row,sourceStock:Object.fromEntries(Object.entries(row.sourceStock).reverse())}),current));
    assert.deepEqual(errors,[]);
    console.log('PASS: latest input refresh; 37+43 labels, 80 boxes/918.06KG; all sources/boxes/LOTs in confirmation; cancel; read/server race/date failures; exact confirmed version; retries; resubmit; immutable labels.');
  }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
