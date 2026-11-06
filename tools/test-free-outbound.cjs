/* Fictional stock only: exercise actual single/bulk forms and ledger. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(script[1]);
const source=name=>{const match=html.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'));assert(match,name);return match[0];};
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<main></main><div id="p-invoice"></div>');
    await page.evaluate(markup=>{const template=document.createElement('template');template.innerHTML=markup;const panel=template.content.querySelector('#p-transactions');panel.classList.add('active');document.querySelector('main').append(panel);},html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'stock-ledger.js'),'utf8')});
    await page.addScriptTag({content:`
      const seed={id:'qa-receipt',stockRowId:'qa-stock',stockTrackingVersion:'1',date:'2026-11-06',type:'입고',product:'가상 제품',origin:'미국산',lot:'QA-LOT',packunit:'5KG',stockLocation:'가공장',weight:20,boxCount:4,price:5000,amount:100000,_isUser:true};
      let userTransactions=[{...seed}],transactions=[...userTransactions],EXCEL_TRANSACTIONS=[],labelProducts=[],_editTxnId=null,_stockMapCache=null;
      let tablePrice=9000,notices=[],saved=[],transactionListQueryActive=true;
      const transactionPricePendingIds=new Set(),STOCK_LOCATION_DEFAULT='가공장',STOCK_LOCATION_SECONDARY='물류창고';
      const DBMTPdaTransactionSummary={isOutboundBox:()=>false};
      const getTProduct=()=>seed.product,getTOrigin=()=>seed.origin,getTStorage=()=>'',getTPackunit=()=>seed.packunit,getTLabelProductId=()=>'';
      const getTStockLocation=()=>seed.stockLocation,getTMoveFromLocation=()=>seed.stockLocation,getTMoveToLocation=()=>STOCK_LOCATION_SECONDARY;
      const getTxnStockLocation=t=>t.stockLocation||STOCK_LOCATION_DEFAULT,normalizeStockLocation=v=>v||STOCK_LOCATION_DEFAULT;
      const getPrice=()=>tablePrice,findPriceRow=()=>tablePrice?{product:seed.product,price:tablePrice}:null;
      const getEditingTransaction=()=>userTransactions.find(row=>String(row.id)===String(_editTxnId))||null;
      const getStockMap=()=>DBMTStockLedger.calculate(userTransactions);
      const bulkOutboundStockOptions=()=>Object.entries(getStockMap()).map(([key,row])=>({...row,key})).filter(row=>row.stock>0);
      const outboundStockOptionsForEdit=()=>bulkOutboundStockOptions();
      const availableStockForEdit=(stock,edit)=>stock.stock+(edit?.weight||0),availableBoxesForEdit=(stock,edit)=>stock.stockBoxes+(edit?.boxCount||0);
      const samePriceText=(a,b)=>a===b,sameOriginText=samePriceText,stockLocationKey=v=>v;
      const parseAppNumber=v=>Number(v)||0,normalizeLabelProductTaxType=()=> '면세',nationalPartNameForCode=()=>'';
      const toast=message=>notices.push(message);window.alert=toast;window.confirm=()=>true;
      const makeAppId=()=>crypto.randomUUID(),transactionDisplayRows=rows=>rows,getFilteredTransactions=()=>({rows:transactions});
      const findPdaTransactionSummary=()=>null,renderPdaTransactionDetails=()=>{},updateOutProductList=()=>{},updateProductList=()=>{},invalidateStockMap=()=>{};
      const updateTransactionForm=()=>{},ensureOutProductOption=()=>{},onOutProductChange=()=>{},showTxnStockFromTransaction=()=>{},showTransactionSaveStatus=()=>{};
      function clearTransactionForm(){_editTxnId=null;}
      function clearBulkOutbound(){document.getElementById('bulk-outbound-tbody').innerHTML='';}
      async function saveTransactionRows(rows){saved.push(structuredClone(Array.isArray(rows)?rows:[rows]));}
      ${['htmlEscape','jsArg','parseOptionalBoxCount','boxCountDisplay','parseTransactionUnitPrice','autoFillTxnPrice','updateTxnAmtPreview','addTransaction','loadTxnToForm','updateTxnPrice','renderTransactions','addBulkOutboundRow','refreshBulkOutboundPrice','updateBulkOutboundAmount','saveBulkOutbound'].map(source).join('\n')}
      function prepareSingle(){
        for(const [id,value] of Object.entries({'t-date':'2026-11-06','t-type':'출고','t-trader':'가상 거래처','t-lot':seed.lot,'t-weight':'5','t-box-count':'1','t-stock-key':bulkOutboundStockOptions()[0].key}))document.getElementById(id).value=value;
        document.getElementById('t-product-select').innerHTML='<option selected>가상 제품</option>';
      }
      function prepareBulk(prices){
        document.getElementById('bulk-outbound-body').style.display='block';document.getElementById('bulk-out-date').value='2026-11-06';
        document.getElementById('bulk-outbound-tbody').innerHTML='';
        prices.forEach(price=>{addBulkOutboundRow();const row=document.getElementById('bulk-outbound-tbody').lastElementChild;
          for(const [key,value] of Object.entries({key:bulkOutboundStockOptions()[0].key,trader:'가상 거래처',weight:'2','box-count':'1','price-input':price}))row.querySelector('.bulk-out-'+key).value=value;
        });
      }
      function resetFixture(){userTransactions=[{...seed}];transactions=[...userTransactions];_editTxnId=null;saved=[];notices=[];tablePrice=9000;prepareSingle();}
      resetFixture();
    `});
    await page.locator('#t-price').fill('0');
    assert.equal(await page.locator('#t-amount-preview').inputValue(),'0 원');
    await page.locator('#t-weight').fill('6');
    assert.equal(await page.locator('#t-price').inputValue(),'0','Changing weight must not replace an explicit zero with the price list');
    await page.evaluate(()=>addTransaction());
    assert.deepEqual(await page.evaluate(()=>[saved[0][0].price,saved[0][0].amount,saved[0][0].stockUnitPrice]),[0,0,5000]);
    assert.deepEqual(await page.evaluate(()=>{const stock=Object.values(getStockMap())[0];return [stock.stock,stock.stockBoxes,stock.price];}),[14,3,5000]);
    assert.equal(await page.locator('#t-body tr').last().locator('td').nth(9).textContent(),'0','The saved sales amount is shown as zero');
    const id=await page.evaluate(()=>saved[0][0].id);
    await page.evaluate(id=>loadTxnToForm(id),id);
    assert.equal(await page.locator('#t-price').inputValue(),'0','Editing a zero-price sale retains zero');
    await page.locator('#t-weight').fill('5');await page.evaluate(()=>addTransaction());
    assert.equal(await page.evaluate(()=>saved.at(-1)[0].price),0);
    for(const price of ['', '-1']){
      await page.evaluate(()=>resetFixture());await page.locator('#t-price').fill(price);await page.evaluate(()=>addTransaction());
      assert.equal(await page.evaluate(()=>saved.length),0,'Blank/negative prices cannot save even when the price list exists');
      assert.equal(await page.evaluate(()=>userTransactions.length),1);
      assert(await page.evaluate(()=>notices.length>0));
    }
    await page.evaluate(()=>resetFixture());await page.locator('#t-price').fill('8500');await page.evaluate(()=>addTransaction());
    assert.equal(await page.evaluate(()=>saved[0][0].amount),42500,'Normal prices still save');
    const paidId=await page.evaluate(()=>saved[0][0].id);
    await page.evaluate(id=>updateTxnPrice(id,''),paidId);
    assert.equal(await page.evaluate(()=>saved.length),1,'Inline blank edits cannot overwrite a paid sale');
    await page.evaluate(id=>updateTxnPrice(id,'0'),paidId);
    assert.equal(await page.evaluate(()=>saved.at(-1)[0].amount),0,'Inline explicit zero is permitted');
    await page.evaluate(()=>{resetFixture();prepareBulk(['0','7500']);updateBulkOutboundAmount(document.querySelector('#bulk-outbound-tbody tr'));});
    assert.equal(await page.locator('.bulk-out-amount-cell').first().textContent(),'0');
    await page.locator('.bulk-out-price-input').first().fill('0');
    await page.evaluate(()=>refreshBulkOutboundPrice(document.querySelector('#bulk-outbound-tbody tr')));
    assert.equal(await page.locator('.bulk-out-price-input').first().inputValue(),'0');
    await page.evaluate(()=>saveBulkOutbound());
    assert.deepEqual(await page.evaluate(()=>saved[0].map(row=>[row.price,row.amount,row.stockUnitPrice])),[[0,0,5000],[7500,15000,5000]]);
    assert.deepEqual(await page.evaluate(()=>{const stock=Object.values(getStockMap())[0];return [stock.stock,stock.stockBoxes,stock.price];}),[16,2,5000]);
    for(const price of ['', '-1']){
      await page.evaluate(price=>{resetFixture();prepareBulk(['0',price]);},price);
      await page.evaluate(()=>saveBulkOutbound());
      assert.equal(await page.evaluate(()=>saved.length),0,'An invalid row blocks the entire batch');
      assert.equal(await page.evaluate(()=>userTransactions.length),1);
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: explicit zero vs blank/negative in single/bulk and inline edits; no save-time price-list fallback; zero preview/list/edit retention; quantity/boxes decrease with stock cost unchanged; normal paid sales and all-or-nothing validation.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
