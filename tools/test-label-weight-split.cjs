// Real label page/module, isolated fictional RPCs, no production writes or printer jobs.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-label-weight-'));
const server=http.createServer((req,res)=>{
  const file=path.resolve(repo,new URL(req.url,'http://local').pathname.slice(1)||'label-print.html');
  if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=process.env.DBMT_WEIGHT_TEST_URL||`http://127.0.0.1:${server.address().port}/label-print.html`;
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const context=await browser.newContext({viewport:{width:1366,height:900},timezoneId:'Asia/Seoul'}),errors=[],requests=[],commits=[],saved=new Map(),packages=new Map();
    const snap={product:'돈사태(작업)',origin:'국내산',grade:'S',lot:'L12611104894001',mfgdate:'2026-11-10',expdate:'2027-11-09',packunit:'20KG',temptype:'냉동',ingredients:'돼지고기 100%',itemno:'2025029309311'};
    const encode=code=>{const [prefix,hash]=code.slice(2).split('-');return '98'+prefix+parseInt(hash,36).toString().padStart(10,'0');};
    for(const [i,code] of ['DB2611101200-ABC123','DB2611111200-ABC123'].entries())packages.set(code,{code,printCode:encode(code),labelId:'qa-parent-'+i,product:snap.product,weight:20,lot:snap.lot,mfgdate:snap.mfgdate,expdate:snap.expdate,revision:0,location:'가공장',state:'in_stock',log:{id:'qa-parent-'+i,code,labelWeight:20,workOrderSnapshot:snap,sizeKey:'7x10'}});
    let lost=false,stale=false,counter=0;
    await context.addInitScript(()=>{window.__weightPrints=[];window.print=()=>{if(window.parent!==window){window.parent.__weightPrints.push([...document.querySelectorAll('.print-label')].map(node=>({text:node.textContent,codes:[...node.querySelectorAll('[data-barcode-kind]')].map(img=>({kind:img.dataset.barcodeKind,value:img.dataset.barcodeValue}))})));setTimeout(()=>window.dispatchEvent(new Event('afterprint')),0);}};});
    await context.route('**/rest/v1/rpc/**',async route=>{
      const name=route.request().url().split('/').at(-1),body=route.request().postDataJSON();requests.push({name,body});let result;
      const fail=message=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:'P0001',message})});
      if(name==='dbmt_label_print_get_data')result={appData:{workOrders:[],labelProducts:[],labelPrintLogs:[]},completions:[]};
      else if(name==='dbmt_label_print_get_company_master')result={};
      else if(name==='dbmt_label_weight_search'){
        const rows=body.p_query?[...packages.values()].filter(p=>p.state==='in_stock'&&p.location===body.p_location&&(p.printCode.endsWith(body.p_query)||p.code===body.p_query)&&(!body.p_product||p.product.includes(body.p_product))):[];
        result={ok:true,locations:['가공장','물류창고'],rows:rows.slice(body.p_offset,body.p_offset+50),count:rows.length};
      }else if(name==='dbmt_label_weight_split'){
        commits.push(body);if(stale)return fail('다른 작업자가 처리한 라벨입니다. 다시 조회해주세요.');
        if(!saved.has(body.p_request_id)){
          const parent=packages.get(body.p_code);assert(parent&&parent.state==='in_stock');assert.equal(body.p_weights.reduce((a,b)=>a+b,0),parent.weight);
          parent.state='split';const labels=body.p_weights.map(weight=>{
            const code='DB2611131200-'+(++counter).toString(36).toUpperCase(),id='qa-child-'+counter;
            const log={...parent.log,id,code,labelWeight:weight,workOrderSnapshot:snap};packages.set(code,{...parent,code,printCode:encode(code),labelId:id,weight,revision:1,state:'in_stock',log});return log;
          });
          saved.set(body.p_request_id,{id:body.p_request_id,created_at:'2026-11-13T01:00:00Z',result:{ok:true,requestId:body.p_request_id,parentId:parent.labelId,parentCode:parent.code,weight:parent.weight,labels,transaction:{id:'qa-adjust-'+body.p_request_id,type:'재고조정',weight:0,boxCount:labels.length-1}}});
        }
        if(lost){lost=false;return route.abort();}result=saved.get(body.p_request_id).result;
      }else if(name==='dbmt_label_weight_history'){
        result={ok:true,rows:[...saved.values()].filter(row=>!body.p_request_id||row.id===body.p_request_id).map(row=>({...row,labels:row.result.labels.filter(log=>packages.get(log.code).state==='in_stock')}))};
      }else throw Error('Unexpected RPC: '+name);
      await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
    });
    const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    const login=async()=>{await page.locator('#app-password').fill('0927');await page.locator('#connect-btn').click();await page.waitForFunction(()=>!state.loading);};
    const open=async()=>{await page.locator('#label-weight-open').click();await page.locator('#lws-dialog').waitFor({state:'visible'});await page.waitForFunction(()=>!document.getElementById('lws-search-button').disabled||document.getElementById('lws-save').textContent==='같은 요청 재시도');};
    const search=async q=>{await page.locator('#lws-query').fill(q);await page.locator('#lws-query').press('Enter');await page.waitForFunction(()=>!document.getElementById('lws-search-button').disabled);};
    const choose=async()=>{await page.locator('#lws-rows [data-select]').first().click();};
    const fill=async values=>{while(await page.locator('#lws-weights input').count()<values.length)await page.locator('#lws-add').click();for(let i=0;i<values.length;i++)await page.locator('#lws-weights input').nth(i).fill(String(values[i]));};
    await page.goto(url);assert(await page.locator('#label-weight-open').isDisabled());await login();assert(await page.locator('#label-weight-open').isEnabled());await open();
    assert(await page.locator('#lws-results').isHidden());assert.equal(commits.length,0);const firstCode=[...packages.keys()][0],suffix=encode(firstCode).slice(-6);
    await search(suffix);assert.equal(await page.locator('#lws-rows [data-select]').count(),2);assert(await page.locator('#lws-editor').isHidden(),'Never auto-select a sole/ambiguous barcode');
    await page.keyboard.press('Enter');await page.locator('#lws-editor').waitFor({state:'visible'});assert.match(await page.locator('#lws-selected').textContent(),/2026-11-10.*2027-11-09/);
    await fill([5,14]);assert(await page.locator('#lws-save').isDisabled());await fill([5,15]);assert(await page.locator('#lws-save').isEnabled());
    await fill([5.001,14.999]);assert(await page.locator('#lws-save').isDisabled());await fill([5,15]);
    for(const width of [320,390,768,1366]){
      await page.setViewportSize({width,height:900});assert.equal(await page.locator('#lws-dialog').evaluate(el=>el.scrollWidth>el.clientWidth),false);
      const box=await page.locator('#lws-dialog').boundingBox();assert(box.x>=0&&box.x+box.width<=width);
      await page.locator('#lws-dialog').screenshot({path:path.join(artifacts,`split-${width}.png`)});
    }
    lost=true;await page.locator('#lws-save').click();await page.waitForFunction(()=>document.getElementById('lws-save').textContent==='같은 요청 재시도');
    assert.equal(commits.length,1);const pending=commits[0];assert(await page.locator('#lws-search-button').isDisabled());
    await page.reload();await login();await open();await page.waitForFunction(()=>document.getElementById('lws-save').textContent==='같은 요청 재시도');
    await page.locator('#lws-save').click();await page.locator('#lws-saved').waitFor({state:'visible'});assert.equal(commits.length,2);assert.equal(commits[1].p_request_id,pending.p_request_id);
    await page.locator('#lws-print').click();await page.waitForFunction(()=>__weightPrints.length===1);await page.waitForFunction(()=>!document.getElementById('lws-close').disabled);
    const prints=await page.evaluate(()=>__weightPrints);assert.equal(prints[0].length,2);
    for(const label of prints[0]){assert(label.text.includes(snap.lot));assert(label.text.includes('2026'));assert.equal(label.codes.filter(c=>c.kind==='product').length,2);assert.equal(label.codes.filter(c=>c.kind==='trace').length,1);}
    assert.equal(commits.length,2,'Printing cannot duplicate the split or production quantity');
    const second=saved.get(pending.p_request_id).result.labels[1];await search(encode(second.code));assert.equal(await page.locator('#lws-rows [data-select]').count(),1);assert(await page.locator('#lws-editor').isHidden());await choose();await fill([3,2,10]);
    await page.locator('#lws-save').click();await page.locator('#lws-saved').waitFor({state:'visible'});assert.equal(commits.length,3);assert.equal(await page.locator('#lws-saved-list li').count(),3);
    await page.locator('#lws-history-button').click();await page.locator('#lws-history').waitFor({state:'visible'});await page.locator('#lws-history details').first().locator('summary').click();
    await page.locator('#lws-history [data-print]').first().click();await page.waitForFunction(()=>__weightPrints.length===2);await page.waitForFunction(()=>!document.getElementById('lws-close').disabled);
    assert.equal((await page.evaluate(()=>__weightPrints))[1].length,1,'A superseded 15KG child must not reprint after its own split');
    const first=saved.get(pending.p_request_id).result.labels[0];await search(encode(first.code));await choose();await fill([2,3]);stale=true;
    await page.locator('#lws-save').click();await page.waitForFunction(()=>document.getElementById('lws-message').textContent.includes('다른 작업자'));
    assert(await page.locator('#lws-search-button').isEnabled(),'A definite stale rejection releases the failed request');stale=false;
    await search(encode(firstCode));assert.equal(await page.locator('#lws-rows [data-select]').count(),0,'Retired parent is absent from current stock search');
    assert.deepEqual(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('dbmt_label_weight_pending_'))),[]);
    assert.deepEqual(errors,[]);assert(requests.every(r=>r.name.startsWith('dbmt_label_weight_')||['dbmt_label_print_get_data','dbmt_label_print_get_company_master'].includes(r.name)));
    console.log('PASS: real label station, stock suffix popup/explicit selection, weights, nested split, lost response/reload/idempotency, leaf-only actual label printing, stale recovery and 320/390/768/1366px');
    await page.locator('#lws-close').click();
    const erp=await context.newPage();erp.setDefaultTimeout(15000);erp.on('pageerror',e=>errors.push(e.message));erp.on('dialog',d=>d.accept());
    const local=`http://127.0.0.1:${server.address().port}`;
    await erp.route(local+'/qa-erp',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><meta charset="utf-8"><body></body></html>'}));await erp.goto(local+'/qa-erp');
    await erp.evaluate(html=>{const t=document.createElement('template');t.innerHTML=html;const panel=t.content.querySelector('#p-label');panel.classList.add('active');document.body.append(panel);},fs.readFileSync(path.join(repo,'index.html'),'utf8'));
    for(const file of ['styles/main.css','styles/label-weight-split.css'])await erp.addStyleTag({url:local+'/'+file});
    for(const file of ['vendor/jsbarcode/JsBarcode.code128.min.js','label-layout.js','label-print-document.js'])await erp.addScriptTag({url:local+'/'+file});
    await erp.addScriptTag({content:`
      var signedIn=false,canWrite=false,session='erp-qa',userTransactions=[],EXCEL_TRANSACTIONS=[],transactions=[],coreRevision=0,localWrites=[];
      var DBMTAuth={isPersonal:()=>signedIn,can:(menu,action)=>action==='view'||canWrite,getSessionToken:()=>signedIn?session:'',auditIdentity:()=>({userId:'qa-office'})};
      function markLocalCoreChanged(){coreRevision++}function safeLocalStorageSet(key,value){localWrites.push({key,value})}
      async function sbRpc(name,body){const response=await fetch('https://hdwjwtmbsxfjrlvicgnn.supabase.co/rest/v1/rpc/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok){const error=Error(data.message);error.code=data.code;throw error;}return data;}
    `});
    await erp.addScriptTag({url:local+'/label-weight-split.js'});assert(await erp.locator('#label-weight-open').isDisabled());
    await erp.evaluate(()=>{signedIn=true;DBMTLabelWeightSplit.applyPermissions();});await erp.locator('#label-weight-open').click();await erp.waitForFunction(()=>!document.getElementById('lws-search-button').disabled);
    const remainingParent=[...packages.values()].find(p=>p.labelId==='qa-parent-1');await erp.locator('#lws-query').fill(remainingParent.printCode);await erp.locator('#lws-query').press('Enter');await erp.waitForFunction(()=>document.querySelector('#lws-rows [data-select]'));
    await erp.locator('#lws-rows [data-select]').click();await erp.locator('#lws-weights input').first().fill('10');await erp.locator('#lws-weights input').last().fill('10');assert(await erp.locator('#lws-save').isDisabled());
    const beforeOffice=commits.length;await erp.evaluate(()=>document.getElementById('lws-save').dispatchEvent(new Event('click')));assert.equal(commits.length,beforeOffice);
    await erp.evaluate(()=>{canWrite=true;DBMTLabelWeightSplit.applyPermissions();});assert(await erp.locator('#lws-save').isEnabled());await erp.locator('#lws-save').click();await erp.locator('#lws-saved').waitFor({state:'visible'});
    assert.equal(await erp.evaluate(()=>userTransactions.length),1);assert.equal(await erp.evaluate(()=>userTransactions[0].weight),0);assert.equal(await erp.evaluate(()=>coreRevision),1);
    await erp.evaluate(()=>{session='new-account';DBMTLabelWeightSplit.applyPermissions();});assert(await erp.locator('#lws-dialog').isHidden());assert.equal(await erp.locator('#lws-saved-list li').count(),0);
    assert.deepEqual(errors,[]);console.log('PASS: ERP label menu permission gating, readonly/updated role, canonical zero-KG local stock merge and account-switch cleanup');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
