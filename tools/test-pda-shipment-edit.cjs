// Actual ERP grouped list/form/save handlers; all server requests are fictional.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-shipment-edit-'));
const names=['htmlEscape','jsArg','parseAppNumber','parseOptionalBoxCount','boxCountDisplay','parseTransactionUnitPrice','updateTxnAmtPreview','autoFillTxnPrice','addTransaction','savePdaShipmentFromForm','setPdaRawReceiptEditControls',
  'loadTxnToForm','clearTransactionForm','showTransactionSaveStatus','supabaseSaveTransactionRows','assertPersonalServerResult','personalServerWriteToken','getFilteredTransactions','transactionDisplayRows','findPdaTransactionSummary','renderTransactions'];
const functions=names.map(name=>{const match=html.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'));assert(match,name);return match[0];}).join('\n');new vm.Script(functions);
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><main></main>');});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(markup=>{const template=document.createElement('template');template.innerHTML=markup;const panel=template.content.querySelector('#p-transactions');panel.classList.add('active');document.querySelector('main').append(panel);},html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'pda-transaction-summary.js'),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'stock-ledger.js'),'utf8')});
    await page.addScriptTag({content:`
      const seed={id:'qa-out-0',date:'2026-11-11',type:'출고',product:'돈사태(작업)',labelProductId:'qa-product',packunit:'5KG',origin:'국내산',storage:'냉동',lot:'L12611114894030',stockLocation:'가공장',stockRowId:'qa-source',
        trader:'동원홈푸드',traderId:'qa-old-customer',weight:12,boxCount:1,price:7500,amount:90000,note:'',stockUnitPrice:null,productionCost:null,_productionCostStatus:'pending',_pdaProvisional:true,_isUser:true,_pdaAction:'ship',_pdaRequestId:'qa-request',_pdaLabelId:'qa-label-0',_pdaCode:'qa-barcode-0'};
      let userTransactions=Array.from({length:34},(_,i)=>({...seed,id:'qa-out-'+i,_pdaLabelId:'qa-label-'+i,_pdaCode:'qa-barcode-'+i})),transactions=[...userTransactions],EXCEL_TRANSACTIONS=[];
      const originals=structuredClone(userTransactions);
      let _editTxnId=null,pdaShipmentEditRows=[],transactionListQueryActive=true,requests=[],messages=[],failed=false,allowUpdate=true;
      const SUPABASE_ENABLED_KEY='qa-enabled',today='2026-11-11',STOCK_LOCATION_DEFAULT='가공장',STOCK_LOCATION_SECONDARY='물류창고',labelProducts=[],transactionPricePendingIds=new Set();
      localStorage.setItem(SUPABASE_ENABLED_KEY,'1');
      const DBMTAuth={isPersonal:()=>true,can:()=>allowUpdate,getSessionToken:()=> 'qa-token'};
      const asArray=value=>value==null?[]:Array.isArray(value)?value:[value],normalizeRowsForUpsert=asArray;
      const getTxnStockLocation=t=>t.stockLocation||STOCK_LOCATION_DEFAULT,normalizeStockLocation=v=>v||STOCK_LOCATION_DEFAULT;
      const toast=message=>messages.push(message),invalidateStockMap=()=>{},gsShowSync=()=>{},updateOutProductList=()=>{},updateProductList=()=>{},updateTxnManagedProductMeta=()=>{},renderPdaTransactionDetails=()=>{},hideTxnTraderResults=()=>{},onTxnTraderSearch=()=>{};
      function ensureOutProductOption(product){const el=document.getElementById('t-product-select');if(![...el.options].some(o=>o.value===product))el.add(new Option(product,product));}
      function onOutProductChange(){}
      function showTxnStockFromTransaction(t){document.getElementById('t-stock-search').value=t.product+' / '+t.lot;}
      function updateTransactionForm(){const outbound=document.getElementById('t-type').value==='출고';document.getElementById('t-product-input').style.display='none';document.getElementById('t-product-managed-wrap').style.display=outbound?'none':'flex';document.getElementById('t-stock-search-wrap').style.display=outbound?'block':'none';document.querySelector('.t-proddate').style.display=outbound?'flex':'none';document.getElementById('t-origin-wrap').style.display=outbound?'flex':'none';}
      window.alert=toast;
      async function sbRpc(name,body){
        if(name!=='dbmt_erp_save_transactions')throw Error('Unexpected RPC: '+name);requests.push(structuredClone(body));
        await new Promise(resolve=>setTimeout(resolve,80));if(failed)throw Error('QA rejected group edit');
        return {ok:true,updatedPdaShipments:body.p_rows.map(row=>({...row,traderId:'qa-new-customer',_pdaShipmentEditRevision:(row._pdaShipmentEditRevision||0)+1}))};
      }
      async function saveTransactionRows(rows,deleted,old,options){await supabaseSaveTransactionRows(rows,deleted,options);}
      ${functions}
      renderTransactions();
    `});
    assert.equal(await page.locator('#t-body tr').count(),1);assert.match(await page.locator('#t-count').textContent(),/34박스/);
    await page.locator('#t-body').getByRole('button',{name:'수정',exact:true}).click();
    assert.equal(await page.evaluate(()=>pdaShipmentEditRows.length),34);assert.equal(await page.locator('#t-weight').inputValue(),'408');assert.equal(await page.locator('#t-box-count').inputValue(),'34');
    for(const id of ['t-date','t-lot','t-weight','t-box-count','t-stock-search'])assert(await page.locator('#'+id).evaluate(el=>el.readOnly),id);
    for(const id of ['t-type','t-stock-location'])assert(await page.locator('#'+id).isDisabled(),id);
    for(const id of ['t-trader','t-price','t-note'])assert(await page.locator('#'+id).isEditable(),id);
    await page.locator('#t-trader').fill('변경 거래처');await page.locator('#t-price').fill('8000');await page.locator('#t-note').fill('거래처 정정');
    assert.equal(await page.locator('#t-price').inputValue(),'8000');assert.equal(await page.locator('#t-amount-preview').inputValue(),'3,264,000 원');
    await page.locator('#p-transactions .card').first().screenshot({path:path.join(artifacts,'group-edit.png')});
    await page.locator('#t-add-btn').click();await page.evaluate(()=>addTransaction());await page.waitForFunction(()=>_editTxnId===null);
    assert.equal(await page.evaluate(()=>requests.length),1);assert.equal(await page.locator('#t-body tr').count(),1);
    const rows=await page.evaluate(()=>userTransactions),originals=await page.evaluate(()=>originals);
    assert.equal(rows.length,34);rows.forEach((row,i)=>{assert.equal(row.trader,'변경 거래처');assert.equal(row.traderId,'qa-new-customer');assert.equal(row.price,8000);assert.equal(row.amount,96000);assert.equal(row._pdaShipmentEditRevision,1);
      for(const key of ['id','date','type','product','labelProductId','lot','weight','boxCount','stockRowId','stockUnitPrice','productionCost','_productionCostStatus','_pdaProvisional','_pdaRequestId','_pdaLabelId','_pdaCode'])assert.deepEqual(row[key],originals[i][key],key);});
    assert.equal(await page.locator('#t-weight').evaluate(el=>el.readOnly),false);assert.equal(await page.locator('#t-type').isDisabled(),false);
    await page.locator('#t-body').getByRole('button',{name:'수정',exact:true}).click();await page.locator('#t-price').fill('9000');await page.evaluate(()=>{failed=true;});await page.locator('#t-add-btn').click();await page.waitForFunction(()=>document.getElementById('t-save-status').textContent.includes('QA rejected'));
    assert.equal(await page.evaluate(()=>userTransactions[0].price),8000);assert.equal(await page.locator('#t-price').inputValue(),'9000');assert.equal(await page.locator('#t-add-btn').isDisabled(),false);
    await page.evaluate(()=>{failed=false;allowUpdate=false;});let count=await page.evaluate(()=>requests.length);await page.evaluate(()=>savePdaShipmentFromForm());assert.equal(await page.evaluate(()=>requests.length),count);
    await page.evaluate(()=>{allowUpdate=true;localStorage.setItem(SUPABASE_ENABLED_KEY,'0');});await page.evaluate(()=>savePdaShipmentFromForm());assert.equal(await page.evaluate(()=>requests.length),count);
    await page.evaluate(()=>localStorage.setItem(SUPABASE_ENABLED_KEY,'1'));await page.locator('#t-price').fill('0');await page.locator('#t-add-btn').click();await page.waitForFunction(()=>_editTxnId===null);assert.equal(await page.evaluate(()=>userTransactions.reduce((sum,r)=>sum+r.amount,0)),0);
    await page.evaluate(()=>{loadTxnToForm(userTransactions[0].id);});assert.equal(await page.evaluate(()=>pdaShipmentEditRows.length),1);await page.locator('#t-price').fill('1.5');await page.locator('#t-add-btn').click();await page.waitForFunction(()=>_editTxnId===null);assert.equal(await page.evaluate(()=>requests.at(-1).p_rows.length),1);assert.equal(await page.locator('#t-body tr').count(),2);
    await page.evaluate(()=>{loadTxnToForm(userTransactions[1].id);pdaShipmentEditRows=[{...pdaShipmentEditRows[0],weight:.1},{...pdaShipmentEditRows[0],id:'round2',weight:.1}];document.getElementById('t-weight').value='.2';document.getElementById('t-price').value='6';updateTxnAmtPreview();});assert.equal(await page.locator('#t-amount-preview').inputValue(),'2 원');
    for(const width of [1440,390]){await page.setViewportSize({width,height:900});await page.evaluate(()=>{clearTransactionForm();loadTxnToForm(findPdaTransactionSummary('pda-summary:'+userTransactions[1].id)?.id||userTransactions[1].id);});await page.locator('#p-transactions .card').first().screenshot({path:path.join(artifacts,'form-'+width+'.png')});}
    assert.deepEqual(errors,[]);console.log('PASS: actual grouped list edit button and form, 34-box customer/price/note correction, snapshots/cost/stock preservation, single-box edit, per-box rounding, zero-price, failed/offline/readonly saves, duplicate prevention, reset and 1440/390px layouts');console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
