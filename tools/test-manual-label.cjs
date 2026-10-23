// Actual office form, picker and print renderer. Fictional masters; no server writes or hardware printing.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os'),vm=require('node:vm');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),index=fs.readFileSync(path.join(repo,'index.html'),'utf8');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-manual-label-'));
const source=name=>{const m=index.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));assert(m,name);return m[0];};
const block=(a,b)=>index.slice(index.indexOf(a),index.indexOf(b,index.indexOf(a)));
for(const match of index.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
const products=[{id:'p-a',name:'가상 삼겹살(작업)',brand:'가상 A',kind:'제품',origin:'스페인',storage:'냉동',shelfdays:365,grade:'1',itemno:'REPORT-A',meattype:'돼지고기',productCode:'QA001'},
 {id:'p-b',name:'가상 삼겹살(작업)',brand:'가상 B',kind:'제품',origin:'칠레',storage:'냉장',shelfdays:30,itemno:'REPORT-B',meattype:'돼지고기',productCode:'QA002',ingredientDetails:'삼겹살 95%, 지방 5%'},
 {id:'raw',name:'가상 원료육',kind:'원료육',origin:'국내산',storage:'냉동'},
 {id:'stopped',name:'중지 제품',kind:'제품',isActive:false}];
const server=http.createServer((req,res)=>{
 const file=path.resolve(repo,new URL(req.url,'http://localhost').pathname.slice(1));
 if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'})[path.extname(file)]||'text/html');res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 try{
  const context=await browser.newContext({viewport:{width:1400,height:1000}}),page=await context.newPage(),errors=[],external=[];
  await context.route('https://**/*',route=>{external.push(route.request().url());return route.abort();});
  await context.addInitScript(()=>{window.print=()=>{window.__printed=(window.__printed||0)+1;};});
  await page.route(base+'/fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><meta charset="utf-8"><body></body></html>'}));
  page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/fixture');
  await page.evaluate(html=>{const t=document.createElement('template');t.innerHTML=html;for(const id of ['p-label','txn-product-picker-modal'])document.body.append(t.content.querySelector('#'+id));document.getElementById('p-label').classList.add('active');},index);
  await page.addStyleTag({url:base+'/styles/main.css'});await page.addStyleTag({url:base+'/styles/manual-label.css'});
  await page.addStyleTag({content:'body{padding:16px}#p-label{max-width:1120px;margin:auto}'});
  for(const file of ['label-weight.js','label-product-selection.js','vendor/jsbarcode/JsBarcode.code128.min.js','label-layout.js','label-print-document.js'])await page.addScriptTag({url:base+'/'+file});
  await page.addScriptTag({content:`
    var labelProducts=${JSON.stringify(products)},workOrders=[],labelPrintLogs=[],userProduction=[],transactions=[];
    const LBL_DEFAULTS={licenseno:'가상 허가번호',prodtype:'포장육(비가열제품)',packaging:'내포장(PE), 외포장(종이)',manufacturer:'주식회사 동부엠티',phone:'032-766-1812',address:'인천광역시 검단구 소담2로 36, 2동 201호 (금곡동)'};
    var allowed=true,loggedIn=true,session='session-a',alerts=[];window.alert=msg=>alerts.push(msg);const toast=window.alert;
    window.DBMTAuth={isPersonal:()=>loggedIn,can:()=>allowed,getSessionToken:()=>session};
    const normalizeOriginName=v=>v||'',nationalPartNameForCode=()=>'',normalizeLabelProductTaxType=()=> '면세';
    const labelProductSearchText=p=>Object.values(p).join(' '),samePriceText=(a,b)=>a===b,sameOriginText=samePriceText;
    const priceKey=v=>String(v||'').trim().toLowerCase();
    ${['htmlEscape','localDateString','inferLabelMeatType','labelCrossFacilityNoticeFromText','fmtLblDate','getDefaultShelfDays','buildLabelBody','printLabelData','updateLabelPreview','printLabel'].map(source).join('\n')}
    ${block('let txnProductPickerKind =','function handleManagedProductInputKeydown(')}
  `});
  await page.addScriptTag({url:base+'/manual-label.js'});await page.evaluate(()=>DBMTManualLabel.init());
  assert.equal(await page.locator('#lbl-workorder-select').count(),0);assert.equal(await page.locator('#lbl-product').getAttribute('readonly'),'');
  await page.locator('#manual-label-print').click();assert.match(await page.evaluate(()=>alerts.at(-1)),/등록된 제품/);
  await page.locator('#lbl-product').click();assert.equal(await page.locator('#tpp-kind-product').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#tpp-result-body tr').count(),2,'Only active registered products: '+errors.join(';'));
  await page.locator('#tpp-search-brand').selectOption('가상 B');await page.locator('#tpp-result-body tr').dblclick();
  assert.equal(await page.locator('#lbl-product-id').inputValue(),'p-b');assert.equal(await page.locator('#lbl-origin').inputValue(),'칠레');
  assert.equal(await page.locator('#lbl-ingredients').inputValue(),'돼지고기 100% (삼겹살 95%, 지방 5%)');
  assert.equal(await page.locator('#lbl-itemno').inputValue(),'REPORT-B');assert.equal(await page.locator('#lbl-temptype').inputValue(),'냉장');
  await page.locator('#lbl-mfgdate').fill('2026-10-20');await page.locator('#lbl-mfgdate').dispatchEvent('change');assert.equal(await page.locator('#lbl-expdate').inputValue(),'2026-11-18');
  for(const [id,value] of [['origin','미국산'],['grade','수정 등급'],['weight','12.34'],['expdate','2026-11-25'],['lot','L12603096675003'],['itemno','202502930933'],['ingredients','돼지고기 95%, 정제수 5%']])await page.locator('#lbl-'+id).fill(value);
  await page.locator('#lbl-print-count').fill('2');await page.evaluate(()=>DBMTManualLabel.updatePreview());
  await page.evaluate(()=>DBMTManualLabel.init());assert.equal(await page.locator('#lbl-weight').inputValue(),'12.34','Reopening the menu preserves the draft');
  const preview=page.frameLocator('#lbl-preview-frame');await preview.locator('.dbmt-label-body').waitFor();
  await page.locator('#lbl-preview-frame').evaluate(frame=>frame.contentWindow.DBMTLabelPrintReady);
  const code=await preview.locator('[data-barcode-kind=product]').first().getAttribute('data-barcode-value');assert.match(code,/^ML[A-Z0-9]+$/);
  assert.equal(await preview.locator('[data-barcode-kind=product]').count(),2);assert.equal(await preview.locator('[data-barcode-kind=trace]').count(),1);
  for(const text of ['가상 삼겹살(작업)','미국산','수정 등급','12.34','2026.11.25','돼지고기'])assert((await preview.locator('.dbmt-label-body').innerText()).includes(text),text);
  await page.screenshot({path:path.join(artifacts,'office-desktop.png'),fullPage:true});
  const expected=await preview.locator('.dbmt-label-body').evaluate(node=>node.outerHTML);
  const popupEvent=page.waitForEvent('popup');await page.locator('#manual-label-print').click();const popup=await popupEvent;
  await popup.waitForFunction(()=>window.DBMTLabelPrintReady);assert(await popup.evaluate(()=>DBMTLabelPrintReady));
  assert.equal(await popup.locator('.lbl-label').count(),2);assert.equal(await popup.locator('.dbmt-label-body').first().evaluate(node=>node.outerHTML),expected,'Print uses exactly the preview artwork and barcode');
  assert.equal(await popup.evaluate(()=>__printed),1);await popup.close();
  await page.locator('#lbl-size').selectOption('10x10');await preview.locator('.dbmt-label-body').waitFor();
  assert.equal(await preview.locator('[data-barcode-kind=product]').first().getAttribute('data-barcode-value'),code,'Edits preserve the preview code');
  await page.locator('#lbl-preview-frame').evaluate(frame=>frame.contentWindow.DBMTLabelPrintReady);
  const narrow=await page.locator('#lbl-preview-frame').evaluate(frame=>{const label=frame.contentDocument.querySelector('.lbl-label'),r=label.getBoundingClientRect();return {width:r.width,height:r.height};});
  assert(narrow.width>0&&narrow.height>0);
  for(const width of [1100,768,360]){
    await page.setViewportSize({width,height:1000});await page.waitForTimeout(180);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal page overflow at '+width);
    assert(await page.locator('#lbl-preview-frame').evaluate(frame=>frame.getBoundingClientRect().right<=innerWidth),'Preview fits at '+width);
  }
  await page.screenshot({path:path.join(artifacts,'office-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1400,height:1000});
  await page.evaluate(()=>{document.getElementById('lbl-product').value='등록하지 않은 제품'});await page.locator('#manual-label-print').click();assert.match(await page.evaluate(()=>alerts.at(-1)),/등록된 제품/);
  await page.evaluate(()=>DBMTManualLabel.selectProduct('p-b'));await page.locator('#lbl-weight').fill('-1');await page.locator('#manual-label-print').click();assert.match(await page.evaluate(()=>alerts.at(-1)),/중량/);
  await page.locator('#lbl-weight').fill('1');await page.locator('#lbl-print-count').fill('1.5');await page.locator('#manual-label-print').click();assert.match(await page.evaluate(()=>alerts.at(-1)),/출력 매수/);
  await page.locator('#lbl-print-count').fill('1');await page.evaluate(()=>{labelProducts=labelProducts.filter(p=>p.id!=='p-b');});await page.locator('#manual-label-print').click();assert.match(await page.evaluate(()=>alerts.at(-1)),/등록된 제품/);
  await page.evaluate(()=>{allowed=false;DBMTManualLabel.applyPermissions();});assert(await page.locator('#manual-label-print').isDisabled());
  await page.evaluate(()=>{allowed=true;session='';loggedIn=false;DBMTManualLabel.applyPermissions();});assert.equal(await page.locator('#lbl-product-id').inputValue(),'');assert(await page.locator('#lbl-preview-frame').isHidden());
  assert.deepEqual(await page.evaluate(()=>[workOrders,labelPrintLogs,userProduction,transactions]),[[],[],[],[]]);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  console.log('PASS: no work orders, registered product/brand picker, editable fields, expiry, arbitrary barcodes, identical preview/print, multiple copies, sizes/mobile, stale/invalid products, permissions/logout, no operational writes');console.log('Artifacts: '+artifacts);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
