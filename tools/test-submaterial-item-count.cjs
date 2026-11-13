const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const names=['parseAppNumber','htmlEscape','jsArg','subMaterialUsageMatchesItem','subMaterialRecordIsAfterCount','getSubMaterialLotCounts','getSubMaterialLotAdjustmentQty',
  'getSubMaterialStockRows','getSubMaterialLotStockRows','getFilteredSubMaterialStockRows','getFilteredSubMaterialLotStockRows','renderSubMaterialStock','subMaterialPersonalCan',
  'subMaterialLotMatchesItem','getSubMaterialItemCountLots','subMaterialItemCountSnapshot','subMaterialCountTarget','subMaterialItemCountPlan','renderSubMaterialCountHistory',
  'applySubMaterialStockResponse','refreshSubMaterialStockSnapshot','setSubMaterialCountBusy','openSubMaterialCount','renderSubMaterialCountForm',
  'closeSubMaterialCount','updateSubMaterialCountPreview','addSubMaterialCount','deleteSubMaterialCount'];
const functions=names.map(name=>{const match=html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));assert(match,name);return match[0]}).join('\n');

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-submaterial-item-count-'));
  try{
    const page=await browser.newPage({viewport:{width:1366,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort());
    await page.setContent('<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body><main class="main" id="p-submaterials"></main></body></html>');
    await page.evaluate(markup=>{
      const template=document.createElement('template');template.innerHTML=markup;
      document.querySelector('main').append(template.content.querySelector('#sm-stock-item-wrap').closest('.card'));
      document.body.append(template.content.querySelector('#sm-count-modal'));
    },html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
    await page.addScriptTag({content:`
      var today='2026-11-13',permissions={view:true,create:true,delete:true},messages=[],requests=[],rpcMode='fail',nextId=0;
      var subMaterialItems=[{id:'item',code:'B1',name:'진공포장지',spec:'250×350',unit:'장'},{id:'other',code:'B2',name:'진공포장지',spec:'250×350',unit:'장'}];
      var originalLots=[{id:'l3',itemId:'item',date:'2026-11-03',lot:'LOT-C',qty:20,unit:'장'},
        {id:'l1',itemId:'item',date:'2026-11-01',lot:'LOT-A',qty:30,unit:'장'},
        {id:'l2',itemId:'item',date:'2026-11-02',lot:'LOT-B',qty:50,unit:'장'},
        {id:'other-lot',itemId:'other',date:'2026-10-01',lot:'LOT-A',qty:999,unit:'장'}];
      var originalUsages=[{id:'other-usage',lotId:'other-lot',itemId:'other',itemName:'진공포장지',itemSpec:'250×350',qty:10}];
      var legacy={id:'legacy',itemId:'item',qty:123,date:'2026-01-01',unit:'장'};
      var backend={items:subMaterialItems,lots:structuredClone(originalLots),usages:structuredClone(originalUsages),counts:[legacy],countsRevision:'r0'};
      var subMaterialLots=structuredClone(backend.lots),subMaterialUsages=structuredClone(backend.usages),subMaterialCounts=[legacy];
      var subMaterialCountSaving=false,subMaterialCountLoadSeq=0,subMaterialCountRequestId='',subMaterialCountsRevision='r0',subMaterialPendingSavePromise=Promise.resolve();
      var DBMTAuth={isPersonal:()=>true,can:(_,action)=>permissions[action],getSessionToken:()=> 'qa'};
      function localDateString(){return today} function subMaterialId(){return 'qa-'+(++nextId)} function toast(m){messages.push(m)}
      function renderSubMaterials(){renderSubMaterialStock()} function renderSubMaterialInboundHistory(){}
      window.confirm=()=>true;
      async function sbRpc(name,params){
        requests.push({name,params:structuredClone(params)});
        if(name==='dbmt_erp_get_submaterial_stock')return {ok:true,...structuredClone(backend)};
        if(name==='dbmt_erp_save_submaterial_item_count'){
          if(rpcMode==='fail')throw Error('QA save failed');
          if(rpcMode==='conflict')return {ok:false,code:'stock_conflict',message:'QA LOT conflict'};
          const r=params.p_record;
          if(backend.counts.length===1){
            const common={date:today,itemId:'item',itemName:'진공포장지',unit:'장',itemCountId:r.id,itemCountQty:40,itemCountSystemQty:100,itemCountAdjustmentQty:-60,manager:r.manager,note:r.note,createdAt:'2026-11-13T01:00:00Z'};
            backend.counts=[legacy,{...common,id:r.id,lotId:'l1',lot:'LOT-A',qty:0,systemQty:30,adjustmentQty:-30,itemCountRequest:r,itemCountIds:[r.id,'child']},
              {...common,id:'child',lotId:'l2',lot:'LOT-B',qty:20,systemQty:50,adjustmentQty:-30}];backend.countsRevision='r1';
            if(rpcMode==='lost')throw Error('QA response lost');
          }
          return {ok:true,...structuredClone(backend)};
        }
        if(name==='dbmt_erp_delete_submaterial_count'){backend.counts=[legacy];backend.countsRevision='r2';return {ok:true,...structuredClone(backend)}}
        throw Error('Unexpected RPC '+name);
      }
      ${functions}
    `});
    await page.locator('#sm-stock-view').selectOption('item');
    const firstRow=page.locator('#sm-stock-body tr').filter({hasText:'B1'});
    assert.equal(await firstRow.locator('td').nth(6).textContent(),'100','Same names must not merge different master IDs');
    await firstRow.getByRole('button',{name:'실사',exact:true}).click();
    assert.match(await page.locator('#sm-count-title').innerText(),/품목 합계/);
    assert.equal(await page.locator('#sm-count-system-display').inputValue(),'100');
    const original=await page.evaluate(()=>JSON.stringify([subMaterialLots,subMaterialUsages]));
    await page.locator('#sm-count-qty').fill('40');
    const preview=page.locator('#sm-count-difference');
    assert.match(await preview.innerText(),/LOT-A: 30 → 0/);assert.match(await preview.innerText(),/LOT-B: 50 → 20/);
    assert.doesNotMatch(await preview.innerText(),/LOT-C/);
    await page.locator('#sm-count-qty').fill('125');
    assert.match(await preview.innerText(),/LOT-A: 30 → 55/);assert.doesNotMatch(await preview.innerText(),/LOT-B/);
    await page.locator('#sm-count-qty').fill('40');await page.locator('#sm-count-manager').fill('담당자');
    await page.locator('#sm-count-note').fill('파손품 제외');
    await page.screenshot({path:path.join(artifacts,'preview.png')});
    await page.locator('#sm-count-save-btn').click();
    assert.match(await page.evaluate(()=>messages.at(-1)),/QA save failed/);
    assert.equal(await page.locator('#sm-count-qty').inputValue(),'40');
    assert.equal(await page.evaluate(()=>subMaterialCounts.length),1);
    const request=await page.evaluate(()=>requests.find(r=>r.name==='dbmt_erp_save_submaterial_item_count').params.p_record);
    assert.deepEqual(Object.keys(request.expectedLots).sort(),['l1','l2','l3']);assert.equal(request.expectedSystemQty,100);
    assert.equal(request.itemId,'item');assert.equal(request.lotId,undefined);
    // Local changes, even with the same total, require another explicit save.
    const savedCalls=await page.evaluate(()=>requests.filter(r=>r.name==='dbmt_erp_save_submaterial_item_count').length);
    await page.evaluate(()=>{subMaterialLots.find(l=>l.id==='l1').qty=29;subMaterialLots.find(l=>l.id==='l2').qty=51});
    await page.locator('#sm-count-save-btn').click();
    assert.equal(await page.evaluate(()=>requests.filter(r=>r.name==='dbmt_erp_save_submaterial_item_count').length),savedCalls);
    assert.match(await page.evaluate(()=>messages.at(-1)),/전산재고가 변경/);
    await page.evaluate(()=>{backend.lots=structuredClone(originalLots);subMaterialLots=structuredClone(originalLots);rpcMode='conflict'});
    await page.locator('#sm-count-save-btn').click(); // acknowledge the local revision back to its original values
    await page.locator('#sm-count-save-btn').click();
    assert.match(await page.evaluate(()=>messages.at(-1)),/QA LOT conflict/);
    await page.evaluate(()=>rpcMode='lost');
    await page.locator('#sm-count-save-btn').click();
    assert.match(await page.evaluate(()=>messages.at(-1)),/response lost/);
    assert.equal(await page.evaluate(()=>subMaterialCounts.length),1,'A lost response cannot mutate the local stock optimistically');
    await page.evaluate(()=>rpcMode='success');await page.locator('#sm-count-save-btn').click();
    assert.equal(await page.locator('#sm-count-modal').isHidden(),true);
    const retries=await page.evaluate(()=>requests.filter(r=>r.name==='dbmt_erp_save_submaterial_item_count').map(r=>r.params.p_record.id));
    assert.equal(new Set(retries).size,1,'Retries reuse the same idempotency key');
    assert.equal(await page.evaluate(()=>JSON.stringify([subMaterialLots,subMaterialUsages])),original);
    assert.equal(await firstRow.locator('td').nth(6).textContent(),'40');
    assert.equal(await firstRow.locator('td').nth(10).textContent(),'40');
    await firstRow.getByRole('button',{name:'실사',exact:true}).click();
    const history=page.locator('#sm-count-history');
    assert.equal(await history.getByRole('button',{name:'삭제',exact:true}).count(),2,'One group deletion plus the preserved legacy count');
    assert.match(await history.innerText(),/LOT LOT-A: 30 → 0/);assert.match(await history.innerText(),/LOT LOT-B: 50 → 20/);
    await history.getByRole('button',{name:'삭제',exact:true}).first().click();
    assert.equal(await firstRow.locator('td').nth(6).textContent(),'100');
    await page.evaluate(()=>{closeSubMaterialCount();permissions.create=false;renderSubMaterialStock()});
    await firstRow.getByRole('button',{name:'이력',exact:true}).click();
    assert.equal(await page.locator('#sm-count-save-btn').isVisible(),false);
    const before=await page.evaluate(()=>requests.length);await page.evaluate(()=>addSubMaterialCount());
    assert.equal(await page.evaluate(()=>requests.length),before);
    for(const [width,height] of [[1280,720],[390,844]]){
      await page.setViewportSize({width,height});
      const modal=await page.locator('#sm-count-modal .edit-modal').boundingBox();assert.ok(modal.x>=0&&modal.x+modal.width<=width+1);
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: item count button, item identity isolation, oldest-first preview, stable request payloads/retries, same-total local and server conflicts, failed/lost response retention, group history/deletion, permissions and responsive dialog. QA: '+artifacts);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
