// Actual ERP panels and modules; all RPCs and printing are intercepted.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(repo,'index.html'),'utf8'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-ledgers-'));
const auth=fs.readFileSync(path.join(repo,'m02-auth.js'),'utf8');
assert.match(auth,/'nav-customer-ledger':'customer_ledger'/);assert.match(auth,/'nav-product-ledger':'product_ledger'/);assert.match(auth,/DBMTLedgers\.applyPermissions\(\)/);
const snapshot={ok:true,loadedAt:'2026-11-12T08:00:00Z',partners:[{id:'party',code:'BP001',name:'테스트 거래처',aliases:['이전 거래처']}],products:[{id:'raw',name:'원료육',brand:'SWIFT',origin:'미국산'},{id:'finished',name:'생산품(작업)',brand:'IBP',origin:'미국산',packunit:'5KG'}],
 transactions:[{id:'in',date:'2026-11-01',type:'입고',trader:'이전 거래처',product:'원료육',labelProductId:'raw',stockRowId:'raw-stock',origin:'미국산',lot:'RAW-LOT',weight:100,boxCount:10,price:10,amount:1000},
 {id:'use',date:'2026-11-02',type:'사용',product:'원료육',stockRowId:'raw-stock',origin:'미국산',lot:'RAW-LOT',weight:20,boxCount:2,price:10,amount:200,_prodId:'p'},
 {id:'prod',date:'2026-11-02',type:'생산입고',product:'생산품(작업)',labelProductId:'finished',stockRowId:'finished-stock',origin:'미국산',packunit:'5KG',lot:'FINISHED-LOT',weight:8,boxCount:2,price:100,amount:800,_prodId:'p'},
 {id:'sale',date:'2026-11-03',type:'출고',trader:'테스트 거래처',product:'생산품(작업)',labelProductId:'finished',stockRowId:'finished-stock',origin:'미국산',packunit:'5KG',lot:'FINISHED-LOT',weight:2,boxCount:1,price:750,amount:1500,note:'작업 스펙'}],
 production:[{id:'p',date:'2026-11-02',job_no:'7',job_type:'생산',note:'생산일보 비고'}],accounts:[],entries:[]};
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="ko"><meta charset="utf-8"><body></body></html>');});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:1366,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(markup=>{
   const t=document.createElement('template');t.innerHTML=markup;
   const header=t.content.querySelector('.app-header'),nav=t.content.querySelector('.nav-tabs');
   nav.querySelector('[data-nav-group="inventory"]').classList.add('open','active-group');
   const body=document.createElement('div');body.className='app-body';body.append(nav);const main=document.createElement('main');main.className='main';body.append(main);
   for(const id of ['p-customer-ledger','p-product-ledger'])main.append(t.content.querySelector('#'+id));document.body.append(header,body);
  },html);
  for(const file of ['styles/main.css','styles/m02-access-control.css','styles/ledgers.css'])await page.addStyleTag({content:fs.readFileSync(path.join(repo,file),'utf8')});
  await page.evaluate(seed=>{
   window.control={token:'qa-token',view:true,write:true,failSave:false,failRead:false,throwAfterSave:false,delay:20,remote:seed,calls:[],prints:[]};
   window.DBMTAuth={getSessionToken:()=>control.token,isPersonal:()=>!!control.token,can:(m,a)=>a==='view'?control.view:control.write,canOpenPage:()=>true};
   window.sbRpc=async(name,args)=>{
    control.calls.push({name,args});await new Promise(r=>setTimeout(r,control.delay));
    if(name==='dbmt_erp_get_ledger_snapshot'){if(control.failRead)throw Error('read failed');return structuredClone(control.remote);}
    if(control.failSave)throw Error('save failed');
    if(name==='dbmt_erp_save_ledger_account'){
     const old=control.remote.accounts.find(a=>a.partner_id===args.p_partner);if((old?.revision??null)!==args.p_revision)throw Error('다른 PC에서 변경');
     const account={partner_id:args.p_partner,opening_date:args.p_date,opening_ar:args.p_ar,opening_ap:args.p_ap,revision:(old?.revision||0)+1};control.remote.accounts=[account];return {ok:true,account};
    }
    if(name==='dbmt_erp_save_ledger_entry'){
     const old=control.remote.entries.find(e=>e.id===args.p_id);const entry={id:args.p_id,partner_id:args.p_partner,date:args.p_date,kind:args.p_kind,amount:args.p_amount,note:args.p_note,revision:old?(args.p_revision==null?old.revision:old.revision+1):1};
     control.remote.entries=control.remote.entries.filter(e=>e.id!==entry.id).concat(entry);
     if(control.throwAfterSave){control.throwAfterSave=false;throw Error('lost network response');}return {ok:true,entry};
    }
    if(name==='dbmt_erp_delete_ledger_entry'){control.remote.entries=control.remote.entries.filter(e=>e.id!==args.p_id);return {ok:true,id:args.p_id};}
    throw Error('Unexpected RPC '+name);
   };
   window.showPage=(id,button)=>{document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.id===id));document.querySelectorAll('.nav-tab').forEach(p=>p.classList.toggle('active',p===button));return DBMTLedgers.init(id==='p-customer-ledger'?'customer':'product');};
   window.confirm=()=>true;window.open=()=>({closed:false,opener:null,document:{write:html=>control.prints.push(html),close:()=>{}},focus:()=>{},print:()=>{}});
  },snapshot);
  for(const file of ['stock-ledger.js','ledger-model.js','ledgers.js'])await page.addScriptTag({content:fs.readFileSync(path.join(repo,file),'utf8')});
  await page.locator('#nav-customer-ledger').click();await page.waitForFunction(()=>!document.querySelector('#cl-entity').disabled);
  await page.locator('#cl-from').fill('2026-11-01');await page.locator('#cl-to').fill('2026-11-12');
  await page.locator('#cl-entity').fill('테스트');await page.locator('#cl-suggestions button').click();
  assert.match(await page.locator('#cl-message').textContent(),/기초잔액 미등록/);assert.match(await page.locator('#cl-totals').textContent(),/500원/);
  await page.locator('#cl-finance summary').click();await page.locator('#cl-opening-ar').fill('500');await page.locator('#cl-opening-ap').fill('200');await page.locator('#cl-entry-amount').fill('100');
  await page.locator('[data-ledger-action="save-account"]').click();await page.waitForFunction(()=>document.querySelector('#cl-message').textContent.includes('서버 저장을 완료'));
  assert.equal(await page.locator('#cl-entry-amount').inputValue(),'100','saving opening balance preserves the separate cash draft');assert.match(await page.locator('#cl-totals').textContent(),/800원/);
  await page.evaluate(()=>control.throwAfterSave=true);await page.locator('[data-ledger-action="save-entry"]').click();await page.waitForFunction(()=>document.querySelector('#cl-message').textContent.includes('lost network response'));
  assert.equal(await page.locator('#cl-entry-amount').inputValue(),'100');
  await page.locator('[data-ledger-action="save-entry"]').click();await page.waitForFunction(()=>document.querySelector('#cl-entry-amount').value==='');
  assert.equal(await page.evaluate(()=>control.remote.entries.length),1);assert.match(await page.locator('#cl-totals').textContent(),/700원/);
  const requests=await page.evaluate(()=>control.calls.filter(c=>c.name==='dbmt_erp_save_ledger_entry'));
  assert.equal(requests[0].args.p_id,requests[1].args.p_id,'same UUID on network retry');
  await page.locator('#cl-finance summary').click();
  await page.locator('[data-ledger-row="sale"] button').click();assert.match(await page.locator('#cl-detail').textContent(),/FINISHED-LOT.*작업 스펙/);
  await page.locator('#p-customer-ledger [data-ledger-action="print"]').click();assert.match(await page.evaluate(()=>control.prints.at(-1)),/size:A4 landscape/);
  const safe=await page.evaluate(()=>({transactions:control.remote.transactions,production:control.remote.production}));assert.deepEqual(safe.transactions,snapshot.transactions);assert.deepEqual(safe.production,snapshot.production);
  await page.locator('#nav-product-ledger').click();await page.waitForFunction(()=>!document.querySelector('#pl-entity').disabled);
  await page.locator('#pl-from').fill('2026-11-01');await page.locator('#pl-to').fill('2026-11-12');
  await page.locator('#pl-entity').fill('생산품');await page.locator('#pl-suggestions button').click();
  assert.match(await page.locator('#pl-totals').textContent(),/6.00 KG/);assert.equal(await page.locator('#pl-table tbody [data-ledger-row]').count(),2);
  assert.match(await page.locator('#pl-table').textContent(),/생입/);assert.match(await page.locator('#pl-info').textContent(),/IBP/);
  await page.selectOption('#pl-lot','FINISHED-LOT');await page.locator('[data-ledger-row="prod"] button').click();assert.match(await page.locator('#pl-detail').textContent(),/생산일보 비고/);
  for(const width of [1366,1024,390]){
   await page.setViewportSize({width,height:1000});
   for(const menu of ['customer','product']){
    await page.locator('#nav-'+menu+'-ledger').click();await page.waitForFunction(p=>!document.getElementById(p+'-entity').disabled,menu==='customer'?'cl':'pl');
    const prefix=menu==='customer'?'cl':'pl';const b=await page.locator('#'+prefix+'-table').evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth}));if(width>=1024)assert.equal(b.width,b.scroll,menu+' table fit');
    await page.screenshot({path:path.join(artifacts,menu+'-'+width+'.png'),fullPage:true});
   }
  }
  await page.evaluate(()=>{control.failRead=true;});await page.locator('#p-product-ledger [data-ledger-action="query"]').first().click();await page.waitForFunction(()=>document.querySelector('#pl-message').textContent.includes('read failed'));assert.match(await page.locator('#pl-totals').textContent(),/6.00 KG/);
  await page.evaluate(()=>{control.view=false;DBMTLedgers.applyPermissions();});assert.equal(await page.locator('#pl-entity-id').inputValue(),'');assert.equal(await page.locator('#pl-totals').textContent(),'');
  assert.equal(await page.locator('#cl-entry-note').inputValue(),'');assert.deepEqual(errors,[]);
  console.log('PASS: actual vertical menus/panels, scoped snapshots, draft-safe writes/retries, accurate balances, production/LOT lookup, printing, 1366/1024/390 layouts, failed reads and permission clearing');console.log('Artifacts: '+artifacts);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
