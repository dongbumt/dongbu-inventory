/* Actual split module/stylesheet; fictional production and mocked authenticated RPCs only. */
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'label-stock-split.js'),'utf8');
new vm.Script(source);
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
assert.match(html,/label-stock-split\.js\?v=/,'The production screen must load the split module');
assert.ok(/DBMTLabelStockSplit\.buttonHtml\(e,\s*out\)/.test(html),'Each saved label-produced output needs its own split button');
const fixture={ok:true,productionId:'fixture-production',stockRowId:'fixture-stock',version:'version1',canSplit:true,reason:'',
  product:'가상 목전지(작업)',row:{product:'가상 목전지(작업)',stockRowId:'fixture-stock',origin:'미국산',lot:'QA-LOT',qty:100,boxCount:5,price:5000,amount:500000},
  labels:Array.from({length:5},(_,i)=>({id:'label'+i,code:'DB2610171200-ABC12'+i,weight:20,printedAt:'2026-10-17T03:0'+(i<2?'0':'1')+':00Z',batchId:i<2?'batchA':'batchB'})),totalWeight:100,boxCount:5};
const entry={id:'fixture-production',date:'2026/10/17',job_no:'1',note:'원본 메모',_labelCompletion:{workOrderId:'fixture-work-order'},
  inputs:[{product:'가상 목전지 원료',qty:100,price:5000}],outputs:[fixture.row]};
