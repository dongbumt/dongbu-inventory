// Actual transaction list and cancellation handlers. All requests are fictional.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-product-delete-'));
const names=['htmlEscape','jsArg','parseOptionalBoxCount','boxCountDisplay','getFilteredTransactions','transactionDisplayRows','findPdaTransactionSummary','renderTransactions','openPdaTransactionDetails','closePdaTransactionDetails','renderPdaTransactionDetails','deleteTransaction'];
const functions=names.map(name=>{const match=html.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'));assert(match,name);return match[0];}).join('\n');new vm.Script(functions);
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><main></main>');});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],confirmations=[];let accept=true;
    page.on('pageerror',error=>errors.push(error.message));page.on('dialog',async dialog=>{confirmations.push(dialog.message());await (accept?dialog.accept():dialog.dismiss());});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(markup=>{const template=document.createElement('template');template.innerHTML=markup;const panel=template.content.querySelector('#p-transactions');panel.classList.add('active');document.querySelector('main').append(panel);document.body.append(template.content.querySelector('#txn-pda-detail-dialog'));},html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
    for(const file of ['pda-transaction-summary.js','stock-ledger.js','label-layout.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    await page.addScriptTag({content:`
      const base={date:'2026-11-11',product:'돈사태(작업)',lot:'L12611114894030',origin:'국내산',packunit:'5KG',stockLocation:'가공장',stockRowId:'qa-source',weight:12,boxCount:1,trader:'동원홈푸드',price:7500,amount:90000,_isUser:true};
      const source={...base,id:'qa-source-tx',type:'생산입고',weight:500,boxCount:40,price:5000,_prodId:'qa-production'};
      const boxes=Array.from({length:34},(_,i)=>({...base,id:'qa-ship-'+i,type:'출고',stockUnitPrice:5000,_pdaRequestId:'qa-request',_pdaLabelId:'qa-label-'+i,_pdaCode:'DB2611111200-ABC1'+String(i).padStart(2,'0'),_pdaAction:'ship'}));
      let userTransactions=[source,...structuredClone(boxes)],transactions=[...userTransactions],EXCEL_TRANSACTIONS=[],transactionListQueryActive=true,pdaTransactionDetailIds=[];
      let _editTxnId=null,pdaShipmentEditRows=[],requests=[],messages=[],failed=false,allowDelete=true,cleared=0;
      const SUPABASE_ENABLED_KEY='qa-enabled',transactionPricePendingIds=new Set();localStorage.setItem(SUPABASE_ENABLED_KEY,'1');
      const DBMTAuth={can:(menu,action)=>action!=='delete'||allowDelete};
      const getTxnStockLocation=t=>t.stockLocation||'가공장',toast=message=>messages.push(message),safeLocalStorageSet=()=>{},invalidateStockMap=()=>{};
      function clearTransactionForm(){cleared++;_editTxnId=null;pdaShipmentEditRows=[];}
      async function saveTransactionRows(rows,ids,previous){requests.push({rows:structuredClone(rows),ids:structuredClone(ids),previous:structuredClone(previous)});await new Promise(resolve=>setTimeout(resolve,100));if(failed)throw Error('QA returned box blocks cancellation');}
      function resetFixture(){userTransactions=[source,...structuredClone(boxes)];transactions=[...userTransactions];pdaTransactionDetailIds=[];_editTxnId=null;pdaShipmentEditRows=[];renderTransactions();}
      const balance=()=>DBMTStockLedger.rows(DBMTStockLedger.calculate(userTransactions))[0].stock;
      const boxBalance=()=>DBMTStockLedger.rows(DBMTStockLedger.calculate(userTransactions))[0].stockBoxes;
      ${functions}
      document.getElementById('t-filter-type').value='출고';renderTransactions();
    `});
    assert.equal(await page.locator('#t-body tr').count(),1);assert.equal(await page.evaluate(()=>balance()),92);assert.equal(await page.evaluate(()=>boxBalance()),6);
    const button=page.locator('#t-body').getByRole('button',{name:'삭제',exact:true});assert.equal(await button.count(),1);
    await page.locator('#p-transactions .card').last().screenshot({path:path.join(artifacts,'group-delete.png')});
    accept=false;await button.click();assert.equal(await page.evaluate(()=>requests.length),0);assert.match(confirmations[0],/34박스.*408\.00KG/);accept=true;
    await page.evaluate(()=>{allowDelete=false;});await page.evaluate(()=>deleteTransaction('pda-summary:qa-ship-0'));assert.equal(await page.evaluate(()=>requests.length),0);
    await page.evaluate(()=>{allowDelete=true;localStorage.setItem(SUPABASE_ENABLED_KEY,'0');});await page.evaluate(()=>deleteTransaction('pda-summary:qa-ship-0'));assert.equal(await page.evaluate(()=>requests.length),0);
    await page.evaluate(()=>{localStorage.setItem(SUPABASE_ENABLED_KEY,'1');failed=true;});await button.click();await page.waitForFunction(()=>!transactionPricePendingIds.size);assert.equal(await page.evaluate(()=>balance()),92);assert.equal(await page.evaluate(()=>userTransactions.length),35);assert.match(await page.evaluate(()=>messages.at(-1)),/QA returned/);
    await page.evaluate(()=>{failed=false;_editTxnId='pda-summary:qa-ship-0';pdaShipmentEditRows=structuredClone(boxes);});await button.click();await page.evaluate(()=>deleteTransaction('pda-summary:qa-ship-0'));await page.waitForFunction(()=>userTransactions.length===1);
    assert.equal(await page.evaluate(()=>requests.length),2);assert.equal(await page.evaluate(()=>requests.at(-1).ids.length),34);assert.equal(await page.evaluate(()=>requests.at(-1).previous.length),34);assert.equal(await page.evaluate(()=>cleared),1);assert.equal(await page.evaluate(()=>balance()),500);assert.equal(await page.evaluate(()=>boxBalance()),40);assert.match(await page.locator('#t-count').textContent(),/0건/);
    await page.evaluate(()=>resetFixture());await page.locator('#t-body').getByRole('button',{name:'박스별',exact:true}).click();assert.equal(await page.locator('#txn-pda-detail-body tr').count(),34);
    await page.locator('#txn-pda-detail-body tr').first().getByRole('button',{name:'삭제',exact:true}).click();await page.waitForFunction(()=>userTransactions.length===34);
    assert.equal(await page.evaluate(()=>requests.at(-1).ids.length),1);assert.equal(await page.locator('#txn-pda-detail-body tr').count(),33);assert.equal(await page.evaluate(()=>balance()),104);assert.equal(await page.evaluate(()=>boxBalance()),7);
    await page.locator('#txn-pda-detail-dialog').screenshot({path:path.join(artifacts,'one-box-deleted.png')});await page.getByRole('button',{name:'박스별 내역 닫기'}).click();
    for(const width of [1440,390]){await page.setViewportSize({width,height:900});await page.locator('#p-transactions .card').last().screenshot({path:path.join(artifacts,'list-'+width+'.png')});assert(await button.isVisible());}
    assert.deepEqual(errors,[]);console.log('PASS: real grouped/single PDA delete buttons, exact 34-box payload/confirmation, cancel/readonly/offline/duplicate/failure guards, inventory restoration, active edit reset, refreshed detail and 1440/390px layouts');console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
