/* Two isolated profiles, real ERP pickers, and fictional RPC data only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(script[1]);
const source=name=>{const match=html.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'));assert(match,name);return match[0];};
const base={isActive:true,meattype:'가금류',origin:'미국산',storage:'냉동',shelfdays:365,packunit:'5KG',nationalPartCode:'',brand:'기존브랜드'};
let products=[{...base,id:'old',productCode:'200001',name:'테스트 기존제품',kind:'제품'},{...base,id:'raw',productCode:'100001',name:'테스트 원료육',kind:'원료육'}],revision=1,fail=false,failSave=false,hold=null;
const calls=[];
const snapshot=()=>({ok:true,revision:String(revision),products:structuredClone(products)});
const server=http.createServer(async(req,res)=>{
  if(req.url==='/rpc'){
    let text='';for await(const chunk of req)text+=chunk;const {name,args}=JSON.parse(text);calls.push({name,...args});
    const send=(value,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    if(!args.p_token?.startsWith('qa-'))return send({message:'Invalid session'},403);
    if(name==='dbmt_erp_get_label_products'){
      const data=args.p_revision===String(revision)?{ok:true,unchanged:true,revision:String(revision)}:snapshot();
      if(hold && hold.token===args.p_token){const wait=hold.promise;hold=null;await wait;}
      return send(fail?{message:'Fixture network failure'}:data,fail?503:200);
    }
    if(name==='dbmt_erp_save_label_product'){
      if(failSave)return send({message:'Fixture save failure'},500);
      const row={...args.p_record,productCode:args.p_record.productCode||String(200000+products.length)};
      products=[row,...products.filter(item=>item.id!==row.id)];revision++;
      return send({...snapshot(),product:row});
    }
    throw Error('Unexpected RPC '+name);
  }
  res.setHeader('Content-Type','text/html');res.end('<html lang="ko"><meta charset="utf-8"><body><main></main></body></html>');
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const errors=[];
  try{
    async function client(token){
      const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
      page.on('pageerror',error=>errors.push(error.message));await page.goto(url);
      await page.evaluate(markup=>{const tpl=document.createElement('template');tpl.innerHTML=markup;for(const id of ['p-labelproducts','p-production','p-transactions','p-stock','p-prices','txn-product-picker-modal','txn-stock-picker-modal'])document.querySelector('main').append(tpl.content.querySelector('#'+id));},html);
      await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
      await page.addScriptTag({content:`
        let labelProducts=[],dataChangeLogs=[],labelProductSortKey='name',labelProductSortDir='asc',stockSearchActivated=false,stockSearchDirty=true,_stockMapCache=null,stockQuerySnapshot=null;
        let txnProductPickerKind='제품',txnProductPickerRows=[],txnProductPickerIndex=-1,txnProductPickerTargetInput=null,txnProductPickerReturnFocus=null,txnProductPickerBodyOverflow='';
        let txnStockPickerRows=[],txnStockPickerIndex=-1,txnStockPickerTargetInput=null;
        const fixtureStocks=[{key:'stock-raw',labelProductId:'raw',product:'테스트 원료육',origin:'미국산',lot:'QA-LOT',stockLocation:'가공장',stock:10,stockBoxes:2,price:1000}];
        window.qaToken=${JSON.stringify(token)};window.messages=[];window.failures=[];window.stockRenders=0;window.catalogEvents=0;
        const DBMTAuth=window.DBMTAuth={isPersonal:()=>!!qaToken,getSessionToken:()=>qaToken};
        const htmlEscape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        const priceKey=v=>String(v??'').replace(/\\s+/g,'').toLowerCase(),samePriceText=(a,b)=>priceKey(a)===priceKey(b),sameOriginText=samePriceText,normalizeOriginName=v=>v||'',bulkOutboundSearchKey=priceKey,bulkOutboundIdentityKey=priceKey;
        const makeAppId=()=> 'qa-product-'+crypto.randomUUID(),personalServerWriteToken=()=>qaToken,assertPersonalServerResult=v=>{if(!v.ok)throw Error('save failed')};
        const toast=v=>messages.push(v);window.alert=v=>failures.push(v);window.confirm=()=>true;
        const safeLocalStorageSet=()=>{},saveDataChangeLogsLocal=()=>{},resetDataChangeAppDataBaseline=()=>{},setStockExportEnabled=()=>{};
        const migrateLabelProducts=()=>{},usesNationalPartCode=()=>false,isNationalPartCodeForProduct=()=>true,nationalPartNameForCode=()=>'',nationalPartSchemeForProduct=()=>'';
        const autoFillLabelProductShelfDaysIfBlank=()=>{if(!document.getElementById('lp-shelfdays').value)document.getElementById('lp-shelfdays').value='365';},autoFillLabelProductShelfDays=()=>{},refreshLabelProductNationalPartSelect=()=>{},refreshLabelProductSelect=()=>{},refreshTxnManagedProductControls=()=>{};
        const txnProductKindValue=row=>row.kind==='제품'?'제품':'원료육',labelProductSearchText=row=>[row.name,row.brand,row.origin].join(' '),txnProductSelectionText=row=>row.brand||'';
        const getTxnStockPickerOptions=()=>fixtureStocks.filter(stock=>labelProducts.find(row=>row.id===stock.labelProductId)?.isActive!==false),isProductionInputStockPicker=()=>false,normalizeStockLocation=v=>v||'',stockLocationKey=priceKey,bulkOutboundSearchText=row=>[row.product,row.lot].join(' ');
        const stockPickerDisplayDate=()=> '2026-11-06',stockPickerBoxLabel=()=> '2 박스';
        const syncTxnStockPickerSelection=()=>{},renderPriceProductSuggestions=()=>{},renderProdOutProductSuggestions=()=>{},autoSetJobNo=()=>{};
        function renderStock(){stockRenders++;stockSearchDirty=false;document.getElementById('stock-body').textContent=fixtureStocks.map(stock=>stock.product+' '+(labelProducts.find(row=>row.id===stock.labelProductId)?.brand||'')+' '+stock.stock+'KG').join(' ');}
        function bulkProductWrap(){return null;}
        document.addEventListener('dbmt-product-catalog-changed',()=>catalogEvents++);
        async function sbRpc(name,args,options={}){const r=await fetch('/rpc',{method:'POST',signal:options.signal,body:JSON.stringify({name,args})});const data=await r.json();if(!r.ok)throw Error(data.message);return data;}
        ${['normalizeLabelProductTaxType','getDefaultShelfDays','sameLabelProduct','applyLabelProductServerResult','saveLabelProduct','resetLabelProductForm','labelProductSortValue','labelProductSortMark','labelProductSortHeader','renderLabelProducts','invalidateStockMap','syncTxnProductKindButtons','refreshTxnProductPickerFilterOptions','openTxnProductPicker','closeTxnProductPicker','renderTxnProductPicker','syncTxnProductPickerSelection','setTxnProductPickerIndex','txnProductStorageBadge','txnStockPickerProductMeta','refreshTxnStockPickerFilterOptions','renderTxnStockPicker','applySupabasePayload'].map(source).join('\n')}
        let userTransactions=[],userProdEntries=[],prices=[],transactions=[],subMaterialUsages=[];
        const EXCEL_TRANSACTIONS=[],cleanupSupabaseLegacyCoreCache=()=>{},cacheAppDataValue=()=>{},scheduleProductionPickerWarmup=()=>{};
        const APP_DATA_REGISTRY={labelProducts:{get:()=>labelProducts,set:v=>{labelProducts=v;},readOnly:true}};
        window.setPage=id=>{document.querySelectorAll('.tab-panel').forEach(el=>el.classList.toggle('active',el.id===id));};
      `});
      await page.addScriptTag({content:fs.readFileSync(path.join(root,'product-catalog-sync.js'),'utf8')});
      assert.equal(await page.evaluate(()=>DBMTProductCatalog.start()),true);
      return page;
    }
    const a=await client('qa-a'),b=await client('qa-b');
    async function save(page,name,kind='제품',id='',brand='신규브랜드'){
      await page.evaluate(()=>setPage('p-labelproducts'));
      await page.locator('#lp-edit-id').evaluate((el,value)=>{el.value=value;},id);await page.locator('#lp-name').fill(name);await page.locator('#lp-brand').fill(brand);
      await page.locator('#lp-kind').selectOption(kind);await page.locator('#lp-meattype').selectOption('가금류');await page.locator('#lp-origin').fill('미국산');
      await page.evaluate(()=>saveLabelProduct());
    }
    await b.evaluate(()=>setPage('p-production'));
    await b.locator('#prod-note').fill('작성 중인 생산일보');await b.locator('#prod-date').fill('');
    await b.evaluate(()=>{
      const input=document.createElement('input');input.id='qa-production-product';input.value='테스트 기존제품';input.dataset.pickerContext='production-output';input.dataset.productionRowId='fixture';
      const hidden=document.createElement('input');hidden.id='prod-out-product-id-fixture';hidden.type='hidden';hidden.value='old';
      document.getElementById('p-production').append(input,hidden);openTxnProductPicker('신규',input);
    });
    assert.match(await b.locator('#tpp-result-body').textContent(),/검색 결과가 없습니다/);
    await save(a,'테스트 신규제품');
    await b.waitForFunction(()=>document.getElementById('tpp-result-body').textContent.includes('테스트 신규제품'),null,{timeout:8000});
    assert.equal(await b.locator('#tpp-search-all').inputValue(),'신규');assert.equal(await b.locator('#prod-note').inputValue(),'작성 중인 생산일보');assert.equal(await b.locator('#prod-date').inputValue(),'');
    assert.equal(await b.locator('#qa-production-product').inputValue(),'테스트 기존제품');assert.equal(await b.locator('#prod-out-product-id-fixture').inputValue(),'old');
    await b.evaluate(()=>{closeTxnProductPicker(false);setPage('p-transactions');openTxnProductPicker('신규');});
    await save(a,'테스트 신규원료','원료육');
    await b.waitForFunction(()=>document.getElementById('tpp-result-body').textContent.includes('테스트 신규원료'),null,{timeout:8000});
    const eventCount=await b.evaluate(()=>catalogEvents);await b.evaluate(()=>DBMTProductCatalog.refresh());assert.equal(await b.evaluate(()=>catalogEvents),eventCount,'Unchanged polls do not repaint the UI');
    await b.evaluate(()=>{closeTxnProductPicker(false);setPage('p-labelproducts');});
    await b.locator('#lp-name').fill('수정 중인 품목');await b.locator('#lp-shelfdays').fill('');await b.locator('#lp-search').fill('테스트');
    const draft=await b.locator('#p-labelproducts input,#p-labelproducts select,#p-labelproducts textarea').evaluateAll(els=>els.map(el=>[el.id,el.value]));
    await save(a,'테스트 원료육','원료육','raw','변경브랜드');
    await b.waitForFunction(()=>document.getElementById('lp-list-wrap').textContent.includes('변경브랜드'),null,{timeout:8000});
    assert.deepEqual(await b.locator('#p-labelproducts input,#p-labelproducts select,#p-labelproducts textarea').evaluateAll(els=>els.map(el=>[el.id,el.value])),draft,'Master edits and intentionally blank fields are preserved');
    await b.evaluate(()=>{setPage('p-stock');stockSearchActivated=true;stockSearchDirty=false;});
    products=products.map(row=>row.id==='raw'?{...row,brand:'재고검색브랜드'}:row);revision++;
    await b.evaluate(()=>DBMTProductCatalog.refresh());assert.match(await b.locator('#stock-body').textContent(),/재고검색브랜드/);assert.match(await b.locator('#stock-body').textContent(),/10KG/);
    await b.evaluate(()=>{document.getElementById('txn-stock-picker-modal').classList.remove('hidden');refreshTxnStockPickerFilterOptions();renderTxnStockPicker();});
    assert.match(await b.locator('#tsp-result-body').textContent(),/재고검색브랜드/);
    products=products.map(row=>row.id==='raw'?{...row,brand:'열린검색창갱신'}:row);revision++;
    await b.evaluate(()=>DBMTProductCatalog.refresh());assert.match(await b.locator('#tsp-result-body').textContent(),/열린검색창갱신/);
    await b.evaluate(()=>applySupabasePayload({transactions:[],prod:[],appData:{labelProducts:[]}}));assert(await b.evaluate(()=>labelProducts.length>0),'A late full-ERP response cannot replace the current catalog');
    let release;hold={token:'qa-a',promise:new Promise(resolve=>release=resolve)};
    await a.evaluate(()=>{window.pendingCatalog=DBMTProductCatalog.refresh(true);});await a.waitForTimeout(80);
    await save(a,'테스트 읽기경쟁');release();await a.evaluate(()=>pendingCatalog);
    assert(await a.evaluate(()=>labelProducts.some(row=>row.name==='테스트 읽기경쟁')),'A late read cannot erase a successful save');
    failSave=true;await save(a,'통신실패 초안');failSave=false;assert.equal(await a.locator('#lp-name').inputValue(),'통신실패 초안');
    const lastGood=await b.evaluate(()=>labelProducts.length);fail=true;assert.equal(await b.evaluate(()=>DBMTProductCatalog.refresh()),false);fail=false;
    assert.equal(await b.evaluate(()=>labelProducts.length),lastGood);assert.equal(await b.evaluate(()=>DBMTProductCatalog.refresh()),true);
    hold={token:'qa-b',promise:new Promise(resolve=>release=resolve)};await b.evaluate(()=>{window.pendingCatalog=DBMTProductCatalog.refresh(true);});await b.waitForTimeout(80);
    await b.evaluate(()=>{DBMTProductCatalog.stop();qaToken='';labelProducts=[];});release();await b.evaluate(()=>pendingCatalog);assert.deepEqual(await b.evaluate(()=>labelProducts),[]);
    assert(calls.every(call=>['dbmt_erp_get_label_products','dbmt_erp_save_label_product'].includes(call.name)),'Only catalog RPCs are used');
    assert.deepEqual(errors,[]);
    console.log('PASS: two profiles, real 5-second propagation to production and transaction pickers, open search refresh, master drafts/blank dates, unchanged-response no repaint, stock metadata without quantity changes, stale-read/save race, failed saves/reads, late bootstrap and logout isolation, catalog-only RPCs.');
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
