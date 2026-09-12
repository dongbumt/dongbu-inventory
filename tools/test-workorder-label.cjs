/* Isolated ERP fixtures and local label page. No production reads/writes or printer jobs. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),index=fs.readFileSync(path.join(repo,'index.html'),'utf8');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-workorders-'));
for(const name of ['index.html','label-print.html'])for(const match of fs.readFileSync(path.join(repo,name),'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1],{filename:name});
new vm.Script(fs.readFileSync(path.join(repo,'label-weight.js'),'utf8'));
const block=(start,end)=>index.slice(index.indexOf(start),index.indexOf(end,index.indexOf(start)));
const server=http.createServer((req,res)=>{
  const file=path.resolve(repo,new URL(req.url,'http://localhost').pathname.slice(1)||'label-print.html');
  if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(file));
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
    await page.addScriptTag({content:`
      const STOCK_LOCATION_DEFAULT='가공장';let workOrders=[];
      const labelProducts=[{id:'raw',name:'돈등심 원료',kind:'원료육',brand:'원료',origin:'국내산'},
        {id:'prod-a',name:'냉장돈등심(치즈용)',kind:'제품',brand:'A',origin:'국내산',meattype:'돼지고기',storage:'냉장',shelfdays:30,itemno:'202502930935',grade:'1',packunit:'5KG'},
        {id:'prod-b',name:'냉장돈등심(치즈용)',kind:'제품',brand:'B',origin:'국내산',meattype:'돼지고기',storage:'냉장',shelfdays:30,itemno:'202502930936',grade:'2',packunit:'10KG'}];
      let stocks=[{key:'raw-1',product:'돈등심 원료',lot:'LOT-111',origin:'국내산',stock:100,price:5000,stockLocation:'가공장',brand:'원료',grade:'1',factoryNo:'F1'},
        {key:'raw-2',product:'돈등심 원료',lot:'LOT-222',origin:'국내산',stock:55,price:6000,stockLocation:'가공장',stockRowId:'qa-source-row',stockNote:'가상 거래처 / 5mm'},
        {key:'raw-3',product:'돈등심 원료',lot:'LOT-333',origin:'국내산',stock:80,price:5000,stockLocation:'외부창고'}];
      const LBL_DEFAULTS={};window.calls=[];window.alerts=[];window.alert=message=>alerts.push(message);
      const htmlEscape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const jsArg=v=>htmlEscape(JSON.stringify(v)),priceKey=v=>String(v??'').replace(/\\s/g,'').toLowerCase();
      const bulkOutboundSearchKey=priceKey,bulkOutboundIdentityKey=priceKey,stockLocationKey=priceKey;
      const samePriceText=(a,b)=>priceKey(a)===priceKey(b),sameOriginText=samePriceText;
      const normalizeOriginName=v=>v||'',normalizeStockLocation=v=>v||STOCK_LOCATION_DEFAULT;
      const labelProductSearchText=p=>Object.values(p).join(' '),bulkOutboundSearchText=labelProductSearchText,bulkOutboundStockLabel=labelProductSearchText;
      const bulkOutboundStockOptions=()=>stocks,getTxnStockSearchOptions=()=>stocks;
      const parseAppNumber=v=>Number(v)||0,localDateString=()=> '2026-09-10',nationalPartNameForCode=()=>'',normalizeLabelProductTaxType=()=> '면세';
      const inferLabelMeatType=()=> '돼지고기',labelCrossFacilityNoticeFromText=()=> '본 제품은 소고기를 사용한 제품과 같은 제조시설에서 제조하고 있습니다';
      const fmtLblDate=v=>v,buildLabelBody=d=>'<div>'+htmlEscape(d.product)+' / '+htmlEscape(d.weight)+'</div>';
      const labelSizeConfigByKey=()=>({previewW:264,previewH:378,scale:1,label:'7x10'});
      const workOrderId=()=> 'qa-workorder',saveWorkOrdersStore=()=>{},toast=()=>{},showPage=()=>{};
      const getPriceFromLot=()=>5000;
      const selectProdInputStock=(...args)=>calls.push(['production-stock',...args]),selectProdOutProduct=(...args)=>calls.push(['production-product',...args]);
      const selectBulkProduct=(input,id)=>calls.push(['bulk-product',id]),selectBulkOutboundStock=(input,key)=>calls.push(['bulk-stock',key]),selectTxnStock=key=>calls.push(['transaction-stock',key]);
      const selectManagedProduct=id=>{calls.push(['transaction-product',id]);closeTxnProductPicker(false);};
      const updateLabelPreview=()=>updateSelectedWorkOrderLabelPreview(),printLabelData=(...args)=>calls.push(['erp-print',...args]);
      ${block("let txnProductPickerKind =",'function handleManagedProductInputKeydown(')}
      ${block('let txnStockPickerRows =','function selectTxnStock(')}
      ${block('function initWorkOrderForm(){','// 📦 품목관리 (labelProducts)')}
      initWorkOrderForm();
    `});
    const openStock=()=>page.locator('#p-workorders button[onclick="openWorkOrderStockPicker()"]').click();
    await openStock();assert.equal(await page.locator('#tsp-result-head th').count(),10);assert.equal(await page.locator('#tsp-result-body tr').count(),2);
    await page.locator('#tsp-search-lot').fill('111');await page.locator('#tsp-result-body tr').dblclick();
    assert.equal(await page.locator('#wo-stock-key').inputValue(),'raw-1');assert.equal(await page.locator('#wo-lot').inputValue(),'LOT-111');
    await openStock();await page.locator('#tsp-search-lot').fill('222');await page.locator('#tsp-search-lot').press('Enter');
    assert.equal(await page.locator('#wo-lot').inputValue(),'LOT-222');
    await openStock();await page.locator('#txn-stock-picker-modal').screenshot({path:path.join(artifacts,'stock-picker.png')});await page.locator('#tsp-search-all').press('Escape');
    assert.equal(await page.locator('#wo-stock-key').inputValue(),'raw-2');
    await page.locator('#wo-product').press('F4');assert.equal(await page.locator('#tpp-kind-product').getAttribute('aria-pressed'),'true');
    await page.locator('#tpp-search-brand').selectOption('B');await page.locator('#txn-product-picker-modal').screenshot({path:path.join(artifacts,'product-picker.png')});
    await page.locator('#tpp-result-body tr').dblclick();assert.equal(await page.locator('#wo-label-product-id').inputValue(),'prod-b');
    assert.equal(await page.locator('#wo-itemno').inputValue(),'202502930936');assert.equal(await page.locator('#wo-temptype').inputValue(),'냉장');
    assert.equal(await page.locator('#wo-lot').inputValue(),'LOT-222');
    await page.locator('#wo-input-weight').fill('100');await page.evaluate(()=>saveWorkOrder());
    const order=await page.evaluate(()=>workOrders[0]);assert.equal(order.weight,0);assert.equal(order.labelProductId,'prod-b');assert.equal(order.sourceStock.key,'raw-2');assert.equal(order.sourceStock.stockRowId,'qa-source-row');assert.equal(order.sourceStock.stockNote,'가상 거래처 / 5mm');
    assert.deepEqual(await page.evaluate(()=>alerts),[],'Work order should save without label weight');
    await page.evaluate(()=>{editWorkOrder('qa-workorder');stocks=[];});
    assert.equal((await page.evaluate(()=>collectWorkOrderForm())).sourceStock.key,'raw-2','Keep historical source snapshot when stock is depleted');
    await page.evaluate(()=>{stocks=[workOrders[0].sourceStock];});
    await page.locator('#wo-stock-search').fill('다른 원료');assert.equal(await page.locator('#wo-stock-key').inputValue(),'');
    await page.locator('#wo-product').fill('다른 제품');assert.equal(await page.locator('#wo-label-product-id').inputValue(),'');
    await page.evaluate(()=>{
      const input=document.createElement('input');input.dataset.pickerContext='production-input';input.dataset.productionRowId='1';document.body.append(input);
      openTxnStockPicker('',input);confirmTxnStockPicker();
      input.dataset.pickerContext='production-output';openTxnProductPicker('',input);confirmTxnProductPicker();
      input.dataset.pickerContext='';openTxnStockPicker('',input);confirmTxnStockPicker();openTxnProductPicker('',input);confirmTxnProductPicker();
      openTxnStockPicker('');confirmTxnStockPicker();openTxnProductPicker('');confirmTxnProductPicker();
    });
    assert.deepEqual(await page.evaluate(()=>calls.map(c=>c[0])),['production-stock','production-product','bulk-stock','bulk-product','transaction-stock','transaction-product']);
    await page.evaluate(()=>{document.getElementById('p-workorders').classList.remove('active');document.getElementById('p-label').classList.add('active');document.getElementById('lbl-workorder-date').value='2026-09-10';refreshLabelWorkOrderSelect();printSelectedWorkOrderLabel();});
    assert.equal((await page.evaluate(()=>calls.filter(c=>c[0]==='erp-print'))).length,0);
    await page.locator('#lbl-weight').selectOption('10');await page.evaluate(()=>printSelectedWorkOrderLabel());
    assert.equal((await page.evaluate(()=>calls.find(c=>c[0]==='erp-print')))[1].weight,'10.00');
    console.log('PASS: workorder popup selection, lot changes, optional weight, source snapshot, shared picker regression, ERP label weight');

    const context=await browser.newContext({viewport:{width:1366,height:900}});const saved=[];let failSave=false;
    await context.addInitScript(()=>{window.print=()=>{};});
    await context.route('https://**/*',async route=>{
      if(route.request().url().endsWith('/dbmt_label_print_save_logs')){
        if(failSave){await route.fulfill({status:500,contentType:'application/json',body:'{"message":"mock save failure"}'});return;}
        saved.push(route.request().postDataJSON());await route.fulfill({contentType:'application/json',body:'{"ok":true}'});return;
      }
      await route.abort();
    });
    const label=await context.newPage();await label.goto(base+'/label-print.html');
    await label.evaluate(order=>{state.pin='mock-pin';state.workOrders=[order,{...order,id:'legacy',product:'기존 작업',weight:7.25}];state.selectedId=order.id;state.allDates=true;renderAll();},order);
    await label.locator('#print-btn').click();assert.equal(saved.length,0);assert.match(await label.locator('#status').textContent(),/중량/);
    await label.locator('#print-weight').selectOption('5');await label.locator('#print-copies').fill('2');
    let event=label.waitForEvent('popup');await label.locator('#preview-btn').click();let popup=await event;await popup.waitForSelector('.print-label');assert.match(await popup.locator('.print-label').textContent(),/5\.00/);await popup.close();assert.equal(saved.length,0);
    event=label.waitForEvent('popup');await label.locator('#print-btn').click();popup=await event;await popup.waitForSelector('.print-label');assert.equal(await popup.locator('.print-label').count(),2);await popup.close();
    assert.equal(saved[0].p_logs.length,2);assert.ok(saved[0].p_logs.every(log=>log.labelWeight===5&&log.workOrderSnapshot.weight===5));
    assert.equal(await label.locator('#metric-output').textContent(),'10 kg');assert.equal(await label.locator('#metric-yield').textContent(),'10.0%');
    assert.equal(await label.evaluate(()=>state.workOrders[0].weight),0,'Printing must not mutate workorder weight');
    await label.locator('#print-weight').selectOption('custom');await label.locator('#print-weight-custom').fill('7.35');await label.locator('#print-copies').fill('1');
    await label.evaluate(()=>renderAll());assert.equal(await label.locator('#print-weight-custom').inputValue(),'7.35');
    event=label.waitForEvent('popup');await label.locator('#print-btn').click();popup=await event;await popup.waitForSelector('.print-label');assert.match(await popup.locator('.print-label').textContent(),/7\.35/);await popup.close();
    assert.equal(saved[1].p_logs[0].labelWeight,7.35);assert.equal(await label.locator('#metric-output').textContent(),'17.35 kg');
    const firstId=saved[0].p_logs[0].id;await label.locator('#print-weight').selectOption('20');
    event=label.waitForEvent('popup');await label.evaluate(id=>reprintLog(id),firstId);popup=await event;await popup.waitForSelector('.print-label');assert.match(await popup.locator('.print-label').textContent(),/5\.00/);await popup.close();
    assert.equal(await label.locator('#metric-output').textContent(),'17.35 kg');
    await label.evaluate(()=>selectOrder('legacy'));assert.equal(await label.locator('#print-weight').inputValue(),'7.25');
    await label.evaluate(()=>selectOrder('qa-workorder'));assert.equal(await label.locator('#print-weight').inputValue(),'','No weight carryover between jobs');
    await label.locator('#print-weight').selectOption('custom');
    for(const invalid of ['', '0','-1','1.234']){await label.locator('#print-weight-custom').fill(invalid);const count=saved.length;await label.locator('#print-btn').click();assert.equal(saved.length,count);}
    failSave=true;await label.locator('#print-weight-custom').fill('3.75');const count=await label.evaluate(()=>state.logs.length);
    event=label.waitForEvent('popup');await label.locator('#print-btn').click();popup=await event;await label.waitForFunction(()=>!state.loading);assert.equal(await label.evaluate(()=>state.logs.length),count);assert.equal(popup.isClosed(),true);
    await label.screenshot({path:path.join(artifacts,'label-weight.png'),fullPage:true});
    console.log('PASS: selected/custom/legacy weights, preview, logs, mixed-weight totals, immutable reprints, invalid values, failed-save rollback');
    console.log(`Artifacts: ${artifacts}`);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
