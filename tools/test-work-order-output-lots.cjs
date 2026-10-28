/* Isolated ERP fixtures and local label page. No production reads/writes or printer jobs. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const {setOuter}=require('./label-touch-test-helpers.cjs');
const repo=path.resolve(__dirname,'..'),index=fs.readFileSync(path.join(repo,'index.html'),'utf8');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-workorders-'));
for(const name of ['index.html','label-print.html'])for(const match of fs.readFileSync(path.join(repo,name),'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1],{filename:name});
new vm.Script(fs.readFileSync(path.join(repo,'label-weight.js'),'utf8'));
const block=(start,end)=>index.slice(index.indexOf(start),index.indexOf(end,index.indexOf(start)));
const source=name=>{const match=index.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));assert(match,name);return match[0]};
const server=http.createServer((req,res)=>{
  const file=path.resolve(repo,new URL(req.url,'http://localhost').pathname.slice(1)||'label-print.html');
  if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<main></main>'}));
    await page.goto(base+'/fixture');
    await page.evaluate(html=>{
      const template=document.createElement('template');template.innerHTML=html;
      for(const id of ['p-workorders','p-label','txn-product-picker-modal','txn-stock-picker-modal'])document.body.append(template.content.querySelector('#'+id));
      document.getElementById('p-workorders').classList.add('active');
    },index);
    await page.addStyleTag({content:fs.readFileSync(path.join(repo,'styles/main.css'),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(repo,'label-weight.js'),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(repo,'label-product-selection.js'),'utf8')});
    await page.addScriptTag({content:`
      const STOCK_LOCATION_DEFAULT='가공장';let workOrders=[];
      const labelProducts=[{id:'raw',name:'돈등심 원료',kind:'원료육',brand:'원료',origin:'국내산'},
        {id:'prod-a',name:'냉장돈등심(치즈용)',kind:'제품',brand:'A',origin:'국내산',meattype:'돼지고기',storage:'냉장',shelfdays:30,itemno:'202502930935',grade:'1',packunit:'5KG'},
        {id:'prod-b',name:'냉장돈등심(치즈용)',kind:'제품',brand:'B',origin:'국내산',meattype:'돼지고기',storage:'냉장',shelfdays:30,itemno:'202502930936',grade:'2',packunit:'10KG'}];
      let stocks=[{key:'raw-1',product:'돈등심 원료',lot:'LOT-111',origin:'국내산',stock:100,stockBoxes:12,price:5000,stockLocation:'가공장',brand:'원료',grade:'1',factoryNo:'F1'},
        {key:'raw-2',product:'돈등심 원료',lot:'LOT-222',origin:'국내산',stock:155,stockBoxes:15,price:6000,stockLocation:'가공장',stockRowId:'qa-source-row',stockNote:'가상 거래처 / 5mm'},
        {key:'raw-3',product:'돈등심 원료',lot:'LOT-333',origin:'국내산',stock:80,price:5000,stockLocation:'외부창고'},
        {key:'raw-4',product:'돈등심 원료',lot:'LOT-444',origin:'국내산',stock:33.33,stockBoxes:null,price:5000,stockLocation:'가공장'},
        {key:'raw-5',product:'돈등심 원료',lot:'LOT-555',origin:'국내산',stock:8,stockBoxes:0,price:5000,stockLocation:'가공장'}];
      const LBL_DEFAULTS={};window.calls=[];window.alerts=[];window.alert=message=>alerts.push(message);
      const htmlEscape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const jsArg=v=>htmlEscape(JSON.stringify(v)),priceKey=v=>String(v??'').replace(/\\s/g,'').toLowerCase();
      const bulkOutboundSearchKey=priceKey,bulkOutboundIdentityKey=priceKey,stockLocationKey=priceKey;
      const samePriceText=(a,b)=>priceKey(a)===priceKey(b),sameOriginText=samePriceText;
      const normalizeOriginName=v=>v||'',normalizeStockLocation=v=>v||STOCK_LOCATION_DEFAULT;
      const labelProductSearchText=p=>Object.values(p).join(' '),bulkOutboundSearchText=labelProductSearchText,bulkOutboundStockLabel=labelProductSearchText;
      const bulkOutboundStockOptions=()=>stocks,getTxnStockSearchOptions=()=>stocks;
      const parseAppNumber=v=>Number(v)||0,localDateString=()=> '2026-09-10',nationalPartNameForCode=()=>'',normalizeLabelProductTaxType=()=> '면세';
      ${source('parseOptionalBoxCount')}
      ${source('boxCountDisplay')}
      ${source('totalRecordedBoxes')}
      const inferLabelMeatType=()=> '돼지고기',labelCrossFacilityNoticeFromText=()=> '본 제품은 소고기를 사용한 제품과 같은 제조시설에서 제조하고 있습니다';
      const fmtLblDate=v=>v,buildLabelBody=d=>'<div>'+htmlEscape(d.product)+' / '+htmlEscape(d.weight)+'</div>';
      const labelSizeConfigByKey=()=>({widthCm:7,previewW:264,previewH:378,scale:1,label:'7x10'});
      const workOrderId=()=> 'qa-workorder',toast=()=>{},showPage=()=>{};
      ${block('window.workOrderEditVersion=null;','function inferLabelMeatType(')}
      window.DBMTWorkOrders={versionFor:()=> 'fixture-version',refresh:()=>Promise.resolve(),write:async row=>{
        const i=workOrders.findIndex(item=>item.id===row.id);if(i<0)workOrders.unshift(row);else workOrders[i]=row;renderWorkOrders();
      }};
      const getPriceFromLot=()=>5000;
      const selectProdInputStock=(...args)=>calls.push(['production-stock',...args]),selectProdOutProduct=(...args)=>calls.push(['production-product',...args]);
      const selectBulkProduct=(input,id)=>calls.push(['bulk-product',id]),selectBulkOutboundStock=(input,key)=>calls.push(['bulk-stock',key]),selectTxnStock=key=>calls.push(['transaction-stock',key]);
      const selectManagedProduct=id=>{calls.push(['transaction-product',id]);closeTxnProductPicker(false);};
      const updateLabelPreview=()=>updateSelectedWorkOrderLabelPreview(),printLabelData=(...args)=>calls.push(['erp-print',...args]);
      ${block("let txnProductPickerKind =",'function handleManagedProductInputKeydown(')}
      ${block('let txnStockPickerRows =','function selectTxnStock(')}
${block('function workOrderSourceInputs(order){','// 📦 품목관리 (labelProducts)')}
      initWorkOrderForm();
    `});

    await page.addScriptTag({content:fs.readFileSync(path.join(repo,'label-lots.js'),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(repo,'work-order-output-lots.js'),'utf8')});
    await page.addStyleTag({content:fs.readFileSync(path.join(repo,'styles/work-order-output-lots.css'),'utf8')});
    await page.evaluate(()=>{
      selectWorkOrderLabelProduct('prod-a');
      for(const key of ['raw-1','raw-2','raw-4','raw-5']){
        const input=workOrderSourceRows().at(-1).querySelector('.wo-stock-search');selectWorkOrderStock(key,input);if(key!=='raw-5')addWorkOrderSourceRow();
      }
    });
    assert.equal(await page.locator('.wo-source-row').count(),4);
    assert.equal(await page.locator('[data-wo-output-index]').count(),1,'Additional raw LOTs are not silently added for printing');
    await page.locator('#wo-output-lot-add').click();await page.locator('#wo-output-lot-add').click();
    assert(await page.locator('#wo-output-lot-add').isDisabled());
    await page.locator('[data-wo-output-default="1"]').check();
    const row=await page.evaluate(()=>collectWorkOrderForm());
    assert.deepEqual(row.outputLots,['LOT-111','LOT-222','LOT-444']);assert.equal(row.defaultOutputLot,'LOT-222');
    assert.equal(row.lot,'LOT-222');assert.equal(row.sourceInputs.length,4);assert.equal(row.inputWeight,296.33);
    assert.equal(await page.evaluate(()=>collectWorkOrderFormForPreview().lot),'LOT-111','Preview always uses the first raw LOT, independently of default');
    await page.evaluate(()=>saveWorkOrder());await page.evaluate(()=>editWorkOrder('qa-workorder'));
    assert.equal(await page.locator('[data-wo-output-index]').count(),3);assert(await page.locator('[data-wo-output-default="1"]').isChecked());
    await page.evaluate(()=>{workOrderSourceRows()[0].querySelector('.wo-input-weight').value='60';updateWorkOrderInputTotal();});
    assert.match(await page.locator('.wo-output-lot-row').first().textContent(),/60/);
    await page.evaluate(()=>{const legacy={...workOrders[0],id:'legacy',lot:'OLD-LOT'};for(const k of ['outputLotSelectionVersion','outputLots','defaultOutputLot'])delete legacy[k];workOrders.push(legacy);editWorkOrder('legacy');});
    const legacy=await page.evaluate(()=>collectWorkOrderForm());assert.equal(legacy.lot,'OLD-LOT');assert(!('outputLotSelectionVersion' in legacy));
    await page.locator('#wo-output-lot-add').click();assert.equal((await page.evaluate(()=>collectWorkOrderForm())).outputLotSelectionVersion,1);
    await page.evaluate(()=>{editWorkOrder('qa-workorder');document.getElementById('wo-list-date').value='2026-09-10';renderWorkOrders();});
    assert.match(await page.locator('#wo-list-wrap').textContent(),/LOT-111/);
    await page.locator('#p-workorders').screenshot({path:path.join(artifacts,'output-lots-office.png')});
    await page.close();

    const context=await browser.newContext({viewport:{width:1280,height:1024}}),label=await context.newPage(),errors=[];
    let outer=[],inner=[],fail=false;
    const order={...row,id:'kiosk',sourceStock:row.sourceInputs[0].sourceStock};
    const innerReply=body=>{
      const active=inner.filter(r=>r.status!=='void'),totals=order.outputLots.map(lot=>({lot,count:active.filter(r=>r.lot===lot).length,weight:active.filter(r=>r.lot===lot).reduce((n,r)=>n+r.labelWeight,0)}));
      return {ok:true,workOrderId:order.id,totals,logs:inner.filter(r=>!body.p_lot||r.lot===body.p_lot),nextBeforeId:null};
    };
    await context.route('https://**/*',async route=>{
      const name=route.request().url().split('/').pop(),body=route.request().postDataJSON();let data={};
      if(name==='dbmt_label_print_get_data')data={appData:{workOrders:[order],labelProducts:[],labelPrintLogs:outer},completions:[]};
      if(name==='dbmt_label_inner_prints')data=innerReply(body);
      if(name==='dbmt_label_save_inner_prints'||name==='dbmt_label_print_save_logs'){
        if(fail){await route.fulfill({status:400,body:JSON.stringify({message:'QA save failure'})});return;}
        const target=name==='dbmt_label_save_inner_prints'?inner:outer;
        for(const log of body.p_logs){const i=target.findIndex(r=>r.id===log.id);if(i<0)target.push(log);else target[i]=log;}
        data=name==='dbmt_label_save_inner_prints'?innerReply(body):{ok:true,logs:outer,completions:[]};
      }
      await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    await context.route('**/label-scale.js?*',route=>route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(repo,'label-scale.js'),'utf8')+`;DBMTScale.create=()=>({status:()=>({value:3.45,ready:true,message:'QA scale',connecting:false,connected:true}),connect:async()=>{},disconnect:async()=>{}});`}));
    await context.addInitScript(()=>{window.__prints=[];window.print=()=>{if(parent!==window){parent.__prints.push([...document.querySelectorAll('.print-label')].map(e=>e.textContent));setTimeout(()=>dispatchEvent(new Event('afterprint')),0);}};});
    label.on('pageerror',e=>errors.push(e.message));label.on('dialog',d=>d.accept());
    await label.goto(base+'/label-print.html');await label.locator('#app-password').fill('0000');await label.locator('#connect-btn').click();
    await label.waitForFunction(()=>!state.loading&&state.workOrders.length&&document.querySelectorAll('[data-output-lot]').length===3);
    assert.equal(await label.evaluate(()=>DBMTLabelTouch.printOrder().lot),'LOT-222');
    for(const kind of ['inner','outer'])for(const mode of ['fixed','scale'])assert.equal(await label.locator(`[data-package="${kind}"] [data-mode="${mode}"]`).count(),1);
    const edit=async(kind,field,n)=>{await label.locator(`#${kind}-${field}-btn`).click();await label.locator('#number-input').fill(String(n));await label.locator('#number-apply').click();};
    const wait=()=>label.waitForFunction(()=>!state.loading);
    await edit('outer','weight',20);await label.locator('#print-btn').click();await wait();const original=JSON.stringify(outer[0]);
    await label.locator('[data-output-lot="LOT-111"]').click();await edit('inner','weight',1);await edit('inner','copies',2);
    await label.locator('#inner-print-btn').click();await wait();assert.equal(inner.length,2);assert(inner.every(l=>l.lot==='LOT-111'&&l.packageKind==='inner'&&l.code.startsWith('IN')));
    assert.equal(outer.length,1);assert.equal(await label.locator('#metric-output').textContent(),'20 kg');
    assert.match(await label.locator('#output-lot-rows tr').first().textContent(),/2장 \/ 2 KG/);
    await label.locator('#print-btn').click();await wait();assert.equal(outer[1].lot,'LOT-111');assert.equal(JSON.stringify(outer[0]),original);
    await label.locator('[data-output-lot="LOT-444"]').click();await label.locator('[data-package="outer"] [data-mode="scale"]').click();
    await label.evaluate(()=>{document.getElementById('scale-value').textContent='3.45';DBMTLabelTouch.sync();});
    await label.waitForFunction(()=>DBMTLabelTouch.weight('outer')===3.45);await label.locator('#print-btn').click();await wait();assert.equal(outer.at(-1).labelWeight,3.45);assert.equal(outer.at(-1).lot,'LOT-444');
    await label.locator('[data-inner-detail="LOT-111"]').click();await label.locator('[data-inner-action="reprint"]').first().click();await wait();assert.equal(inner.length,2);assert.match(await label.locator('#inner-lot-history-status').textContent(),/재출력/);
    await label.locator('[data-inner-action="void"]').first().click();await wait();assert.equal(inner.filter(r=>r.status!=='void').length,1);await label.locator('#inner-lot-close').click();
    assert.match(await label.locator('#output-lot-rows tr').first().textContent(),/1장 \/ 1 KG/);
    fail=true;const printCount=await label.evaluate(()=>__prints.length);await label.locator('#inner-print-btn').click();await wait();assert.equal(await label.evaluate(()=>__prints.length),printCount);assert.match(await label.locator('#status').textContent(),/保存|저장 실패/);fail=false;
    await label.evaluate(()=>setStatus('연결됨','ok'));
    const layout=await label.evaluate(()=>{const r=document.querySelector('.right');return {scroll:r.scrollHeight-r.clientHeight,buttons:[...document.querySelectorAll('.pack-actions button,#complete-production-btn')].filter(e=>e.getClientRects().length).map(e=>({id:e.id,bottom:e.getBoundingClientRect().bottom})),height:innerHeight};});
    assert(layout.scroll<=2,JSON.stringify(layout));assert(layout.buttons.every(b=>b.bottom<layout.height),JSON.stringify(layout));
    await label.screenshot({path:path.join(artifacts,'output-lots-kiosk-1280.png'),fullPage:true});
    await label.setViewportSize({width:1280,height:900});assert(await label.locator('.right').evaluate(e=>e.scrollHeight<=e.clientHeight+1),'Three LOTs fit an operator window with browser/taskbar visible');
    for(const [width,height] of [[1024,768],[736,620],[360,640]]){await label.setViewportSize({width,height});assert(!(await label.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)),`horizontal overflow ${width}`);}
    assert.deepEqual(errors,[]);console.log('PASS: office raw selection/max3/default/preview-first/legacy/date list; kiosk fixed+scale per LOT; inner separate/reprint/void/failure; immutable outer barcodes; 3-LOT 1280x1024 layout.');console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