const setup=`
var fixtureData=${JSON.stringify(fixture)},serverEntry=${JSON.stringify(entry)},serverRows=[],userProdEntries=[${JSON.stringify(entry)}],userTransactions=[{id:'original-posting',_prodId:'fixture-production',weight:100,stockRowId:'fixture-stock'}];
var EXCEL_TRANSACTIONS=[{id:'legacy-untouched',weight:1}],transactions=[...EXCEL_TRANSACTIONS,...userTransactions];
var productionWritePending=0,_editProdId=null,localCoreRevision=0,rendered=0,renderedTransactions=0,renderedStock=0,messages=[],writes=[];
var sessionToken='fixture-token',permission=true,loadPlan=[],savePlan=[],reloadPlan=[],pending=[],rpcCalls=[],requestResults={};
var DBMTAuth={isPersonal:()=>Boolean(sessionToken),can:()=>permission,getSessionToken:()=>sessionToken};
function markLocalCoreChanged(){localCoreRevision++}
function safeLocalStorageSet(key,value){writes.push({key,value});return true}
function renderProduction(){rendered++}
function renderTransactions(){renderedTransactions++}
function renderStock(){renderedStock++}
function toast(message){messages.push(message)}
function splitResult(body){
  if(requestResults[body.p_request_id])return {...structuredClone(requestResults[body.p_request_id]),alreadySaved:true};
  const selected=fixtureData.labels.filter(row=>body.p_label_ids.includes(row.id)),rest=fixtureData.labels.filter(row=>!body.p_label_ids.includes(row.id));
  const first={...fixtureData.row,qty:selected.reduce((n,r)=>n+r.weight,0),boxCount:selected.length,stockRowId:'new-stock'};
  first.amount=first.qty*first.price;
  const remaining={...fixtureData.row,qty:rest.reduce((n,r)=>n+r.weight,0),boxCount:rest.length};remaining.amount=remaining.qty*remaining.price;
  serverEntry={...serverEntry,outputs:[remaining,first]};
  serverRows=serverEntry.outputs.map((row,i)=>({...row,id:'posting-'+i,type:'생산입고',weight:row.qty,_prodId:serverEntry.id}));
  const result={ok:true,productionId:serverEntry.id,remainingStockRowId:remaining.stockRowId,splitStockRowId:first.stockRowId,entry:serverEntry,transactionRows:serverRows};
  requestResults[body.p_request_id]=structuredClone(result);return structuredClone(result);
}
async function sbRpc(name,body){
  rpcCalls.push({name,body:structuredClone(body)});
  const plans=name==='dbmt_erp_get_label_split'?loadPlan:name==='dbmt_erp_split_label_stock'?savePlan:reloadPlan;
  const plan=plans.shift();
  if(plan?.defer)return new Promise((resolve,reject)=>pending.push({name,body,resolve,reject}));
  if(plan?.error){if(plan.afterCommit)splitResult(body);const error=new Error(plan.error);if(plan.code)error.code=plan.code;if(plan.status)error.status=plan.status;throw error;}
  if(plan?.result)return structuredClone(plan.result);
  if(name==='dbmt_erp_get_label_split')return structuredClone({...fixtureData,productionId:body.p_production_id,stockRowId:body.p_stock_row_id});
  if(name==='dbmt_erp_split_label_stock')return splitResult(body);
  if(name==='dbmt_erp_get_label_productions')return {ok:true,productionIds:[serverEntry.id],entries:[structuredClone(serverEntry)],transactions:structuredClone(serverRows)};
  throw Error('Unexpected RPC '+name);
}
`;
(async()=>{
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="ko"><meta charset="utf-8"><body><main><h1>생산일보</h1><div id="saved-production"></div></main><section id="p-stock" class="active"></section></body></html>')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const artifacts=path.join(root,'outputs','playwright','label-stock-split-qa');fs.mkdirSync(artifacts,{recursive:true});
  const errors=[];
  try{
    const page=await browser.newPage({viewport:{width:1453,height:981}});page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://**/*',route=>route.abort());
    async function reset(){
      await page.goto(origin);
      await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
      await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/label-stock-split.css'),'utf8')});
      await page.addScriptTag({content:setup});await page.addScriptTag({content:source});
      await page.evaluate(()=>document.getElementById('saved-production').innerHTML=DBMTLabelStockSplit.buttonHtml(userProdEntries[0],userProdEntries[0].outputs[0]));
    }
    const label=i=>page.locator('input[data-label-id="label'+i+'"]');
    async function open(){await page.locator('.label-split-open').click();await page.waitForFunction(()=>document.querySelectorAll('#label-split-labels input').length===5)}
    const splitCalls=()=>page.evaluate(()=>rpcCalls.filter(call=>call.name==='dbmt_erp_split_label_stock'));

    await reset();await open();
    assert.equal(await page.locator('#label-split-save').isDisabled(),true);
    assert.equal(await page.locator('#label-split-remaining-weight').innerText(),'100.00 KG');
    assert.equal(await page.locator('#label-split-remaining-boxes').innerText(),'5 박스');
    await label(0).check();await label(1).check();
    assert.equal(await page.locator('#label-split-selected-weight').innerText(),'40.00 KG');
    assert.equal(await page.locator('#label-split-selected-boxes').innerText(),'2 박스');
    assert.equal(await page.locator('#label-split-remaining-weight').innerText(),'60.00 KG');
    assert.equal(await page.locator('#label-split-remaining-boxes').innerText(),'3 박스');
    assert.equal(await page.locator('#label-split-save').isDisabled(),false);
    await page.screenshot({path:path.join(artifacts,'desktop.png'),fullPage:true});
    await page.locator('button[data-batch-id="batchA"]').click();assert.equal(await page.locator('#label-split-selected-boxes').innerText(),'0 박스');
    await page.locator('button[data-batch-id="batchA"]').click();assert.equal(await page.locator('#label-split-selected-boxes').innerText(),'2 박스');
    await page.locator('#label-split-select-all').check();assert.equal(await page.locator('#label-split-save').isDisabled(),true);
    assert.match(await page.locator('#label-split-hint').innerText(),/전체 라벨/);
    await page.locator('#label-split-select-all').uncheck();await page.locator('button[data-batch-id="batchA"]').click();
    await page.locator('#label-split-save').click();await page.waitForFunction(()=>!document.getElementById('label-split-dialog').open);
    const saved=await page.evaluate(()=>({entry:userProdEntries[0],transactions,productionWritePending,rendered,renderedTransactions,renderedStock,writes}));
    assert.deepEqual(saved.entry.outputs.map(row=>[row.qty,row.boxCount]),[[60,3],[40,2]]);
    assert.equal(saved.entry.inputs[0].qty,100);assert.equal(saved.transactions.filter(row=>row._prodId==='fixture-production').length,2);
    assert.ok(saved.transactions.some(row=>row.id==='legacy-untouched'));assert.ok(!saved.transactions.some(row=>row.id==='original-posting'));
    assert.equal(saved.productionWritePending,0);assert.ok(saved.rendered&&saved.renderedTransactions&&saved.renderedStock);
    assert.equal((await splitCalls()).length,1);

    // Unknown result: freeze selection; reopen and retry the exact UUID/selection safely.
    await reset();await open();await page.locator('button[data-batch-id="batchA"]').click();
    await page.evaluate(()=>savePlan.push({error:'QA network disconnected',afterCommit:true}));
    await page.locator('#label-split-save').click();await page.waitForFunction(()=>document.getElementById('label-split-save').textContent.includes('다시 시도'));
    assert.equal(await label(0).isDisabled(),true);assert.equal(await page.locator('#label-split-refresh').isDisabled(),true);
    await page.locator('#label-split-close').click();await page.locator('.label-split-open').click();
    assert.equal(await page.locator('#label-split-selected-weight').innerText(),'40.00 KG');
    assert.equal(await page.evaluate(()=>rpcCalls.filter(call=>call.name==='dbmt_erp_get_label_split').length),1,'Reopen preserves unresolved request instead of loading new selection');
    await page.locator('#label-split-save').click();await page.waitForFunction(()=>!document.getElementById('label-split-dialog').open);
    const retried=await splitCalls();assert.equal(retried.length,2);assert.deepEqual(retried[0].body,retried[1].body);
    assert.equal(await page.evaluate(()=>userProdEntries[0].outputs.length),2);

    // Unknown-result receipt after office cancellation removes the old generation.
    await reset();await open();await label(0).check();
    await page.evaluate(()=>savePlan.push({error:'QA response lost',afterCommit:true}));await page.locator('#label-split-save').click();
    await page.waitForFunction(()=>document.getElementById('label-split-save').textContent.includes('다시 시도'));
    await page.evaluate(()=>{savePlan.push({result:{ok:true,alreadySaved:true,cancelled:true,productionId:'fixture-production',entry:null,transactionRows:[]}});reloadPlan.push({result:{ok:true,productionIds:['fixture-production'],entries:[],transactions:[]}})});
    await page.locator('#label-split-save').click();await page.waitForFunction(()=>!document.getElementById('label-split-dialog').open);
    assert.equal(await page.evaluate(()=>userProdEntries.length),0);assert.equal(await page.evaluate(()=>userTransactions.length),0);
    assert.equal(await page.evaluate(()=>transactions.length),1,'Unrelated legacy transactions remain');
    assert.match(await page.evaluate(()=>messages.at(-1)),/취소/);assert.equal((await splitCalls()).length,2);

    // A malformed response cannot prove rejection: retain the request ID for safe replay.
    await reset();await open();await label(0).check();
    await page.evaluate(()=>savePlan.push({result:{unexpected:true}}));await page.locator('#label-split-save').click();
    await page.waitForFunction(()=>document.getElementById('label-split-save').textContent.includes('다시 시도'));
    assert.equal(await label(0).isDisabled(),true);await page.locator('#label-split-save').click();
    await page.waitForFunction(()=>!document.getElementById('label-split-dialog').open);
    const malformedRetry=await splitCalls();assert.equal(malformedRetry.length,2);assert.deepEqual(malformedRetry[0].body,malformedRetry[1].body);

    // A definitive stale error unlocks reload, preserves extant selected IDs and sends a new version/UUID.
    await reset();await open();await label(0).check();await label(1).check();
    await page.evaluate(()=>{savePlan.push({error:'생산일보 또는 라벨 정보가 변경되었습니다. 다시 조회해주세요.',code:'P0001',status:400});fixtureData.version='version2'});
    await page.locator('#label-split-save').click();await page.waitForFunction(()=>document.getElementById('label-split-message').textContent.includes('변경'));
    assert.equal(await page.locator('#label-split-save').isDisabled(),true);assert.equal(await page.locator('#label-split-refresh').isDisabled(),false);
    await page.locator('#label-split-refresh').click();await page.waitForFunction(()=>!document.getElementById('label-split-save').disabled);
    assert.equal(await page.locator('#label-split-selected-boxes').innerText(),'2 박스');
    await page.locator('#label-split-save').click();await page.waitForFunction(()=>!document.getElementById('label-split-dialog').open);
    const stale=await splitCalls();assert.equal(stale.length,2);assert.equal(stale[1].body.p_version,'version2');assert.notEqual(stale[0].body.p_request_id,stale[1].body.p_request_id);

    // Saved result with a failed refresh is never sent for splitting a second time.
    await reset();await open();await label(0).check();
    await page.evaluate(()=>reloadPlan.push({error:'QA refresh failure'}));await page.locator('#label-split-save').click();
    await page.waitForFunction(()=>document.getElementById('label-split-message').textContent.includes('분할은 저장됐습니다'));
    assert.equal(await page.locator('#label-split-save').isDisabled(),true);assert.equal(await page.evaluate(()=>userProdEntries[0].outputs.length),2);
    await page.locator('#label-split-refresh').click();await page.waitForFunction(()=>!document.getElementById('label-split-dialog').open);
    assert.equal((await splitCalls()).length,1);

    // Saving disables close and duplicate submission; local updates wait for the request result.
    await reset();await open();await label(0).check();await page.evaluate(()=>savePlan.push({defer:true}));
    await page.locator('#label-split-save').click();await page.waitForFunction(()=>pending.length===1);
    assert.equal(await page.locator('#label-split-close').isDisabled(),true);assert.equal(await page.locator('#label-split-save').isDisabled(),true);
    await page.evaluate(()=>{DBMTLabelStockSplit.close();DBMTLabelStockSplit.save()});assert.equal((await splitCalls()).length,1);
    await page.keyboard.press('Escape');assert.equal(await page.locator('#label-split-dialog').isVisible(),true);
    await page.evaluate(()=>{const job=pending.shift();job.resolve(splitResult(job.body))});await page.waitForFunction(()=>!document.getElementById('label-split-dialog').open);

    // A later open wins over delayed GET and closed/auth-lost dialogs never receive stale results.
    await reset();await page.evaluate(()=>{loadPlan.push({defer:true});DBMTLabelStockSplit.open('old-production','old-stock')});
    await page.waitForFunction(()=>pending.length===1);await page.evaluate(()=>DBMTLabelStockSplit.open('new-production','new-stock'));
    await page.waitForFunction(()=>document.querySelectorAll('#label-split-labels input').length===5);
    await page.evaluate(()=>pending.shift().resolve({...fixtureData,productionId:'old-production',stockRowId:'old-stock',product:'旧 stale product'}));
    assert.equal(await page.locator('#label-split-product').innerText(),fixture.product);
    await page.evaluate(()=>{DBMTLabelStockSplit.close();loadPlan.push({defer:true});DBMTLabelStockSplit.open('fixture-production','fixture-stock')});
    await page.waitForFunction(()=>pending.length===1);await page.evaluate(()=>{sessionToken='other-token';DBMTLabelStockSplit.applyPermissions();pending.shift().resolve(fixtureData)});
    assert.equal(await page.locator('#label-split-dialog').isVisible(),false);assert.equal(await page.evaluate(()=>userProdEntries[0].outputs.length),1);

    // Permission loss while SAVE is pending cannot update the new user's local records.
    await reset();await open();await label(0).check();await page.evaluate(()=>savePlan.push({defer:true}));await page.locator('#label-split-save').click();
    await page.waitForFunction(()=>pending.length===1);await page.evaluate(()=>{sessionToken='new-session';DBMTLabelStockSplit.applyPermissions();const job=pending.shift();job.resolve(splitResult(job.body))});
    await page.waitForFunction(()=>productionWritePending===0);
    assert.equal(await page.locator('#label-split-dialog').isVisible(),false);assert.equal(await page.evaluate(()=>userProdEntries[0].outputs.length),1);

    // Existing editors/writes and read-only roles cannot open an allocation dialog.
    await reset();await page.evaluate(()=>{_editProdId='editing';DBMTLabelStockSplit.open('fixture-production','fixture-stock')});
    assert.equal(await page.locator('#label-split-dialog').isVisible(),false);assert.match(await page.evaluate(()=>messages.at(-1)),/입력 중/);
    await page.evaluate(()=>{_editProdId=null;productionWritePending=1;DBMTLabelStockSplit.open('fixture-production','fixture-stock')});assert.equal(await page.locator('#label-split-dialog').isVisible(),false);
    await page.evaluate(()=>{productionWritePending=0;permission=false;DBMTLabelStockSplit.applyPermissions()});assert.equal(await page.locator('.label-split-open').isVisible(),false);
    assert.equal(await page.evaluate(()=>DBMTLabelStockSplit.buttonHtml(userProdEntries[0],userProdEntries[0].outputs[0])), '');
    await page.evaluate(()=>{permission=true;fixtureData.canSplit=false;fixtureData.reason='이미 출고된 생산품입니다.'});await page.evaluate(()=>DBMTLabelStockSplit.open('fixture-production','fixture-stock'));
    assert.equal(await page.locator('#label-split-save').isDisabled(),true);assert.equal(await label(0).isDisabled(),true);assert.match(await page.locator('#label-split-message').innerText(),/이미 출고/);

    // Saved text is escaped, and long label lists scroll within a responsive dialog with visible actions.
    await reset();await page.evaluate(()=>{fixtureData.product='<img src=x onerror=alert(1)>';fixtureData.labels=Array.from({length:80},(_,i)=>({...fixtureData.labels[0],id:'long'+i,code:'<script>bad'+i+'</script>',batchId:'batch'+i}));});
    await page.evaluate(()=>DBMTLabelStockSplit.open('fixture-production','fixture-stock'));
    assert.equal(await page.locator('#label-split-dialog img,#label-split-dialog script').count(),0);
    for(const [width,height] of [[1453,981],[1280,720],[1024,768],[768,600],[390,844]]){
      await page.setViewportSize({width,height});
      const layout=await page.locator('#label-split-dialog').evaluate(n=>({top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom,left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right,scroll:n.scrollWidth>n.clientWidth+1}));
      assert.ok(layout.top>=4&&layout.bottom<=height-4&&layout.left>=0&&layout.right<=width,JSON.stringify({width,height,layout}));assert.equal(layout.scroll,false);
      const button=await page.locator('#label-split-save').boundingBox();assert.ok(button.y>=0&&button.y+button.height<=height);
      if(width===390){
        for(const selector of ['#label-split-labels','.label-split-summary']){
          const visible=await page.locator(selector).evaluate(node=>{const box=node.getBoundingClientRect(),pane=document.querySelector('.label-split-workspace').getBoundingClientRect();return {top:box.top,bottom:box.bottom,paneTop:pane.top,paneBottom:pane.bottom}});
          assert.ok(visible.top>=visible.paneTop&&visible.top<visible.paneBottom,selector+' must be visible without scrolling the whole dialog: '+JSON.stringify(visible));
        }
      }
    }
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(artifacts,'mobile.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('PASS: actual split dialog, per-label/batch/all selection, 40KG/2 + 60KG/3 totals, refresh/local stock postings, unknown UUID retry/reopen, cancelled receipt cleanup, stale reload, save/refresh failures, duplicate/close locks, load/auth races, editors/permissions and escaped responsive long lists');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
