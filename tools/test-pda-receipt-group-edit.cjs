// Actual grouped list, upper form and save handlers; operating requests are never made.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const seed=require('./pda-raw-receipt-fixture.cjs');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-receipt-group-edit-'));
const source=name=>{const match=html.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'));assert(match,name);return match[0];};
const names=['htmlEscape','jsArg','parseAppNumber','parseOptionalBoxCount','boxCountDisplay','parseTransactionUnitPrice',
  'allocatePdaRawReceiptWeights','updateTxnAmtPreview','autoFillTxnPrice','addTransaction','savePdaRawReceiptFromForm',
  'setPdaRawReceiptEditControls','loadTxnToForm','clearTransactionForm','showTransactionSaveStatus','supabaseSaveTransactionRows',
  'assertPersonalServerResult','personalServerWriteToken','getFilteredTransactions','transactionDisplayRows','findPdaTransactionSummary',
  'renderTransactions','openPdaTransactionDetails','closePdaTransactionDetails','renderPdaTransactionDetails','deleteTransaction'];
const functions=names.map(source).join('\n');new vm.Script(functions);
const allocate=vm.runInNewContext(source('allocatePdaRawReceiptWeights')+'\nallocatePdaRawReceiptWeights;');
const before=JSON.stringify(seed);
for(const target of [2313.93,2313.92,2300,2500,100]){
  const result=allocate(seed,target);
  assert.equal(result.reduce((sum,n)=>sum+Math.round(n*100),0),Math.round(target*100));
  result.forEach((n,i)=>assert(Math.abs(n-target*seed[i].weight/2313.93)<.011));
}
assert.equal(JSON.stringify(allocate(seed,2313.93)),JSON.stringify(seed.map(row=>row.weight)));
assert.equal(JSON.stringify(allocate([{weight:1},{weight:1},{weight:1}],.04)),'[0.02,0.01,0.01]');
assert.equal(allocate(Array.from({length:500},()=>({weight:10000000})),4999999999.99).reduce((sum,n)=>sum+Math.round(n*100),0),499999999999);
for(const target of [0,-1,Infinity,NaN,1.001,.01])assert.throws(()=>allocate(seed,target));
assert.throws(()=>allocate([{weight:0}],1));assert.equal(JSON.stringify(seed),before);
console.log('PASS: exact proportional hundredths, stable ties, positive originals and safe large integer allocation');
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><main></main>');});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(markup=>{const template=document.createElement('template');template.innerHTML=markup;
      const panel=template.content.querySelector('#p-transactions');panel.classList.add('active');document.querySelector('main').append(panel);
      document.body.append(template.content.querySelector('#txn-pda-detail-dialog'));
    },html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'pda-transaction-summary.js'),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'stock-ledger.js'),'utf8')});
    await page.addScriptTag({content:`
      const originals=${JSON.stringify(seed)};
      let userTransactions=structuredClone(originals),transactions=[...userTransactions],EXCEL_TRANSACTIONS=[],_editTxnId=null,
        pdaRawReceiptEditRows=[],pdaRawReceiptEditNote='',pdaShipmentEditRows=[],pdaTransactionDetailIds=[],transactionListQueryActive=true;
      let requests=[],messages=[],failed=false,allowUpdate=true,allowConfirm=true,confirmations=[];
      const SUPABASE_ENABLED_KEY='qa-enabled',today='2026-10-20',STOCK_LOCATION_DEFAULT='가공장',STOCK_LOCATION_SECONDARY='물류창고',labelProducts=[],transactionPricePendingIds=new Set();
      localStorage.setItem(SUPABASE_ENABLED_KEY,'1');
      const DBMTAuth={isPersonal:()=>true,can:()=>allowUpdate,getSessionToken:()=> 'qa-token'};
      const asArray=value=>value==null?[]:Array.isArray(value)?value:[value],normalizeRowsForUpsert=asArray;
      const getTxnStockLocation=t=>t.stockLocation||STOCK_LOCATION_DEFAULT,normalizeStockLocation=v=>v||STOCK_LOCATION_DEFAULT;
      const toast=message=>messages.push(message),invalidateStockMap=()=>{},gsShowSync=()=>{},updateOutProductList=()=>{},updateProductList=()=>{},updateTxnManagedProductMeta=()=>{},hideTxnTraderResults=()=>{},onTxnTraderSearch=()=>{};
      const safeLocalStorageSet=(key,value)=>localStorage.setItem(key,value);
      function refreshTxnManagedProductControls(product,origin,storage,id){document.getElementById('t-product-managed').value=product;document.getElementById('t-label-product-id').value=id;}
      function updateTransactionForm(){document.getElementById('t-product-input').style.display='none';document.getElementById('t-product-managed-wrap').style.display='block';document.getElementById('t-origin-wrap').style.display='none';document.getElementById('t-stock-search-wrap').style.display='none';}
      window.alert=toast;window.confirm=message=>{confirmations.push(message);return allowConfirm;};
      async function sbRpc(name,body){
        if(name!=='dbmt_erp_save_transactions')throw Error('Unexpected RPC');
        if(body.p_rows.some(row=>row._pdaSummaryRows||String(row.id).startsWith('pda-summary:')))throw Error('Cannot persist a display aggregate');
        requests.push(structuredClone(body));await new Promise(resolve=>setTimeout(resolve,100));
        if(failed)throw Error('QA atomic group edit rejected');
        return {ok:true,updatedRawReceipts:body.p_rows.map(row=>({...row,traderId:'qa-corrected-supplier',stockUnitPrice:row.price,
          _pdaRawEditRevision:(row._pdaRawEditRevision||0)+1,_pdaRawScannedWeight:originals.find(r=>r.id===row.id).weight,
          _pdaRawWeightDelta:Math.round((row.weight-originals.find(r=>r.id===row.id).weight)*100)/100}))};
      }
      async function saveTransactionRows(rows,deleted,old,options){await supabaseSaveTransactionRows(rows,deleted,options);}
      function resetFixture(){clearTransactionForm();userTransactions=structuredClone(originals);transactions=[...userTransactions];renderTransactions();}
      ${functions}
      renderTransactions();
    `});
    const edit=()=>page.locator('#t-body').getByRole('button',{name:'수정',exact:true}).click();
    assert.equal(await page.locator('#t-body tr').count(),1);await edit();
    assert.equal(await page.locator('#txn-pda-detail-dialog').evaluate(el=>el.open),false,'Edit must not open the original-receipt modal');
    assert.equal(await page.evaluate(()=>pdaRawReceiptEditRows.length),10);
    assert.equal(await page.locator('#t-weight').inputValue(),'2313.93');assert.equal(await page.locator('#t-box-count').inputValue(),'101');
    assert.match(await page.locator('#t-edit-banner').textContent(),/10건.*101박스/);
    assert.equal(await page.locator('#t-proddate').inputValue(),'','Mixed manufacturing dates must not show the first source date');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'t-weight');
    for(const id of ['t-date','t-product-managed','t-lot','t-proddate','t-box-count'])assert(await page.locator('#'+id).evaluate(el=>el.readOnly),id);
    for(const id of ['t-type','t-stock-location'])assert(await page.locator('#'+id).isDisabled(),id);
    for(const id of ['t-trader','t-price','t-weight','t-note'])assert(await page.locator('#'+id).isEditable(),id);
    await page.locator('#t-weight').fill('2300');await page.locator('#t-price').fill('5300');await page.locator('#t-trader').fill('변경 입고처');await page.locator('#t-note').fill('합계중량 정정');
    const expected=allocate(seed,2300),expectedAmount=expected.reduce((sum,n)=>sum+Math.round(n*5300),0);
    assert.equal(await page.locator('#t-amount-preview').inputValue(),expectedAmount.toLocaleString('ko-KR')+' 원');
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:960});await page.locator('#p-transactions .card').first().screenshot({path:path.join(artifacts,'form-'+width+'.png')});
    }
    await page.locator('#t-add-btn').click();await page.evaluate(()=>addTransaction());await page.waitForFunction(()=>_editTxnId===null);
    assert.equal(await page.evaluate(()=>requests.length),1,'Repeated save cannot send duplicate corrections');
    const corrected=await page.evaluate(()=>userTransactions);
    corrected.forEach((row,i)=>{
      assert.equal(row.weight,expected[i]);assert.equal(row.price,5300);assert.equal(row.trader,'변경 입고처');assert.equal(row.note,'합계중량 정정');
      assert.equal(row.amount,Math.round(expected[i]*5300));assert.equal(row._pdaRawEditRevision,1);
      for(const key of ['id','date','type','stockRowId','labelProductId','product','lot','boxCount','proddate','stockProddate','mfgdate','expdate','origin','storage','stockLocation','_pdaRawRequestId','_pdaRawPackageId','_pdaCode','_pdaRawBoxes'])assert.deepEqual(row[key],seed[i][key],key);
    });
    assert.equal(corrected.reduce((sum,row)=>sum+Math.round(row.weight*100),0),230000);
    assert.equal(await page.evaluate(()=>DBMTStockLedger.rows(DBMTStockLedger.calculate(transactions)).reduce((sum,row)=>sum+Math.round(row.stock*100),0)),230000);
    assert.equal(await page.locator('#t-body tr').count(),1);assert.match(await page.evaluate(()=>confirmations[0]),/2313\.93KG.*2300\.00KG/);
    await page.locator('#t-body').getByRole('button',{name:'박스별',exact:true}).click();
    assert.equal(await page.locator('#txn-pda-detail-body tr').count(),101);assert.match(await page.locator('#txn-pda-detail-summary').textContent(),/2300\.00.*2313\.93/);
    await page.getByRole('button',{name:'입고별',exact:true}).click();assert.equal(await page.locator('#txn-pda-detail-body tr').count(),10);
    await page.locator('#txn-pda-detail-body tr').first().getByRole('button',{name:'수정',exact:true}).click();
    assert.equal(await page.evaluate(()=>pdaRawReceiptEditRows.length),0);assert.equal(await page.locator('#t-weight').inputValue(),String(expected[0]));
    assert.equal(await page.locator('#txn-pda-detail-dialog').evaluate(el=>el.open),false);
    await page.evaluate(()=>clearTransactionForm());await edit();await page.locator('#t-weight').fill('2299.99');await page.evaluate(()=>{failed=true;});
    await page.locator('#t-add-btn').click();await page.waitForFunction(()=>document.getElementById('t-save-status').textContent.includes('QA atomic'));
    assert.deepEqual(await page.evaluate(()=>userTransactions),corrected);assert.equal(await page.locator('#t-weight').inputValue(),'2299.99');assert.equal(await page.locator('#t-add-btn').isDisabled(),false);
    await page.evaluate(()=>{failed=false;allowConfirm=false;});let count=await page.evaluate(()=>requests.length);
    await page.locator('#t-add-btn').click();assert.equal(await page.evaluate(()=>requests.length),count);
    await page.evaluate(()=>{allowConfirm=true;allowUpdate=false;});await page.evaluate(()=>addTransaction());assert.equal(await page.evaluate(()=>requests.length),count);
    await page.evaluate(()=>{allowUpdate=true;localStorage.setItem(SUPABASE_ENABLED_KEY,'0');});await page.evaluate(()=>addTransaction());assert.equal(await page.evaluate(()=>requests.length),count);
    await page.evaluate(()=>localStorage.setItem(SUPABASE_ENABLED_KEY,'1'));
    for(const invalid of ['0','-1','1.001','0.01']){await page.locator('#t-weight').fill(invalid);await page.locator('#t-add-btn').click();assert.equal(await page.evaluate(()=>requests.length),count,invalid);}
    await page.locator('#t-weight').fill('2300');await page.locator('#t-price').fill('0');await page.locator('#t-add-btn').click();await page.waitForFunction(()=>_editTxnId===null);
    assert.equal(await page.evaluate(()=>userTransactions.reduce((sum,row)=>sum+row.amount,0)),0);
    await page.evaluate(()=>{resetFixture();userTransactions[0].note='메모 A';userTransactions[1].note='메모 B';renderTransactions();});await edit();
    assert.deepEqual((await page.locator('#t-note').inputValue()).split(' / ').sort(),['메모 A','메모 B']);await page.locator('#t-price').fill('1.5');
    const roundingAmount=seed.reduce((sum,row)=>sum+Math.round(row.weight*1.5),0);
    assert.equal(await page.locator('#t-amount-preview').inputValue(),roundingAmount.toLocaleString('ko-KR')+' 원');
    await page.locator('#t-add-btn').click();await page.waitForFunction(()=>_editTxnId===null);
    assert.equal(await page.evaluate(()=>userTransactions[0].note),'메모 A');assert.equal(await page.evaluate(()=>userTransactions[1].note),'메모 B');assert.equal(await page.evaluate(()=>userTransactions[2].note),'');
    await edit();count=await page.evaluate(()=>requests.length);await page.locator('#t-add-btn').click();assert.equal(await page.evaluate(()=>requests.length),count,'Unchanged group must not write');
    await page.evaluate(()=>{userTransactions[0]={...userTransactions[0],_pdaRawEditRevision:99};transactions=[...userTransactions];});await page.locator('#t-weight').fill('2300');await page.locator('#t-add-btn').click();
    assert.equal(await page.evaluate(()=>requests.length),count,'A stale group cannot overwrite a later edit');assert.match(await page.evaluate(()=>messages.at(-1)),/변경되었습니다/);
    await page.evaluate(()=>{resetFixture();});await edit();await page.locator('#t-price').fill('10');
    await page.evaluate(()=>{transactionPricePendingIds.add(String(userTransactions[0].id));});await page.locator('#t-add-btn').click();assert.equal(await page.evaluate(()=>requests.length),count);
    await page.evaluate(()=>{transactionPricePendingIds.clear();clearTransactionForm();});
    for(const id of ['t-date','t-product-managed','t-lot','t-box-count'])assert.equal(await page.locator('#'+id).evaluate(el=>el.readOnly),false,id);
    assert.equal(await page.locator('#t-type').isDisabled(),false);assert.equal(await page.evaluate(()=>pdaRawReceiptEditRows.length),0);
    await edit();await page.evaluate(()=>deleteTransaction(_editTxnId));
    assert.equal(await page.evaluate(()=>userTransactions.length),0);assert.equal(await page.evaluate(()=>pdaRawReceiptEditRows.length),0);
    assert.equal(await page.evaluate(()=>_editTxnId),null);assert.equal(await page.evaluate(()=>requests.at(-1).p_delete_ids.length),10);
    assert.deepEqual(errors,[]);
    console.log('PASS: aggregate edit opens upper form; 101 boxes/10 receipts, exact total and amount, preserved dates/barcodes/scan weights/notes, atomic request, canonical revisions, stock totals, individual edit, failure/cancel/permission/offline/stale/pending/no-op guards, reset and 1440/390px layouts');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
