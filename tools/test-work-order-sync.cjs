/* Two isolated browser profiles and an in-memory RPC fixture. No live data. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const source=name=>{const m=html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));assert(m,name);return m[0];};
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-work-order-sync-'));
let rows=[],failWrite=false,holdWrite=null,holdRead=null,lostResponse=false,writes=[];
const hash=value=>crypto.createHash('md5').update(JSON.stringify(value)).digest('hex');
const snapshot=()=>({ok:true,rows:structuredClone(rows),revision:hash(rows),versions:Object.fromEntries(rows.map(r=>[r.id,hash(r)]))});
const server=http.createServer(async(req,res)=>{
  if(req.url==='/rpc'){
    let body='';for await(const chunk of req)body+=chunk;const {name,args}=JSON.parse(body);
    const reply=data=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
    if(name==='dbmt_erp_get_work_orders'){
      const data=snapshot();if(holdRead){const wait=holdRead;holdRead=null;await wait;}
      reply(args.p_revision===data.revision?{ok:true,unchanged:true,revision:data.revision}:data);return;
    }
    assert.equal(name,'dbmt_erp_write_work_order');writes.push(structuredClone(args));
    if(holdWrite){const wait=holdWrite;holdWrite=null;await wait;}
    if(failWrite){res.statusCode=500;reply({message:'QA 서버 저장 실패'});return;}
    const old=rows.find(r=>r.id===args.p_row.id);
    if((old&&JSON.stringify(old)===JSON.stringify(args.p_row))||(!old&&args.p_delete)){reply(snapshot());return;}
    if((old&&hash(old)!==args.p_expected_version)||(!old&&args.p_expected_version)){
      reply({ok:false,conflict:true,message:'다른 PC에서 변경되었습니다. 작성 내용은 유지됩니다.'});return;
    }
    if(args.p_delete)rows=rows.filter(r=>r.id!==args.p_row.id);
    else if(old)rows=rows.map(r=>r.id===old.id?args.p_row:r);
    else rows.unshift(args.p_row);
    if(lostResponse){lostResponse=false;res.statusCode=502;reply({message:'QA 응답 유실'});return;}
    reply(snapshot());return;
  }
  res.setHeader('Content-Type','text/html');res.end('<html><body></body></html>');
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    async function client(){
      const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
      await page.goto(url);
      await page.evaluate(text=>{const t=document.createElement('template');t.innerHTML=text;document.body.append(t.content.querySelector('#p-workorders'));document.getElementById('p-workorders').classList.add('active');},html);
      await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
      await page.addScriptTag({content:`
        let workOrders=[],workOrderPendingSave=null,workOrderSaving=false;window.workOrderEditVersion=null;
        const labelProducts=[];let sequence=0;window.messages=[];window.failures=[];
        const toast=v=>messages.push(v),getSupabasePassword=()=>window.qaToken,localDateString=()=> '2026-10-19';
        window.qaToken='fixture';window.DBMTAuth={isPersonal:()=>!!window.qaToken,can:()=>true};
        window.alert=v=>failures.push(v);window.confirm=()=>true;
        const workOrderId=()=> 'wo-'+Date.now()+'-'+(++sequence),parseAppNumber=v=>Number(v)||0;
        const htmlEscape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        const jsArg=v=>htmlEscape(JSON.stringify(v)),bulkOutboundSearchKey=v=>String(v).toLowerCase();
        const totalRecordedBoxes=()=>null,boxCountDisplay=()=>'',workOrderSourceInputs=r=>r.sourceInputs||[],workOrderSearchText=r=>Object.values(r).join(' ');
        const initWorkOrderForm=()=>{},workOrderSourceRows=()=>[],addWorkOrderSourceRow=()=>{},autoSetWorkOrderExpiry=()=>{},refreshWorkOrderPreview=()=>{},refreshLabelWorkOrderSelect=()=>{};
        const samePriceText=(a,b)=>a===b;
        let userTransactions=[],userProdEntries=[],prices=[],transactions=[],subMaterialUsages=[];
        const EXCEL_TRANSACTIONS=[],cleanupSupabaseLegacyCoreCache=()=>{},safeLocalStorageSet=()=>{},cacheAppDataValue=()=>{},invalidateStockMap=()=>{},scheduleProductionPickerWarmup=()=>{};
        const APP_DATA_REGISTRY={workOrders:{set:v=>{workOrders=v;},get:()=>workOrders}};
        function collectWorkOrderForm(){return {id:document.getElementById('wo-edit-id').value||workOrderId(),date:document.getElementById('wo-date').value,product:document.getElementById('wo-product').value,title:document.getElementById('wo-title').value,updatedAt:new Date().toISOString()};}
        async function sbRpc(name,args,options={}){const r=await fetch('/rpc',{method:'POST',signal:options.signal,body:JSON.stringify({name,args})});const data=await r.json();if(!r.ok)throw new Error(data.message);return data;}
        ${['workOrderDraftSignature','setWorkOrderSaving','saveWorkOrder','resetWorkOrderForm','editWorkOrder','deleteWorkOrder','renderWorkOrders','applySupabasePayload'].map(source).join('\n')}
        document.getElementById('wo-date').value='2026-10-19';document.getElementById('wo-list-date').value='2026-10-19';
      `});
      await page.addScriptTag({content:fs.readFileSync(path.join(root,'work-orders-sync.js'),'utf8')});
      assert.equal(await page.evaluate(()=>DBMTWorkOrders.start()),true);
      return page;
    }
    const a=await client(),b=await client();
    async function fill(page,name){await page.locator('#wo-product').fill(name);await page.locator('#wo-title').fill('작업 '+name);}
    await fill(b,'작성 중 초안');await b.locator('#wo-origin').fill('미국산');await b.locator('#wo-mfgdate').fill('');await b.locator('#wo-expdate').fill('');
    const draft=await b.evaluate(()=>workOrderDraftSignature());
    await fill(a,'PC A 생산물');
    let release;holdWrite=new Promise(resolve=>release=resolve);
    await a.locator('#wo-save-btn').click();await a.waitForFunction(()=>workOrderSaving);
    assert.equal(await a.locator('#wo-save-btn').isDisabled(),true);assert.equal(await a.evaluate(()=>messages.length),0);
    assert.equal(await a.locator('#wo-product').inputValue(),'PC A 생산물');
    release();await a.waitForFunction(()=>!workOrderSaving);
    assert.equal(await a.evaluate(()=>messages.length),1);assert.equal(await a.locator('#wo-product').inputValue(),'');
    await a.evaluate(()=>applySupabasePayload({transactions:[],prod:[],appData:{workOrders:[]}}));
    assert.equal(await a.evaluate(()=>workOrders.length),1,'A stale full-ERP recovery cannot separate rows from their edit versions');
    await b.waitForFunction(()=>workOrders.length===1,{},{timeout:8000});
    assert.equal(await b.evaluate(()=>workOrderDraftSignature()),draft,'Automatic polling must preserve every draft field including intentionally blank dates');
    await b.evaluate(()=>saveWorkOrder());assert.equal(rows.length,2,'Another PC saving a stale list must retain the first PC row');
    await a.evaluate(()=>DBMTWorkOrders.refresh());
    const id=rows.find(r=>r.product==='PC A 생산물').id;
    await a.evaluate(id=>editWorkOrder(id),id);await b.evaluate(id=>editWorkOrder(id),id);
    await a.locator('#wo-title').fill('A가 수정');await a.evaluate(()=>saveWorkOrder());
    await b.locator('#wo-title').fill('B가 수정 중');const edited=await b.evaluate(()=>workOrderDraftSignature());
    await b.evaluate(()=>DBMTWorkOrders.refresh());assert.equal(await b.evaluate(()=>workOrderDraftSignature()),edited);
    assert.match(await b.locator('#wo-sync-status').textContent(),/다른 PC/);
    const beforeMessages=await b.evaluate(()=>messages.length);await b.evaluate(()=>saveWorkOrder());
    assert.equal(await b.evaluate(()=>messages.length),beforeMessages);assert.match(await b.evaluate(()=>failures.at(-1)),/다른 PC/);
    assert.equal(await b.locator('#wo-title').inputValue(),'B가 수정 중');assert.equal(rows.find(r=>r.id===id).title,'A가 수정');
    await b.evaluate(()=>resetWorkOrderForm());await fill(b,'통신 실패 초안');failWrite=true;
    await b.evaluate(()=>saveWorkOrder());assert.equal(await b.locator('#wo-product').inputValue(),'통신 실패 초안');
    assert.equal(await b.evaluate(()=>messages.length),beforeMessages);failWrite=false;
    await b.evaluate(()=>saveWorkOrder());assert.equal(rows.length,3);assert.equal(await b.locator('#wo-product').inputValue(),'');
    // An accepted write with a lost response must be safely retried using the same ID and exact payload.
    await fill(b,'응답 유실 초안');lostResponse=true;await b.evaluate(()=>saveWorkOrder());
    const retryId=writes.at(-1).p_row.id;assert.equal(rows.length,4);await b.evaluate(()=>saveWorkOrder());
    assert.equal(writes.at(-1).p_row.id,retryId);assert.equal(rows.length,4);assert.equal(await b.locator('#wo-product').inputValue(),'');
    // Typing while a slow write is pending remains a draft of the saved record, not a second creation.
    await fill(b,'느린 저장');holdWrite=new Promise(resolve=>release=resolve);
    await b.locator('#wo-save-btn').click();await b.waitForFunction(()=>workOrderSaving);await b.locator('#wo-title').fill('저장 중 추가 입력');
    release();await b.waitForFunction(()=>!workOrderSaving);
    assert.equal(await b.locator('#wo-title').inputValue(),'저장 중 추가 입력');assert.ok(await b.locator('#wo-edit-id').inputValue());
    const length=rows.length;await b.evaluate(()=>saveWorkOrder());assert.equal(rows.length,length);assert.equal(rows[0].title,'저장 중 추가 입력');
    // A delayed read obtained before a write must not revert its successful result.
    holdRead=new Promise(resolve=>release=resolve);await a.evaluate(()=>{window.pendingRead=DBMTWorkOrders.refresh(true);});
    await a.waitForTimeout(100);await fill(a,'읽기 경쟁');await a.evaluate(()=>saveWorkOrder());release();await a.evaluate(()=>pendingRead);
    assert.equal(await a.evaluate(()=>workOrders.some(r=>r.product==='읽기 경쟁')),true);
    await b.evaluate(()=>DBMTWorkOrders.refresh(true));
    failWrite=true;const beforeDelete=rows.length;await b.evaluate(id=>deleteWorkOrder(id),id);
    assert.equal(rows.length,beforeDelete);assert.equal(await b.evaluate(id=>workOrders.some(r=>r.id===id),id),true,'A failed delete must retain the local row');
    failWrite=false;await b.evaluate(id=>deleteWorkOrder(id),id);
    await a.waitForFunction(id=>!workOrders.some(r=>r.id===id),id,{timeout:8000});
    assert.equal(rows.some(r=>r.id===id),false,'Deletion automatically reaches another PC');
    // Logout invalidates late reads and prevents more writes.
    holdRead=new Promise(resolve=>release=resolve);await a.evaluate(()=>{window.pendingRead=DBMTWorkOrders.refresh(true);});
    await a.waitForTimeout(100);await a.evaluate(()=>{DBMTWorkOrders.stop();qaToken='';workOrders=[];});release();await a.evaluate(()=>pendingRead);
    assert.deepEqual(await a.evaluate(()=>workOrders),[]);
    await b.screenshot({path:path.join(artifacts,'work-order-sync.png'),fullPage:true});
    console.log('PASS: two profiles, automatic 5-second additions/deletions, all draft values preserved, confirmed-save messages, failed save retains draft, stale same-row conflict, lost-response retry, edits during save, stale read suppression, logout invalidation');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
