// Real ERP form/save handlers with fictional receipts and a stubbed RPC only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-receipt-edit-'));
const source=name=>{const match=html.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'));assert(match,name);return match[0];};
const names=['htmlEscape','parseOptionalBoxCount','parseTransactionUnitPrice','updateTxnAmtPreview','autoFillTxnPrice','addTransaction','savePdaRawReceiptFromForm','setPdaRawReceiptEditControls',
  'loadTxnToForm','clearTransactionForm','showTransactionSaveStatus','supabaseSaveTransactionRows','assertPersonalServerResult','personalServerWriteToken','renderPdaTransactionDetails'];
const functions=names.map(source).join('\n');new vm.Script(functions);
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><main></main>');});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(markup=>{const template=document.createElement('template');template.innerHTML=markup;
      const panel=template.content.querySelector('#p-transactions');panel.classList.add('active');document.querySelector('main').append(panel);
      document.body.append(template.content.querySelector('#txn-pda-detail-dialog'));
    },html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'stock-ledger.js'),'utf8')});
    await page.addScriptTag({content:`
      const seed={id:'qa-receipt',stockRowId:'qa-stock',date:'2026-11-10',type:'입고',product:'목전지',labelProductId:'qa-product',origin:'미국산',storage:'냉동',brand:'S/F',lot:'903024600808',stockLocation:'가공장',
        trader:'쎄븐푸드',traderId:'qa-old-supplier',weight:349.89,boxCount:20,price:4400,amount:1539516,stockUnitPrice:4400,_isUser:true,_pdaAction:'receive',_pdaRawRequestId:'qa-request',_pdaRawPackageId:'qa-box1',
        _pdaRawBoxes:Array.from({length:20},(_,i)=>({id:'qa-box'+i,barcode:'0760760022400460170700'+String(i).padStart(4,'0'),weight:i===19?18.72:17.43}))};
      let userTransactions=[structuredClone(seed)],transactions=[...userTransactions],EXCEL_TRANSACTIONS=[],_editTxnId=null,pdaTransactionDetailIds=[];
      let notices=[],requests=[],failed=false,allowConfirm=true,confirmations=[];
      const labelProducts=[],transactionPricePendingIds=new Set(),SUPABASE_ENABLED_KEY='qa-enabled',today='2026-11-10',STOCK_LOCATION_DEFAULT='가공장',STOCK_LOCATION_SECONDARY='물류창고';
      localStorage.setItem(SUPABASE_ENABLED_KEY,'1');
      const DBMTAuth={isPersonal:()=>true,can:()=>true,getSessionToken:()=> 'qa-token'};
      const normalizeRowsForUpsert=rows=>Array.isArray(rows)?rows:[rows],asArray=value=>value==null?[]:Array.isArray(value)?value:[value];
      const getTxnStockLocation=t=>t.stockLocation||STOCK_LOCATION_DEFAULT,normalizeStockLocation=v=>v||STOCK_LOCATION_DEFAULT;
      const toast=message=>notices.push(message),invalidateStockMap=()=>{},gsShowSync=()=>{};
      const renderTransactions=()=>{},updateOutProductList=()=>{},updateProductList=()=>{},updateTxnManagedProductMeta=()=>{},findPdaTransactionSummary=()=>null;
      const onTxnTraderSearch=()=>{},hideTxnTraderResults=()=>{};
      function refreshTxnManagedProductControls(product,origin,storage,id){document.getElementById('t-product-managed').value=product;document.getElementById('t-label-product-id').value=id;}
      function updateTransactionForm(){document.getElementById('t-product-input').style.display='none';document.getElementById('t-product-managed-wrap').style.display='block';document.getElementById('t-origin-wrap').style.display='none';document.getElementById('t-stock-search-wrap').style.display='none';}
      window.alert=toast;window.confirm=message=>{confirmations.push(message);return allowConfirm;};
      async function sbRpc(name,body){
        if(name!=='dbmt_erp_save_transactions')throw Error('Unexpected RPC');requests.push(structuredClone(body));
        if(failed)throw Error('QA server rejected correction');
        const row=body.p_rows[0];
        return {ok:true,updatedRawReceipts:[{...row,traderId:'qa-corrected-supplier',stockUnitPrice:row.price,amount:Math.round(row.price*row.weight),
          _pdaRawEditRevision:(row._pdaRawEditRevision||0)+1,_pdaRawScannedWeight:349.89,_pdaRawWeightDelta:Math.round((row.weight-349.89)*100)/100}]};
      }
      async function saveTransactionRows(rows,deleted,old,options){await supabaseSaveTransactionRows(rows,deleted,options);}
      ${functions}
      loadTxnToForm(seed.id);
    `});
    for(const id of ['t-date','t-product-managed','t-lot','t-box-count'])assert(await page.locator('#'+id).evaluate(el=>el.readOnly));
    for(const id of ['t-type','t-stock-location'])assert(await page.locator('#'+id).isDisabled());
    for(const id of ['t-trader','t-price','t-weight','t-note'])assert(await page.locator('#'+id).isEditable());
    await page.locator('#t-price').fill('4441');await page.locator('#t-trader').fill('변경 입고처');await page.locator('#t-weight').fill('340');await page.locator('#t-note').fill('실중량 정정');
    assert.equal(await page.locator('#t-amount-preview').inputValue(),'1,509,940 원');assert.equal(await page.locator('#t-price').inputValue(),'4441');
    await page.locator('#p-transactions .card').first().screenshot({path:path.join(artifacts,'receipt-edit.png')});
    await page.locator('#t-add-btn').click();await page.waitForFunction(()=>_editTxnId===null);
    const corrected=await page.evaluate(()=>userTransactions[0]);
    assert.equal(corrected.weight,340);assert.equal(corrected.price,4441);assert.equal(corrected.traderId,'qa-corrected-supplier');assert.equal(corrected.amount,1509940);
    assert.equal(corrected._pdaRawEditRevision,1);assert.equal(corrected._pdaRawWeightDelta,-9.89);assert.equal(corrected._pdaRawBoxes.length,20);
    const submitted=await page.evaluate(()=>requests[0].p_rows[0]);
    for(const key of ['stockRowId','labelProductId','lot','boxCount','origin','storage','date','_pdaRawRequestId','_pdaRawPackageId'])assert.equal(submitted[key],await page.evaluate(key=>seed[key],key),key);
    assert.match(await page.evaluate(()=>confirmations[0]),/349\.89KG.*340\.00KG/);
    for(const id of ['t-date','t-product-managed','t-lot','t-box-count'])assert.equal(await page.locator('#'+id).evaluate(el=>el.readOnly),false,'Reset must unlock ordinary inputs');
    assert.equal(await page.locator('#t-type').isDisabled(),false);
    await page.evaluate(()=>{pdaTransactionDetailIds=[seed.id];renderPdaTransactionDetails();document.getElementById('txn-pda-detail-dialog').showModal();});
    assert.match(await page.locator('#txn-pda-detail-summary').textContent(),/장부 340\.00.*스캔 합계 349\.89.*정정 -9\.89/);
    await page.locator('#txn-pda-detail-dialog').screenshot({path:path.join(artifacts,'corrected-details.png')});
    await page.evaluate(()=>document.getElementById('txn-pda-detail-dialog').close());
    await page.evaluate(()=>{loadTxnToForm(seed.id);failed=true;});await page.locator('#t-price').fill('5000');await page.locator('#t-add-btn').click();
    await page.waitForFunction(()=>document.getElementById('t-save-status').textContent.includes('QA server rejected'));
    assert.equal(await page.evaluate(()=>userTransactions[0].price),4441);assert.equal(await page.locator('#t-price').inputValue(),'5000');assert.equal(await page.locator('#t-add-btn').isDisabled(),false);
    await page.evaluate(()=>{failed=false;});await page.locator('#t-price').fill('0');await page.locator('#t-add-btn').click();await page.waitForFunction(()=>_editTxnId===null);
    assert.equal(await page.evaluate(()=>userTransactions[0].price),0);assert.equal(await page.evaluate(()=>userTransactions[0].amount),0);
    await page.evaluate(()=>{loadTxnToForm(seed.id);allowConfirm=false;});await page.locator('#t-weight').fill('330');const count=await page.evaluate(()=>requests.length);await page.locator('#t-add-btn').click();
    assert.equal(await page.evaluate(()=>requests.length),count,'Cancelling a weight correction must not write');
    await page.evaluate(()=>{clearTransactionForm();const row=userTransactions[0];transactions=[row,{...row,id:'qa-out',type:'출고',weight:349.89,boxCount:20}];});
    assert.equal(await page.evaluate(()=>DBMTStockLedger.rows(DBMTStockLedger.calculate(transactions))[0].stock.toFixed(2)),'-9.89');
    assert.equal(await page.evaluate(()=>DBMTStockLedger.filterRows([{stock:-.01}],{status:'재고'}).length),1,'A 0.01KG shortage must remain visible');
    assert.equal(await page.evaluate(()=>DBMTStockLedger.rows({x:{stock:340-340.01}})[0].stock.toFixed(2)),'-0.01','Floating-point rounding cannot erase a one-cent shortage');
    for(const width of [1440,390]){await page.setViewportSize({width,height:900});await page.evaluate(()=>loadTxnToForm(seed.id));await page.locator('#p-transactions .card').first().screenshot({path:path.join(artifacts,'form-'+width+'.png')});}
    assert.deepEqual(errors,[]);console.log('PASS: real PDA receipt form edits supplier/price/total weight; immutable fields/box IDs, corrected server snapshots/revisions, exact zero amounts, cancel/failure recovery, detail weight provenance, reset and negative shared ledger');console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
