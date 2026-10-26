/* Isolated DOM + mocked RPC. No production network or printer access. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const source=name=>{const m=html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));assert(m,name);return m[0];};
const block=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(m[1]);
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<main></main>'}));
    await page.goto('http://fixture.invalid/');
    await page.evaluate(html=>{
      const t=document.createElement('template');t.innerHTML=html;
      for(const id of ['p-labelproducts','txn-product-picker-modal','txn-stock-picker-modal'])document.body.append(t.content.querySelector('#'+id));
      document.getElementById('p-labelproducts').classList.add('active');
      const area=document.createElement('div');area.innerHTML='<input id="prod-out-product-1"><input id="prod-out-product-id-1"><input id="prod-out-packunit-1"><div id="prod-out-product-results-1"></div><input id="t-product-managed"><input id="t-label-product-id"><input id="t-packunit"><select id="t-origin-managed"></select><select id="t-storage-managed"></select>';
      document.body.append(area);
    },html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
    await page.addScriptTag({content:`
      let labelProducts=[{id:'inactive',name:'중단 원료',isActive:false,kind:'원료육',meattype:'가금류',origin:'국내산',storage:'냉동',shelfdays:365},
        {id:'legacy',name:'기존 원료',kind:'원료육',meattype:'가금류',origin:'국내산',storage:'냉동',shelfdays:365},
        {id:'active',name:'사용 제품',isActive:true,kind:'제품',meattype:'가금류',origin:'국내산',storage:'냉동',packunit:'5KG',shelfdays:365}];
      let stocks=labelProducts.map((p,i)=>({key:p.id,labelProductId:p.id,product:p.name,stock:30+i,origin:p.origin,packunit:p.packunit||''}));
      let transactions=[{id:'old',product:'중단 원료',labelProductId:'inactive',weight:10}],userProdEntries=[{id:'old-prod',outputs:[{productId:'inactive',product:'중단 원료',qty:5}]}];
      const historical=JSON.stringify({transactions,userProdEntries,stocks});
      let labelProductSortKey='name',labelProductSortDir='asc',dataChangeLogs=[];
      window.requests=[];window.alerts=[];window.failSave=false;
      const toast=()=>{},alert=s=>alerts.push(s),STOCK_LOCATION_DEFAULT='가공장';
      const priceKey=v=>String(v??'').trim().toLowerCase(),samePriceText=(a,b)=>priceKey(a)===priceKey(b),sameOriginText=samePriceText;
      const normalizeOriginName=v=>v||'',normalizeLabelProductTaxType=v=>v||'면세',nationalPartNameForCode=code=>({P01:'설도',BF005:'우둔'})[code]||'';
      const usesNationalPartCode=()=>false,isNationalPartCodeForProduct=()=>true,getDefaultShelfDays=()=>365;
      const autoFillLabelProductShelfDays=()=>{},autoFillLabelProductShelfDaysIfBlank=()=>{},refreshLabelProductNationalPartSelect=()=>{},refreshLabelProductSelect=()=>{};
      const invalidateStockMap=()=>{},safeLocalStorageSet=()=>{},saveDataChangeLogsLocal=()=>{},resetDataChangeAppDataBaseline=()=>{},makeAppId=()=> 'new';
      const personalServerWriteToken=()=> 'qa',assertPersonalServerResult=r=>{if(!r.ok)throw Error('denied');};
      const bulkOutboundStockOptions=()=>stocks,getTxnStockSearchOptions=()=>stocks;
      const getStockMap=()=>Object.fromEntries(stocks.map(s=>[s.key,s]));
      const sbRpc=async(name,args)=>{requests.push({name,args});if(failSave)throw Error('QA failure');const products=labelProducts.map(p=>p.id===args.p_record.id?structuredClone(args.p_record):p);return {ok:true,products,product:args.p_record};};
      ${['htmlEscape','labelProductSearchText','labelProductSortValue','labelProductSortMark','labelProductSortHeader','renderLabelProducts','sameLabelProduct','applyLabelProductServerResult','saveLabelProduct','editLabelProduct','resetLabelProductForm','refreshTxnManagedProductControls','getManagedProductNames','getStockOptions','labelProductPackUnitText','findLabelProductForProduction','renderProdOutProductSuggestions','selectProdOutProduct','onBulkProductSearch','bulkProductWrap','bulkInboundProductInputValue','updateBulkInboundProductMeta'].map(source).join('\n')}
      ${block('let txnProductPickerKind =','function handleManagedProductInputKeydown(')}
      ${source('isStockProductSelectable')}
      let txnStockPickerTargetInput=null;
      ${source('getTxnStockPickerOptions')}
      renderLabelProducts._migrated=true;refreshTxnManagedProductControls._migrated=true;
      renderLabelProducts();
    `});
    assert.deepEqual(errors,[]);
    assert.equal(await page.locator('#lp-is-active').inputValue(),'true');
    assert.equal(await page.locator('#lp-list-wrap tbody tr').count(),3);
    const shot=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-product-status-')),'product-status.png');
    await page.locator('#p-labelproducts').screenshot({path:shot});console.log('Screenshot: '+shot);
    await page.selectOption('#lp-status-filter','false');
    assert.equal(await page.locator('#lp-list-wrap tbody tr').count(),1);
    assert.match(await page.locator('#lp-list-wrap').textContent(),/중단 원료/);
    await page.selectOption('#lp-status-filter','');
    await page.evaluate(()=>editLabelProduct(1));
    assert.equal(await page.locator('#lp-is-active').inputValue(),'true','Legacy defaults active');
    assert.equal(await page.locator('#lp-ingredient-details').inputValue(),'','Legacy product has no additional ingredients');
    await page.locator('#lp-ingredient-details').fill('전각(미국산) 85%, 우지방(국내산) 15%');
    await page.selectOption('#lp-is-active','false');
    await page.evaluate(()=>saveLabelProduct());
    assert.equal(await page.evaluate(()=>labelProducts[1].isActive),false);
    assert.equal(await page.evaluate(()=>requests[0].args.p_record.isActive),false);
    assert.equal(await page.evaluate(()=>requests[0].args.p_record.ingredientDetails),'전각(미국산) 85%, 우지방(국내산) 15%');
    assert.equal(await page.locator('#lp-ingredient-details').inputValue(),'','Reset clears the new field');
    await page.evaluate(()=>editLabelProduct(1));
    assert.equal(await page.locator('#lp-is-active').inputValue(),'false','Survives server refresh/reopen');
    assert.equal(await page.locator('#lp-ingredient-details').inputValue(),'전각(미국산) 85%, 우지방(국내산) 15%');
    await page.selectOption('#lp-is-active','true');await page.evaluate(()=>{failSave=true;});
    await page.evaluate(()=>saveLabelProduct());
    assert.equal(await page.evaluate(()=>labelProducts[1].isActive),false,'Failed save never changes local master');
    await page.evaluate(()=>{failSave=false;});await page.evaluate(()=>saveLabelProduct());
    assert.equal(await page.evaluate(()=>labelProducts[1].isActive),true);
    assert.equal(await page.evaluate(()=>JSON.stringify({transactions,userProdEntries,stocks})===historical),true);
    const choices=await page.evaluate(()=>{
      document.getElementById('txn-product-picker-modal').classList.remove('hidden');
      txnProductPickerKind='원료육';renderTxnProductPicker();
      renderProdOutProductSuggestions(1);
      return {master:txnProductPickerRows.map(p=>p.id),stocks:getTxnStockPickerOptions().map(p=>p.key),raw:getStockOptions().map(p=>p.key),names:getManagedProductNames()};
    });
    assert.deepEqual(choices.master,['legacy']);assert.deepEqual(choices.stocks,['legacy','active']);assert.deepEqual(choices.raw,['legacy','active']);
    assert(!choices.names.includes('중단 원료'));
    assert.doesNotMatch(await page.locator('#prod-out-product-results-1').textContent(),/중단 원료/);
    await page.evaluate(()=>selectProdOutProduct(1,2));
    assert.equal(await page.locator('#prod-out-product-id-1').inputValue(),'active','Filtering preserves original array index');
    assert.equal(await page.evaluate(()=>findLabelProductForProduction('중단 원료','','inactive').id),'inactive','Historical lookup keeps inactive master');
    await page.evaluate(()=>refreshTxnManagedProductControls('중단 원료','국내산','냉동','inactive'));
    assert.equal(await page.locator('#t-product-managed').inputValue(),'중단 원료');
    assert.equal(await page.locator('#t-origin-managed').inputValue(),'국내산');
    await page.evaluate(()=>{
      const wrap=document.createElement('div');wrap.className='bulk-in-product-wrap';
      wrap.innerHTML='<input id="qa-bulk"><input class="bulk-in-product-id"><div class="bulk-in-product-results"></div>';
      document.body.append(wrap);onBulkProductSearch(document.getElementById('qa-bulk'),false);
    });
    assert.doesNotMatch(await page.locator('.bulk-in-product-results').textContent(),/중단 원료/);
    assert.match(await page.locator('.bulk-in-product-results').textContent(),/기존 원료/);
    assert.deepEqual(await page.evaluate(()=>{
      labelProducts.push({id:'variant-off',name:'동명',origin:'국내산',brand:'A',isActive:false},{id:'variant-on',name:'동명',origin:'국내산',brand:'B'});
      return [isStockProductSelectable({product:'동명'}),isStockProductSelectable({product:'동명',brand:'A'}),isStockProductSelectable({product:'동명',brand:'B'}),isStockProductSelectable({product:'미등록 과거품목'}),isStockProductSelectable({product:'기존 원료',labelProductId:'inactive'}),isStockProductSelectable({product:'중단 원료'})];
    }),[true,false,true,true,false,false]);
    await page.evaluate(()=>{
      labelProducts.push(
        {id:'cut-name',name:'설도',origin:'국내산'},
        {id:'cut-code',name:'설깃',nationalPartCode:'설도',origin:'국내산'},
        {id:'cut-code-name',name:'설깃살',nationalPartCode:'P01',origin:'국내산'}
      );
      renderLabelProducts();
    });
    await page.locator('#lp-search').fill('설도');
    assert.equal(await page.locator('#lp-list-wrap tbody tr').count(),1,'National part code and its name are excluded from keyword search');
    assert.match(await page.locator('#lp-list-wrap tbody tr').textContent(),/설도/);
    await page.locator('#lp-search').fill('설깃');
    assert.equal(await page.locator('#lp-list-wrap tbody tr').count(),2,'Product name remains searchable');
    await page.locator('#lp-search').fill('P01');
    assert.equal(await page.locator('#lp-list-wrap tbody tr').count(),0,'National part code itself is excluded');

    await page.evaluate(()=>{
      labelProducts.push(
        {id:'raw-udun',name:'우둔',productCode:'Q100041',brand:'오코너',factoryNo:'F123',grade:'GF',origin:'호주산',storage:'냉동',packunit:'5KG',kind:'원료육'},
        {id:'raw-chilled-udun',name:'냉장우둔',origin:'국내산',storage:'냉장',kind:'원료육'},
        {id:'raw-cut-mapped',name:'홍두깨',nationalPartCode:'BF005',origin:'호주산',kind:'원료육'},
        {id:'raw-cut-literal',name:'홍두깨살',nationalPartCode:'우둔',origin:'호주산',kind:'원료육'},
        {id:'product-udun',name:'우둔(작업)',origin:'호주산',kind:'제품'},
        {id:'product-cut-mapped',name:'홍두깨(작업)',nationalPartCode:'BF005',origin:'호주산',kind:'제품'}
      );
      openTxnProductPicker('우둔');
    });
    const pickerIds=()=>page.evaluate(()=>txnProductPickerRows.map(p=>p.id));
    assert.deepEqual((await pickerIds()).sort(),['raw-chilled-udun','raw-udun'],'Inbound unified search excludes mapped and literal part codes');
    assert.doesNotMatch(await page.locator('#tpp-result-body').textContent(),/홍두깨/);
    for(const query of ['Q100041','오코너','F123','GF']){
      await page.locator('#tpp-search-all').fill(query);
      assert.deepEqual(await pickerIds(),['raw-udun'],`Keep normal item metadata searchable: ${query}`);
    }
    await page.locator('#tpp-search-all').fill('BF005');
    assert.deepEqual(await pickerIds(),[],'Do not search the national part code itself');
    await page.locator('#tpp-search-all').fill('우둔');
    await page.locator('#tpp-search-brand').selectOption('오코너');
    assert.deepEqual(await pickerIds(),['raw-udun'],'Brand filter still works');
    await page.locator('#tpp-kind-product').click();
    assert.deepEqual(await pickerIds(),['product-udun'],'Product tab also excludes part-code matches');
    await page.locator('#tpp-kind-raw').click();
    await page.locator('#tpp-search-name').fill('냉장');
    assert.deepEqual(await pickerIds(),['raw-chilled-udun'],'Independent product-name filter still works');
    await page.evaluate(()=>{
      closeTxnProductPicker(false);
      const input=document.getElementById('qa-bulk');input.value='우둔';onBulkProductSearch(input,true);
    });
    assert.match(await page.locator('.bulk-in-product-results').textContent(),/우둔/);
    assert.doesNotMatch(await page.locator('.bulk-in-product-results').textContent(),/홍두깨/,'Bulk inbound suggestions use the same exclusion');
    assert.deepEqual(errors,[]);
    console.log('PASS: product status UI/save/failure/reactivation, master/raw-stock choices, historical selection; inbound raw/product popup and bulk suggestions exclude literal/mapped part codes while item codes, names, brands, factory numbers, grades and filters remain searchable');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
