// Actual checklist rendering with isolated RPC fixtures. No messages or real ERP writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const source=name=>{const m=html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));assert(m,name);return m[0];};
for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(m[1]);
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:1366,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<body></body>'}));await page.goto('http://fixture.test');
  await page.evaluate(markup=>{const t=document.createElement('template');t.innerHTML=markup;const panel=t.content.querySelector('#p-doccheck');panel.classList.add('active');document.body.append(panel);},html);
  for(const file of ['styles/main.css','styles/document-request-detail.css'])await page.addStyleTag({content:fs.readFileSync(path.join(root,file),'utf8')});
  await page.addScriptTag({content:`
   var session='qa',allowed=true,requests=[],summaryFail=false,pauseDelivery=false,pendingReads=[];
   var docChecksRevision=0,docChecksRefreshPromise=null,docChecksRefreshToken='',docChecksLastRefreshAt=0,checkFail=false,pauseChecks=false,pendingChecks=[],serverChecks={L003:true};
   const SUPABASE_ENABLED_KEY='qa-enabled',APP_DATA_REGISTRY={docChecks:{}},cacheAppDataValue=()=>{};
   localStorage.setItem(SUPABASE_ENABLED_KEY,'1');
   const getSupabasePassword=()=>session,toast=()=>{},asArray=v=>Array.isArray(v)?v:[];
   window.DBMTAuth={isPersonal:()=>!!session,can:()=>allowed,getSessionToken:()=>session};
   var docChecks={'L003':true},docCheckRowsCache=[],docRequestVisibleRows=[],docRequestSelectedKeys=new Set(),docRequestCapabilities={email:true,fax:true};
   var documentRequestLogs=[],documentRequestLogsLoaded=false,documentRequestLogsToken='',documentRequestDelivery=new Map(),documentRequestDeliveryState='loading',documentRequestDeliveryToken='',documentRequestDeliveryRequest=0;
   const inbound=(product,lot,date='2026-10-26',trader='가상 매입처')=>({type:'입고',product,lot,date,trader,origin:'미국산'});
   var traderInfoMap={'가상 매입처':{email:'fixture@example.invalid'},'팩스 거래처':{fax:'02-1234-5678'},'모두 거래처':{email:'both@example.invalid',fax:'031-123-4567',faxAlt:'031-123-4568'},'미등록 거래처':{email:'  ',fax:' ',faxAlt:''},'팩스2 거래처':{faxAlt:'032-123-4567'}};
   var userTransactions=[inbound('이전 발송 품목','L-001'),inbound('팩스 품목','L-002','2026-10-26','팩스 거래처'),inbound('두 채널 품목','L-003','2026-10-26','모두 거래처'),inbound('실패 품목','L-004','2026-10-26','미등록 거래처'),inbound('미발송 품목','L-005','2026-10-26','팩스2 거래처'),inbound('이력 없는 품목','','2026-10-25'),inbound('이력 없는 품목','','2026-10-24'),inbound('이전 발송 품목 중복','L-001','2026-10-25')];
   const receipt=(id,status='sent',created_at='2026-10-26T02:00:00Z',provider_status='')=>({id,created_at,status,provider_status});
   const identity=lot=>({lot});
   var summaries=[{identity:identity('l 001'),channel:'email',latest:receipt('12','failed'),success:receipt('11','sent','2026-09-01T02:00:00Z')},
    {identity:identity('L002'),channel:'fax',latest:receipt('20','accepted'),success:receipt('20','accepted')},
    {identity:identity('l-003'),channel:'email',latest:receipt('31'),success:receipt('31')},
    {identity:identity('L003'),channel:'fax',latest:receipt('32','accepted','2026-10-26T01:00:00Z','테스트 접수'),success:receipt('32','accepted','2026-10-26T01:00:00Z','테스트 접수')},
    {identity:identity('L004'),channel:'email',latest:receipt('41','failed'),success:null},
    {identity:{lot:'',date:'2026/10/25',product:'이력 없는 품목',origin:'미국산',trader:'가상 매입처'},channel:'email',latest:receipt('51'),success:receipt('51')}];
   async function sbRpc(name,args){
    requests.push({name,args});
    if(name==='dbmt_erp_get_doc_checks'){if(checkFail)throw Error('QA receipt failure');if(pauseChecks)return new Promise(resolve=>pendingChecks.push(resolve));return {docChecks:structuredClone(serverChecks)};}
    if(name==='dbmt_erp_get_document_request_delivery'){if(summaryFail)throw Error('QA read failure');if(pauseDelivery)return new Promise(resolve=>pendingReads.push(resolve));return structuredClone(summaries);}
    if(name==='dbmt_erp_get_document_request_logs')return [{id:'999',channel:'email',status:'sent',documents:[{lot:'unrelated'}]}];
    if(name==='dbmt_erp_get_document_request_log_detail')return {ok:true,log:{id:args.p_id,channel:'email',status:'sent',subject:'가상 요청',documents:[],content_snapshot:{html:'<p>가상 보낸 내용</p>'}}};
    throw Error('Unexpected RPC: '+name);
   }
   ${['htmlEscape','jsArg','getTraderInfo','normalizeDocLot','getDocKey','getLegacyDocKey','getDocKeys','isDocChecked','isImported','getRequiredDoc','updateDocumentRequestButtons','formatDocumentRequestDate','documentRequestLogLots','renderDocumentRequestLogs','renderDocumentRequestContact','documentRequestDeliveryKey','renderDocumentRequestDelivery','loadDocumentRequestDelivery','loadDocumentRequestLogs','refreshDocChecksFromSupabase','renderDocCheck'].map(source).join('\n')}
   document.getElementById('doc-filter').value='전체';renderDocCheck();
  `});
  await page.addScriptTag({content:fs.readFileSync(path.join(root,'document-request-detail.js'),'utf8')});
  assert.equal(await page.locator('#doc-tbody').evaluate(el=>el.closest('table').querySelectorAll('thead th').length),10);
  assert.match(await page.locator('#doc-tbody').textContent(),/로그인 확인/);
  await page.evaluate(()=>Promise.all([loadDocumentRequestLogs(true),refreshDocChecksFromSupabase(true)]));
  assert(!(await page.evaluate(()=>requests)).some(r=>r.name==='dbmt_erp_get_all'),'Receipt refresh must not download the full ERP payload');
  const cell=name=>page.locator('#doc-tbody tr').filter({has:page.locator('td:nth-child(3)',{hasText:name})}).first().locator('.doc-delivery-cell');
  const contact=name=>page.locator('#doc-tbody tr').filter({has:page.locator('td:nth-child(3)',{hasText:name})}).first().locator('.doc-contact-status');
  assert.equal(await contact('이전 발송 품목').textContent(),'메일');
  assert.equal(await contact('팩스 품목').textContent(),'팩스');
  assert.equal(await contact('두 채널 품목').textContent(),'메일 · 팩스');
  assert.equal(await contact('실패 품목').textContent(),'미등록');
  assert.equal(await contact('미발송 품목').textContent(),'팩스2');
  assert.match(await contact('두 채널 품목').getAttribute('title'),/both@example.invalid.*\n팩스: 031-123-4567.*\n팩스2: 031-123-4568/);
  const callsBeforeContact=await page.evaluate(()=>requests.length);
  await page.evaluate(()=>{traderInfoMap['가상 매입처'].fax='02-9999-0000';renderDocCheck();});
  assert.equal(await contact('이전 발송 품목').textContent(),'메일 · 팩스','Registered contacts update from the same trader data');
  assert.equal(await page.evaluate(()=>requests.length),callsBeforeContact,'Contact indicators must not add server reads or writes');
  assert.equal(await page.locator('#doc-tbody tr').count(),7,'Existing same-LOT checklist grouping remains intact');
  assert.match(await cell('이전 발송 품목').textContent(),/메일 발송.*26\. 09\. 01.*최근 시도 실패/);
  assert.equal(await cell('이전 발송 품목').locator('button').getAttribute('data-doc-request-detail'),'11','Link the successful request even after a failed retry');
  assert.match(await cell('팩스 품목').textContent(),/팩스 접수/);assert.doesNotMatch(await cell('팩스 품목').textContent(),/발송완료/);
  assert.match(await cell('두 채널 품목').textContent(),/메일 발송.*팩스 테스트 접수/);
  assert.match(await cell('실패 품목').textContent(),/메일 실패/);assert.doesNotMatch(await cell('실패 품목').textContent(),/메일 발송/);
  assert.equal(await cell('미발송 품목').textContent(),'미발송');
  const blanks=await page.locator('#doc-tbody tr').filter({has:page.locator('td:nth-child(3)',{hasText:'이력 없는 품목'})}).locator('.doc-delivery-cell').allTextContents();
  assert(blanks.some(v=>v.includes('메일 발송'))&&blanks.includes('미발송'),'No false association across different blank-LOT inbound dates');
  assert.deepEqual(await page.evaluate(()=>docChecks),{L003:true},'Delivery refresh cannot mark documents received');
  const shot=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-doc-delivery-')),'checklist.png');await page.locator('#p-doccheck').screenshot({path:shot});
  await cell('이전 발송 품목').locator('button').click();await page.frameLocator('#document-request-body-frame').locator('p').waitFor();
  assert.equal(await page.frameLocator('#document-request-body-frame').locator('p').textContent(),'가상 보낸 내용');
  assert.equal(await page.evaluate(()=>requests.at(-1).args.p_id),'11');await page.locator('[data-detail-close]').first().click();
  await page.locator('#doc-search').fill('미발송 품목');assert.equal(await page.locator('#doc-tbody tr').count(),1);
  await page.locator('#doc-search').fill('not-a-product');assert.equal(await page.locator('#doc-tbody td').getAttribute('colspan'),'10');
  await page.locator('#doc-search').fill('');
  await page.evaluate(()=>{summaryFail=true;});await page.evaluate(()=>loadDocumentRequestLogs(true));
  assert.match(await cell('미발송 품목').textContent(),/조회 실패/);assert.doesNotMatch(await cell('미발송 품목').textContent(),/미발송/);
  await page.evaluate(()=>{summaryFail=false;pauseDelivery=true;void loadDocumentRequestDelivery(true);});
  assert.match(await cell('미발송 품목').textContent(),/조회 중/);
  await page.evaluate(()=>{session='new-session';pendingReads.shift()(structuredClone(summaries));});
  await page.waitForTimeout(30);assert.doesNotMatch(await page.locator('#doc-tbody').textContent(),/메일 발송/,'Old-session results must never appear');
  await page.evaluate(()=>{pauseDelivery=false;});await page.evaluate(()=>loadDocumentRequestLogs(true));
  assert.equal(await page.evaluate(()=>requests.filter(r=>r.name==='dbmt_erp_get_document_request_logs').at(-1).args.p_token),'new-session','History also refreshes after login changes');
  await page.evaluate(()=>{pauseDelivery=true;void loadDocumentRequestDelivery(true);void loadDocumentRequestDelivery(true);pendingReads[1]([]);});
  await page.waitForFunction(()=>documentRequestDeliveryState==='ready');
  await page.evaluate(()=>pendingReads[0](structuredClone(summaries)));await page.waitForTimeout(30);
  assert.equal(await cell('이전 발송 품목').textContent(),'미발송','An older response cannot overwrite a newer result');
  await page.evaluate(()=>{pauseChecks=true;window.checkRead=refreshDocChecksFromSupabase(true);docChecks.LOCAL=true;docChecksRevision++;pendingChecks.shift()({docChecks:{L003:false}});});
  assert.equal(await page.evaluate(()=>window.checkRead),false);
  assert.equal(await page.evaluate(()=>docChecks.LOCAL),true,'An in-flight refresh cannot overwrite a new receipt check');
  await page.evaluate(()=>{window.oldRead=refreshDocChecksFromSupabase(true);session='next-login';window.newRead=refreshDocChecksFromSupabase(true);pendingChecks[1]({docChecks:{NEW:true}});});
  assert.equal(await page.evaluate(()=>window.newRead),true);
  await page.evaluate(()=>pendingChecks[0]({docChecks:{OLD:true}}));await page.evaluate(()=>window.oldRead);
  assert.deepEqual(await page.evaluate(()=>docChecks),{NEW:true},'An old login cannot replace the current receipt flags');
  await page.evaluate(()=>{pauseChecks=false;checkFail=true;});
  assert.equal(await page.evaluate(async()=>{try{await refreshDocChecksFromSupabase(true);return false;}catch{return true;}}),true);
  assert.deepEqual(await page.evaluate(()=>docChecks),{NEW:true},'Failed reads retain the displayed receipt flags');
  assert((await page.evaluate(()=>requests.map(r=>r.name))).every(n=>n==='dbmt_erp_get_doc_checks'||n.startsWith('dbmt_erp_get_document_request_')),'Only scoped read APIs may be invoked');
  assert.deepEqual(errors,[]);console.log('PASS: channel/date/status, history, receipt-only refresh, receipt edit/login/error race guards, grouped LOTs, blank-LOT identity, failed retries/test fax, content viewer, filters, loading/errors, no sends. Screenshot: '+shot);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
