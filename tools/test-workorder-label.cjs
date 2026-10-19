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
    const openStock=()=>page.locator('#p-workorders .wo-source-row').first().locator('button[onclick="openWorkOrderStockPicker(this)"]').click();
    const primary=page.locator('#p-workorders .wo-source-row').first();
    await openStock();assert.equal(await page.locator('#tsp-result-head th').count(),11);assert.equal(await page.locator('#tsp-result-body tr').count(),4);
    await page.locator('#tsp-search-lot').fill('111');await page.locator('#tsp-result-body tr').dblclick();
    assert.equal(await page.locator('.wo-source-row:first-child .wo-stock-key').inputValue(),'raw-1');assert.equal(await page.locator('#wo-lot').inputValue(),'LOT-111');
    assert.equal(await primary.locator('.wo-input-weight').inputValue(),'100.00');
    assert.equal(await primary.locator('.wo-input-box-count').inputValue(),'12');
    assert.match(await primary.innerText(),/투입량\(KG\)/);assert.doesNotMatch(await primary.innerText(),/예정량/);
    const boxPosition=await primary.locator('.wo-input-box-count').boundingBox(),weightPosition=await primary.locator('.wo-input-weight').boundingBox();
    assert.ok(boxPosition.x<weightPosition.x,'Optional box input must precede the weight input');
    await primary.locator('.wo-input-weight').fill('9');await primary.locator('.wo-input-box-count').fill('1');
    await openStock();await page.locator('#tsp-search-lot').fill('222');await page.locator('#tsp-search-lot').press('Enter');
    assert.equal(await page.locator('#wo-lot').inputValue(),'LOT-222');
    assert.equal(await primary.locator('.wo-input-weight').inputValue(),'155.00','Switching stock replaces an earlier manual quantity');
    assert.equal(await primary.locator('.wo-input-box-count').inputValue(),'15','Switching stock replaces an earlier manual box count');
    await primary.locator('.wo-input-weight').fill('9');await primary.locator('.wo-input-box-count').fill('1');
    await openStock();await page.locator('#tsp-search-lot').fill('222');await page.locator('#tsp-search-lot').press('Enter');
    assert.equal(await primary.locator('.wo-input-weight').inputValue(),'155.00','Reselecting the same stock restores its current full quantity');
    assert.equal(await primary.locator('.wo-input-box-count').inputValue(),'15','Reselecting the same stock restores its current full box balance');
    await openStock();await page.locator('#tsp-search-lot').fill('444');await page.locator('#tsp-search-lot').press('Enter');
    assert.equal(await primary.locator('.wo-input-weight').inputValue(),'33.33');
    assert.equal(await primary.locator('.wo-input-box-count').inputValue(),'','Unknown box balance stays unrecorded');
    await openStock();await page.locator('#tsp-search-lot').fill('555');await page.locator('#tsp-search-lot').press('Enter');
    assert.equal(await primary.locator('.wo-input-weight').inputValue(),'8.00');
    assert.equal(await primary.locator('.wo-input-box-count').inputValue(),'0','Recorded zero box balance is retained');
    await openStock();await page.locator('#tsp-search-lot').fill('222');await page.locator('#tsp-search-lot').press('Enter');
    await openStock();await page.locator('#txn-stock-picker-modal').screenshot({path:path.join(artifacts,'stock-picker.png')});await page.locator('#tsp-search-all').press('Escape');
    assert.equal(await page.locator('.wo-source-row:first-child .wo-stock-key').inputValue(),'raw-2');
    await page.locator('#wo-product').press('F4');assert.equal(await page.locator('#tpp-kind-product').getAttribute('aria-pressed'),'true');
    await page.locator('#tpp-search-brand').selectOption('B');await page.locator('#txn-product-picker-modal').screenshot({path:path.join(artifacts,'product-picker.png')});
    await page.locator('#tpp-result-body tr').dblclick();assert.equal(await page.locator('#wo-label-product-id').inputValue(),'prod-b');
    assert.equal(await page.locator('#wo-itemno').inputValue(),'202502930936');assert.equal(await page.locator('#wo-temptype').inputValue(),'냉장');
    assert.equal(await page.locator('#wo-lot').inputValue(),'LOT-222');
    await primary.locator('.wo-input-box-count').fill('');
    const optionalBoxes=await page.evaluate(()=>collectWorkOrderForm());
    assert.equal(optionalBoxes.sourceInputs[0].boxCount==null,true,'An omitted box count is never interpreted as zero');
    assert.equal(optionalBoxes.inputBoxCount,null,'Unknown per-source box counts make the overall total unknown');
    await primary.locator('.wo-input-box-count').fill('0');
    const zeroBoxes=await page.evaluate(()=>collectWorkOrderForm());assert.equal(zeroBoxes.sourceInputs[0].boxCount,0);assert.equal(zeroBoxes.inputBoxCount,0);
    for(const invalid of ['-1','1.5','16','1000000000']){
      await primary.locator('.wo-input-box-count').fill(invalid);assert.equal(await page.evaluate(()=>collectWorkOrderForm()),null,'Invalid input boxes must be rejected: '+invalid);
    }
    await page.evaluate(()=>alerts.length=0);
    await primary.locator('.wo-input-weight').fill('100');await primary.locator('.wo-input-box-count').fill('10');await page.evaluate(()=>saveWorkOrder());
    const order=await page.evaluate(()=>workOrders[0]);assert.equal(order.weight,0);assert.equal(order.labelProductId,'prod-b');assert.equal(order.sourceStock.key,'raw-2');assert.equal(order.sourceStock.stockRowId,'qa-source-row');assert.equal(order.sourceStock.stockNote,'가상 거래처 / 5mm');
    assert.equal(order.sourceStock.stockBoxes,15,'Source snapshot retains the observed stock box balance');
    assert.equal(order.sourceInputs[0].boxCount,10,'A partial manual box allocation is saved separately from full stock');
    assert.equal(order.inputBoxCount,10,'A known single-source box allocation is totaled');
    assert.deepEqual(await page.evaluate(()=>alerts),[],'Work order should save without label weight');
    await page.evaluate(()=>{editWorkOrder('qa-workorder');stocks=[];});
    assert.equal((await page.evaluate(()=>collectWorkOrderForm())).sourceStock.key,'raw-2','Keep historical source snapshot when stock is depleted');
    assert.equal(await primary.locator('.wo-input-weight').inputValue(),'100');assert.equal(await primary.locator('.wo-input-box-count').inputValue(),'10');
    assert.equal((await page.evaluate(()=>collectWorkOrderForm())).sourceInputs[0].boxCount,10);
    await page.evaluate(()=>{const legacy={...workOrders[0],id:'qa-legacy-order'};delete legacy.sourceInputs;delete legacy.inputBoxCount;workOrders.push(legacy);editWorkOrder(legacy.id)});
    assert.equal(await primary.locator('.wo-input-box-count').inputValue(),'','Editing a legacy work order does not guess boxes from its stock snapshot');
    assert.equal(await primary.locator('.wo-input-weight').inputValue(),'100');
    await page.evaluate(()=>editWorkOrder('qa-workorder'));
    await page.evaluate(()=>{stocks=[workOrders[0].sourceStock];});
    await page.locator('.wo-source-row:first-child .wo-stock-search').fill('다른 원료');assert.equal(await page.locator('.wo-source-row:first-child .wo-stock-key').inputValue(),'');
    assert.equal(await primary.locator('.wo-input-weight').inputValue(),'','Changing free search text clears the old stock weight');
    assert.equal(await primary.locator('.wo-input-box-count').inputValue(),'','Changing free search text clears the old stock boxes');
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
    console.log('PASS: workorder popup selection, full stock KG/boxes and replacement, optional unknown/zero boxes, partial edits, source snapshot, legacy edit, stale search clearing, shared picker regression, ERP label weight');

    await page.evaluate(()=>{
      document.getElementById('p-label').classList.remove('active');document.getElementById('p-workorders').classList.add('active');
      stocks=[workOrders[0].sourceStock,{key:'raw-1',product:'돈등심 원료',lot:'LOT-111',origin:'국내산',stock:100,stockBoxes:12,price:5000,stockLocation:'가공장'}];
      editWorkOrder('qa-workorder');addWorkOrderSourceRow();
      selectWorkOrderStock('raw-1',workOrderSourceRows()[1].querySelector('.wo-stock-search'));
    });
    assert.equal(await page.locator('.wo-source-row').count(),2);
    assert.equal(await page.locator('#wo-lot').inputValue(),'','Different source LOTs must not silently reuse the first LOT');
    await page.locator('.wo-source-row:nth-child(2) .wo-input-weight').fill('20');
    await page.locator('#wo-lot').fill('MIX-LOT');
    await page.locator('.wo-source-row:nth-child(2) .wo-input-box-count').fill('');
    assert.equal((await page.evaluate(()=>collectWorkOrderForm())).inputBoxCount,null,'A mixed known/unknown input total stays unrecorded');
    await page.locator('.wo-source-row:nth-child(2) .wo-input-box-count').fill('3');
    await page.evaluate(()=>saveWorkOrder());
    const multi=await page.evaluate(()=>workOrders[0]);
    assert.equal(multi.sourceInputs.length,2);
    assert.deepEqual(multi.sourceInputs.map(input=>[input.sourceStock.key,input.inputWeight]),[['raw-2',100],['raw-1',20]]);
    assert.deepEqual(multi.sourceInputs.map(input=>input.boxCount),[10,3]);
    assert.equal(multi.inputBoxCount,13,'Multiple recorded source box allocations are totaled');
    assert.equal(multi.inputWeight,120);
    assert.equal(multi.sourceStock.key,'raw-2','Legacy primary source remains available');
    assert.match(await page.locator('#wo-list-wrap').textContent(),/120\.00 KG/);
    await page.evaluate(()=>editWorkOrder('qa-workorder'));
    assert.equal(await page.locator('.wo-source-row').count(),2,'Editing restores every raw input');
    assert.deepEqual(await page.locator('.wo-input-box-count').evaluateAll(inputs=>inputs.map(input=>input.value)),['10','3']);
    await page.locator('#p-workorders').screenshot({path:path.join(artifacts,'workorder-multi.png')});
    await page.locator('.wo-source-row:nth-child(2) .wo-remove').click();
    assert.equal(await page.locator('.wo-source-row').count(),1);
    console.log('PASS: multiple raw inputs, per-source weights, explicit mixed LOT, total weight, legacy primary source, edit and remove');

    const context=await browser.newContext({viewport:{width:1366,height:900}});const saved=[];let failSave=false;
    await context.addInitScript(()=>{window.__printedLabels=[];window.print=()=>{
      if(window.parent!==window){
        window.parent.__printedLabels.push([...document.querySelectorAll('.print-label')].map(el=>el.textContent));
        setTimeout(()=>window.dispatchEvent(new Event('afterprint')),0);
      }
    };});
    await context.route('https://**/*',async route=>{
      if(route.request().url().endsWith('/dbmt_label_print_save_logs')){
        if(failSave){await route.fulfill({status:500,contentType:'application/json',body:'{"message":"mock save failure"}'});return;}
        saved.push(route.request().postDataJSON());await route.fulfill({contentType:'application/json',body:'{"ok":true}'});return;
      }
      await route.abort();
    });
    const label=await context.newPage();await label.goto(base+'/label-print.html');
    await label.evaluate(order=>{state.pin='mock-pin';state.workOrders=[order,{...order,id:'legacy',product:'기존 작업',weight:7.25}];state.selectedId=order.id;state.allDates=true;renderAll();},order);
    assert(await label.locator('#print-btn').isDisabled());await label.evaluate(()=>printSelectedLabels());assert.equal(saved.length,0);assert.match(await label.locator('#status').textContent(),/중량/);
    await setOuter(label,5,2);
    await label.locator('#preview-btn').click();const preview=label.frameLocator('#label-preview-frame');await preview.locator('.print-label').waitFor();assert.match(await preview.locator('.print-label').textContent(),/5\.00/);await label.locator('#label-preview-close').click();assert.equal(saved.length,0);
    await label.locator('#print-btn').click();await label.waitForFunction(()=>!state.loading);
    assert.equal(await label.evaluate(()=>__printedLabels.length),1,await label.locator('#status').textContent());
    assert.equal((await label.evaluate(()=>__printedLabels[0])).length,2);assert.equal(context.pages().length,1,'Printing must not open a popup');
    assert.equal(saved[0].p_logs.length,2);assert.ok(saved[0].p_logs.every(log=>log.labelWeight===5&&log.workOrderSnapshot.weight===5));
    assert.ok(saved[0].p_logs.every(log=>log.workOrderSnapshot.sourceInputs[0].boxCount===10),'Outer print snapshots carry the chosen source box count');
    assert.ok(saved[0].p_logs.every(log=>log.workOrderSnapshot.inputBoxCount===10),'Outer print snapshots carry the known input box total');
    assert.equal(await label.locator('#metric-output').textContent(),'10 kg');assert.equal(await label.locator('#metric-yield').textContent(),'10.0%');
    assert.equal(await label.evaluate(()=>state.workOrders[0].weight),0,'Printing must not mutate workorder weight');
    await setOuter(label,7.35,1);
    await label.evaluate(()=>renderAll());assert.equal(await label.locator('#print-weight-custom').inputValue(),'7.35');
    await label.locator('#print-btn').click();await label.waitForFunction(()=>!state.loading&&__printedLabels.length===2);assert.match((await label.evaluate(()=>__printedLabels[1]))[0],/7\.35/);
    assert.equal(saved[1].p_logs.length,1,'A new print sends only the new label');
    assert.equal(saved[1].p_logs[0].labelWeight,7.35);assert.equal(await label.locator('#metric-output').textContent(),'17.35 kg');
    const firstId=saved[0].p_logs[0].id;await setOuter(label,20);
    await label.evaluate(id=>reprintLog(id),firstId);assert.match((await label.evaluate(()=>__printedLabels[2]))[0],/5\.00/);
    assert.equal(saved[2].p_logs.length,1,'A reprint sends only its updated label');
    assert.equal(await label.locator('#metric-output').textContent(),'17.35 kg');
    await label.evaluate(()=>selectOrder('legacy'));assert.equal(await label.locator('#print-weight').inputValue(),'7.25');
    await label.evaluate(()=>selectOrder('qa-workorder'));assert.equal(await label.locator('#print-weight').inputValue(),'20','Each job retains its own weight');
    for(const invalid of ['', '0','-1','1.234']){await setOuter(label,invalid);const count=saved.length;assert(await label.locator('#print-btn').isDisabled());await label.evaluate(()=>printSelectedLabels());assert.equal(saved.length,count);}
    failSave=true;await setOuter(label,3.75);const count=await label.evaluate(()=>state.logs.length);
    await label.locator('#print-btn').click();await label.waitForFunction(()=>!state.loading);assert.equal(await label.evaluate(()=>state.logs.length),count);
    assert.equal(await label.evaluate(()=>__printedLabels.length),3,'Failed save must not print');assert.equal(await label.locator('iframe[data-dbmt-label-print]').count(),0);
    failSave=false;
    await label.evaluate(value=>{state.workOrders.push({...value,id:'qa-multi-workorder'});selectOrder('qa-multi-workorder');},multi);
    await setOuter(label,5);await label.locator('#print-btn').click();await label.waitForFunction(()=>!state.loading&&__printedLabels.length===4);
    assert.equal(saved.at(-1).p_logs[0].workOrderSnapshot.sourceInputs.length,2,'Print snapshot keeps both raw materials');
    assert.deepEqual(saved.at(-1).p_logs[0].workOrderSnapshot.sourceInputs.map(input=>input.boxCount),[10,3],'Print snapshot keeps per-source box counts');
    assert.equal(saved.at(-1).p_logs[0].workOrderSnapshot.inputBoxCount,13,'Print snapshot keeps the recorded input box total');
    assert.equal(saved.at(-1).p_logs[0].inputWeight,120,'Print log keeps total raw input');
    await label.screenshot({path:path.join(artifacts,'label-weight.png'),fullPage:true});
    console.log('PASS: selected/custom/legacy weights, preview, logs, mixed-weight totals, immutable reprints, invalid values, failed-save rollback, multi-input print snapshot');
    console.log(`Artifacts: ${artifacts}`);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
