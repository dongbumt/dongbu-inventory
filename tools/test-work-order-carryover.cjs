/* Actual carry dialog + sync controller in an isolated browser/RPC fixture. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const source=name=>{const m=html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));assert(m,name);return m[0];};
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-work-order-carry-'));
const original={id:'work-500',date:'2026-10-19',title:'원료 500KG 작업',product:'목전지(작업)',inputWeight:500,inputBoxCount:5,lot:'RAW-LOT',sourceInputs:[{sourceStock:{key:'raw-stock',product:'목전지',lot:'RAW-LOT'},inputWeight:500,boxCount:5}]};
let rows=[structuredClone(original)],calls=[],failure=null,hold=null,forceBlocked=false;
const hash=x=>crypto.createHash('md5').update(JSON.stringify(x)).digest('hex');
const snapshot=()=>({ok:true,rows,versions:Object.fromEntries(rows.map(r=>[r.id,hash(r)])),revision:hash(rows)});
const context=()=>({ok:true,stateVersion:'state-version',state:{order:rows[0],labelKg:300,labelBoxes:3,canCarry:!forceBlocked,reason:forceBlocked?'생산일보에 원료 전량이 투입된 것으로 기록되어 있습니다. 실제 투입 내역을 먼저 확인해주세요.':'',sources:[{index:0,product:'목전지',lot:'RAW-LOT',originalKg:500,usedKg:forceBlocked?500:350,maxKg:forceBlocked?0:150,maxBoxes:forceBlocked?0:2}]}});
const server=http.createServer(async(req,res)=>{
  if(req.url!=='/rpc'){res.setHeader('Content-Type','text/html');res.end('<html><body></body></html>');return;}
  let body='';for await(const c of req)body+=c;const {name,args}=JSON.parse(body);
  const reply=(data,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
  if(name==='dbmt_erp_get_work_orders'){reply(snapshot());return;}
  if(name==='dbmt_erp_get_work_order_carryover'){reply(context());return;}
  if(name==='dbmt_erp_cancel_work_order_carryover'){
    const child=rows.find(r=>r.id===args.p_id),parent=rows.find(r=>r.id===child._carryoverFrom.id);
    delete parent._carryoverTo;rows=rows.filter(r=>r.id!==child.id);reply(snapshot());return;
  }
  assert.equal(name,'dbmt_erp_carry_work_order');calls.push(args);
  if(hold){const p=hold;hold=null;await p;}
  if(failure==='stale'){reply({message:'작업지시 또는 생산일보가 변경되었습니다. 이월 창을 다시 열어 확인해주세요.'},400);return;}
  const parent=rows.find(r=>r.id===original.id);
  if(!parent._carryoverTo){
    const child={...structuredClone(original),id:'child-'+args.p_request_id,date:args.p_date,mfgdate:args.p_date,inputWeight:args.p_sources[0].qty,inputBoxCount:args.p_sources[0].boxCount,_carryoverFrom:{id:parent.id,date:parent.date},sourceInputs:[{...original.sourceInputs[0],inputWeight:args.p_sources[0].qty,boxCount:args.p_sources[0].boxCount}]};
    parent._carryoverTo={id:child.id,date:args.p_date,productionId:'journal-today',requestId:args.p_request_id};rows.unshift(child);
  }
  if(failure==='lost'){failure=null;reply({message:'QA 응답 유실'},502);return;}
  reply({...snapshot(),childId:parent._carryoverTo.id});
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(text=>{const t=document.createElement('template');t.innerHTML=text;document.body.append(t.content.querySelector('#p-workorders'));document.getElementById('p-workorders').classList.add('active');},html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/work-order-carryover.css'),'utf8')});
    await page.addScriptTag({content:`
      let workOrders=[];window.workOrderEditVersion=null;window.messages=[];
      window.DBMTAuth={isPersonal:()=>true,can:()=>true};const getSupabasePassword=()=> 'fixture-token';
      const toast=x=>messages.push(x),parseAppNumber=v=>Number(v)||0;
      window.confirm=()=>true;
      const localDateString=d=>d?[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-'):'2026-10-19';
      const htmlEscape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const jsArg=v=>htmlEscape(JSON.stringify(v));
      const bulkOutboundSearchKey=v=>String(v||'').toLowerCase(),workOrderSearchText=r=>Object.values(r).join(' '),workOrderSourceInputs=r=>r.sourceInputs||[];
      const totalRecordedBoxes=()=>null,boxCountDisplay=(v,empty='')=>v==null?empty:String(v),refreshLabelWorkOrderSelect=()=>{};
      async function sbRpc(name,args,options={}){const r=await fetch('/rpc',{method:'POST',signal:options.signal,body:JSON.stringify({name,args})});const data=await r.json();if(!r.ok){const e=new Error(data.message);e.status=r.status;throw e;}return data;}
      ${source('renderWorkOrders')}
      document.getElementById('wo-list-date').value='2026-10-19';
    `});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'work-orders-sync.js'),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'work-order-carryover.js'),'utf8')});
    await page.evaluate(()=>DBMTWorkOrders.start());
    await page.locator('#wo-title').fill('별도로 작성 중인 초안');await page.locator('#wo-product').fill('원래 입력 중인 제품');
    await page.getByRole('button',{name:'잔량 이월',exact:true}).click();
    await page.waitForSelector('#wo-carry-dialog tr[data-source]');
    assert.equal(await page.locator('#wo-carry-date').inputValue(),'2026-10-20');
    assert.equal(await page.locator('.wc-weight').inputValue(),'','Carry quantity must be manually entered, never 500 minus 300');
    assert.match(await page.locator('#wo-carry-body').innerText(),/300 KG \/ 3박스/);
    assert.match(await page.locator('#wo-carry-body').innerText(),/150 KG/);
    await page.locator('.wc-weight').fill('200');await page.locator('#wo-carry-save').click();
    assert.equal(calls.length,0);assert.match(await page.locator('#wo-carry-message').innerText(),/상한/);
    await page.locator('.wc-weight').fill('150');await page.locator('.wc-boxes').fill('2');
    const box=await page.locator('.wc-boxes').boundingBox(),kg=await page.locator('.wc-weight').boundingBox();assert(box.x<kg.x);
    failure='stale';await page.locator('#wo-carry-save').click();await page.waitForFunction(()=>document.getElementById('wo-carry-message').textContent.includes('변경'));
    assert.equal(await page.locator('.wc-weight').inputValue(),'150','Server rejection retains entered carry quantity');assert.equal(await page.evaluate(()=>messages.length),0);
    failure='lost';let release;hold=new Promise(resolve=>release=resolve);
    await page.locator('#wo-carry-save').click();await page.waitForFunction(()=>document.getElementById('wo-carry-message').textContent.includes('저장하는 중'));
    await page.keyboard.press('Escape');assert.equal(await page.locator('#wo-carry-dialog').evaluate(el=>el.open),true);
    assert.equal(await page.evaluate(()=>messages.length),0);release();
    await page.waitForFunction(()=>document.getElementById('wo-carry-message').textContent.includes('확인되지'));
    const requestId=calls.at(-1).p_request_id;
    assert.equal(await page.locator('.wc-weight').isDisabled(),true);assert.equal(await page.locator('#wo-title').inputValue(),'별도로 작성 중인 초안');
    await page.locator('#wo-carry-close').click();await page.evaluate(()=>DBMTWorkOrders.refresh(true));
    await page.getByRole('button',{name:'이월 저장 확인',exact:true}).click();
    assert.equal(await page.locator('.wc-weight').inputValue(),'150');
    await page.locator('#wo-carry-save').click();await page.waitForFunction(()=>!document.getElementById('wo-carry-dialog').open);
    assert.equal(calls.at(-1).p_request_id,requestId);assert.equal(rows.length,2);assert.equal(await page.evaluate(()=>messages.length),1);
    assert.equal(await page.locator('#wo-title').inputValue(),'별도로 작성 중인 초안');
    assert.equal(await page.getByRole('button',{name:'이월 저장 확인',exact:true}).count(),0);
    assert.match(await page.locator('#wo-list-wrap').innerText(),/부분 완료/);
    await page.locator('#wo-list-wrap .wo-carry-nav').click();
    assert.equal(await page.locator('#wo-list-date').inputValue(),'2026-10-20');assert.match(await page.locator('#wo-list-wrap').innerText(),/작업에서 이월/);
    await page.evaluate(()=>{DBMTWorkOrderCarryover.applyEditor({_carryoverFrom:{id:'source'}});});
    assert.equal(await page.locator('#wo-add-source').isDisabled(),true);
    await page.evaluate(()=>DBMTWorkOrderCarryover.applyEditor(null));assert.equal(await page.locator('#wo-add-source').isDisabled(),false);
    await page.getByRole('button',{name:'이월 취소',exact:true}).click();
    await page.waitForFunction(()=>workOrders.length===1&&!workOrders[0]._carryoverTo);
    assert.equal(await page.locator('#wo-title').inputValue(),'별도로 작성 중인 초안','Cancelling an unprinted carry also preserves the draft');
    // Full consumption produces a clear explanation, with no mutation request.
    rows=[structuredClone(original)];forceBlocked=true;await page.evaluate(()=>DBMTWorkOrders.refresh(true));
    await page.evaluate(()=>DBMTWorkOrderCarryover.open('work-500'));await page.waitForFunction(()=>document.getElementById('wo-carry-message').textContent.includes('전량'));
    assert.equal(await page.locator('#wo-carry-save').isDisabled(),true);
    await page.screenshot({path:path.join(dir,'carryover-blocked.png'),fullPage:true});
    await page.locator('#wo-carry-close').click();forceBlocked=false;
    await page.evaluate(()=>DBMTWorkOrderCarryover.open('work-500'));await page.waitForSelector('#wo-carry-dialog tr[data-source]');
    assert.equal(await page.locator('#wo-carry-save').isDisabled(),false,'A fresh eligible dialog enables saving again');
    await page.screenshot({path:path.join(dir,'carryover-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(dir,'carryover-mobile.png'),fullPage:true});
    console.log('PASS: manual carry quantities; 150 cap independent of 300 output; box-before-KG; rejection retains values; delayed confirmation; lost-response close/reopen UUID retry; no duplicate; draft preserved; history links; locked carry sources; all-consumed explanation; desktop/mobile dialog');
    console.log('Artifacts: '+dir);
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
