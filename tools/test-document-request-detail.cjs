// Read-only UI fixtures. No real ERP data or delivery calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
const source=name=>{const match=html.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));assert(match,name);return match[0];};
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>{if(route.request().url().startsWith('https://'))external.push(route.request().url());return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'})});
  await page.goto('http://fixture.test');
  await page.evaluate(markup=>{const t=document.createElement('template');t.innerHTML=markup;const panel=t.content.querySelector('#p-doccheck');panel.classList.add('active');document.body.append(panel);},html);
  for(const file of ['styles/main.css','styles/document-request-detail.css'])await page.addStyleTag({content:fs.readFileSync(path.join(root,file),'utf8')});
  await page.addScriptTag({content:`
    var allowed=true,session='session-one',notices=[],rpcCalls=[],delayed=false,pending=null;
    window.DBMTAuth={isPersonal:()=>!!session,can:(menu,action)=>allowed&&action==='view',getSessionToken:()=>session};
    const toast=message=>notices.push(message);
    const documents=[{date:'2026-10-20',product:'가상 삼겹살 <A>',brand:'가상 브랜드',origin:'국내산',lot:'001-LOT',requiredDoc:'등급판정서'}];
    var documentRequestLogs=[{id:1,created_at:'2026-10-20T01:00:00Z',channel:'email',trader:'가상 거래처',recipient:'recipient@example.invalid',subject:'이전 메일 요청',status:'sent',documents,document_count:1},
      {id:2,created_at:'2026-10-20T02:00:00Z',channel:'email',trader:'가상 거래처',recipient:'recipient@example.invalid',subject:'새 메일 요청',status:'sent',documents,document_count:1,content_snapshot:{version:1,sender:{displayName:'가상 발신처',from:'sender@example.invalid'},html:'<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://blocked.invalid"><style>body{font-family:Arial,sans-serif;padding:24px}h2{border-bottom:2px solid #555}table{border-collapse:collapse;width:100%}td,th{border:1px solid #aaa;padding:10px}th{background:#eee}</style></head><body><h2>입고 필요서류 요청서</h2><p>수신: 가상 거래처 귀중</p><p>안녕하세요. 아래 입고 건에 대한 필요서류를 회신 부탁드립니다.</p><table><tr><th>품목명</th><th>이력번호</th><th>필요서류</th></tr><tr><td>가상 삼겹살</td><td>001-LOT</td><td>등급판정서</td></tr></table><script>parent.hacked=true<\\/script><img src="https://blocked.invalid/tracker"><a href="https://blocked.invalid">회신</a></body></html>'}},
      {id:3,created_at:'2026-10-20T03:00:00Z',channel:'fax',trader:'가상 거래처',recipient:'02-1234-5678',subject:'팩스 요청',status:'failed',error_message:'가상 발송 오류',documents,document_count:1,content_snapshot:{version:1,sender:{displayName:'가상 발신처',from:'0211112222'},html:'<html><body><h2>팩스 요청서</h2><p>가상 팩스 내용</p></body></html>'}}];
    async function sbRpc(name,args){rpcCalls.push({name,args});if(delayed)return await new Promise(resolve=>pending=resolve);const row=documentRequestLogs.find(r=>String(r.id)===args.p_id);return {ok:!!row,log:row};}
    ${['htmlEscape','formatDocumentRequestDate','documentRequestLogLots','renderDocumentRequestLogs'].map(source).join('\n')}
    renderDocumentRequestLogs();
  `});
  await page.addScriptTag({content:fs.readFileSync(path.join(root,'document-request-detail.js'),'utf8')});
  assert.equal(await page.locator('[data-doc-request-detail]').count(),3);
  await page.locator('[data-doc-request-detail="1"]').click();await page.locator('.document-detail-note').waitFor();
  assert.match(await page.locator('#document-request-detail-body').innerText(),/본문 원본을 보관하지 않아/);
  assert.match(await page.locator('#document-request-detail-body').innerText(),/이전 메일 요청/);
  assert.deepEqual(await page.locator('.document-detail-table-wrap th').allTextContents(),['입고일','품목명','브랜드','원산지','이력번호','필요서류']);
  assert.match(await page.locator('.document-detail-table-wrap').innerText(),/가상 브랜드/);
  assert.equal(await page.locator('#document-request-body-frame').count(),0);
  await page.keyboard.press('Escape');
  await page.locator('[data-doc-request-detail="2"]').click();const frame=page.frameLocator('#document-request-body-frame');await frame.locator('h2').waitFor();
  assert.equal(await page.locator('#document-request-body-frame').getAttribute('sandbox'),'');
  assert.equal(await frame.locator('script,base,meta[http-equiv="refresh"]').count(),0);
  assert.equal(await frame.locator('[src],[href],[onload]').count(),0);assert.equal(await page.evaluate(()=>window.hacked),undefined);
  assert.match(await frame.locator('body').innerText(),/입고 필요서류 요청서/);
  assert.match(await page.locator('#document-request-detail-body').innerText(),/sender@example.invalid/);
  const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-document-detail-'));await page.locator('#document-request-detail').screenshot({path:path.join(artifacts,'email-detail.png')});
  await page.locator('#document-request-detail footer button').click();
  await page.locator('[data-doc-request-detail="3"]').click();await frame.locator('h2').waitFor();assert.match(await page.locator('.document-detail-note').innerText(),/발송 실패/);
  await page.setViewportSize({width:360,height:900});assert(await page.locator('#document-request-detail').evaluate(node=>node.getBoundingClientRect().right<=innerWidth));
  await page.locator('#document-request-detail').screenshot({path:path.join(artifacts,'fax-mobile.png')});await page.keyboard.press('Escape');
  await page.evaluate(()=>{delayed=true;void DBMTDocumentRequestDetail.open('2')});
  await page.evaluate(()=>{session='session-two';DBMTDocumentRequestDetail.applyPermissions();pending({ok:true,log:documentRequestLogs[1]});});
  assert(!(await page.locator('#document-request-detail').evaluate(node=>node.open)));assert.equal(await page.locator('#document-request-detail-body').innerText(),'');
  await page.evaluate(()=>{delayed=false;void DBMTDocumentRequestDetail.open('999')});await page.waitForFunction(()=>document.getElementById('document-request-detail-body').textContent==='발송 내용을 불러오지 못했습니다.');await page.keyboard.press('Escape');
  const calls=await page.evaluate(()=>rpcCalls.length);await page.evaluate(()=>{allowed=false;void DBMTDocumentRequestDetail.open('2')});assert.equal(await page.evaluate(()=>rpcCalls.length),calls);
  assert((await page.evaluate(()=>rpcCalls)).every(call=>call.name==='dbmt_erp_get_document_request_log_detail'));
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  console.log('PASS: legacy/saved mail and fax details; view-only access; escaped metadata; sandbox/CSP/no tracking; mobile; close/logout/session races; missing records; no delivery calls');console.log('Artifacts: '+artifacts);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
