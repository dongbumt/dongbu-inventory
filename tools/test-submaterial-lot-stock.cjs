/* Offline regression checks using fictional inventory only. Browser checks require
   Playwright and Chrome (NODE_PATH / CHROME_PATH may point to bundled dependencies). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const repo = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
const auth = fs.readFileSync(path.join(repo, 'm02-auth.js'), 'utf8');
const names = ['parseAppNumber', 'htmlEscape', 'jsArg', 'subMaterialUsageMatchesItem',
  'subMaterialRecordIsAfterCount', 'getSubMaterialLotUsedQty', 'getSubMaterialLotAvailable',
  'getSubMaterialLotCounts', 'getSubMaterialLotAdjustmentQty', 'subMaterialPersonalCan',
  'getSubMaterialStockRows', 'getSubMaterialLotStockRows', 'getFilteredSubMaterialLotStockRows',
  'getFilteredSubMaterialStockRows', 'clearSubMaterialStockFilters', 'renderSubMaterialStock', 'renderSubMaterials',
  'applySubMaterialStockResponse', 'refreshSubMaterialStockSnapshot', 'setSubMaterialCountBusy', 'renderSubMaterialCountForm',
  'openSubMaterialCount', 'closeSubMaterialCount', 'updateSubMaterialCountPreview', 'addSubMaterialCount',
  'deleteSubMaterialCount', 'deleteSubMaterialLot', 'exportSubMaterialsCSV', 'printSubMaterialCountSheet',
  'asArray','subMaterialUsageProductionEntry','subMaterialProductionSummary','subMaterialUsageWorkDate',
  'getProductionSubMaterialUsages','subMaterialUsageDraftId','createSubMaterialUsageDraft','subMaterialUsagePersonalCan',
  'subMaterialUsageDraftAvailable','renderSubMaterialUsageDraftRows','openSubMaterialUsageModal','closeSubMaterialUsageModal',
  'onSubMaterialUsageItemChange','onSubMaterialUsageLotChange',
  'subMaterialCertificateDateParts', 'subMaterialCertificateAddMonths', 'subMaterialCertificateStatus',
  'subMaterialCertificateAlertSummary', 'updateSubMaterialCertificateForm', 'renderSubMaterialItems'];
const functions = names.map(name => {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}).join('\n');
for(const [i, match] of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries()){
  new vm.Script(match[1], {filename:`index-inline-${i}`});
}
assert.match(auth, /'nav-submaterials':'submaterials'/);
assert.match(auth, /openSubMaterialCount:\['submaterials','view'/);

const items = [
  {id:'i1', code:'B001', name:'진공포장지', spec:'250×350', unit:'장'},
  {id:'i2', code:'B002', name:'라벨', spec:'70×100', unit:'롤'}
];
function lot(id, item, date, label, qty){
  return {id, itemId:item.id, itemCode:item.code, itemName:item.name, itemSpec:item.spec,
    unit:item.unit, date, lot:label, qty, trader:'테스트 포장업체', note:''};
}
const lots = [
  lot('l1', items[0], '2026-08-01', '000001-A', '1,000'),
  lot('l2', items[0], '2026-09-01', '000002-B', 200),
  lot('l3', items[1], '2026-09-03', 'LABEL-ZERO', .3),
  lot('l4', items[1], '2026-09-04', 'LABEL-NEGATIVE', 5),
  lot('l5', {id:'deleted', code:'B099', name:'삭제된 품목', unit:'개'}, '2026-07-01', 'OLD-LOT', 12),
  lot('l6', items[1], '2026-09-05', '000001-A', 30)
];
function usage(id, lotIndex, qty, workDate){
  const l = lots[lotIndex];
  return {id, lotId:l.id, lot:l.lot, itemId:l.itemId, itemCode:l.itemCode,
    itemName:l.itemName, itemSpec:l.itemSpec, qty, workDate, productionId:`prod-${id}`};
}
const usages = [usage('u1',0,200,'2026-08-02'), usage('u2',1,50,'2026-09-02'),
  usage('u3',2,.1,'2026-09-03'), usage('u4',2,.2,'2026-09-03'),
  usage('u5',3,6,'2026-09-04'), usage('u6',5,7,'2026-09-05')];
const counts = [{id:'count1', itemId:'i1', itemCode:'B001', itemName:'진공포장지', itemSpec:'250×350',
  date:'2026-08-31', qty:700, unit:'장', manager:'테스트 담당자', note:'실사 차이 확인'}];
const setup = `
  var subMaterialItems=${JSON.stringify(items)}, subMaterialLots=${JSON.stringify(lots)};
  var subMaterialUsages=${JSON.stringify(usages)}, subMaterialCounts=${JSON.stringify(counts)};
  var today='2026-09-14', messages=[], savedSnapshots=[], changeDetails=[], nextId=0, csv=null;
  var permissions={view:true,create:true,delete:true}, DBMTAuth={isPersonal:()=>true,can:(menu,action)=>!!permissions[action],getSessionToken:()=> 'fixture-token'};
  var subMaterialCountSaving=false,subMaterialCountLoadSeq=0,subMaterialCountsRevision='',subMaterialCountRequestId='';
  var subMaterialPendingSavePromise=Promise.resolve(),subMaterialPendingSaveKeys=new Set();
  var userProdEntries=[],EXCEL_PROD=[],subMaterialUsageDraftSeq=0,subMaterialUsageDraftRows=[],activeSubMaterialUsageProductionId='';
  var rpcCalls=[],rpcMode='',backendState=null,pendingReads=[],pendingSaves=[];
  function clone(value){return JSON.parse(JSON.stringify(value));}
  function stockFixtureSnapshot(){
    return clone(backendState || {items:subMaterialItems,lots:subMaterialLots,counts:subMaterialCounts,usages:subMaterialUsages,countsRevision:'fixture-revision'});
  }
  async function sbRpc(name,body){
    rpcCalls.push({name,body:clone(body)});
    const data=stockFixtureSnapshot();
    if(name==='dbmt_erp_get_submaterial_stock'){
      if(rpcMode==='read_error') throw new Error('QA read failure');
      if(rpcMode==='delay_read') return new Promise(resolve=>pendingReads.push(()=>resolve({ok:true,...data})));
      return {ok:true,...data};
    }
    if(name==='dbmt_erp_save_submaterial_count'){
      if(rpcMode==='save_error') throw new Error('QA save failure');
      if(rpcMode==='stock_conflict') return {ok:false,code:'stock_conflict',message:'QA stock conflict'};
      const complete=()=>{
        const record=body.p_record,existing=data.counts.find(row=>row.id===record.id);
        if(existing) return {ok:true,counts:data.counts,countsRevision:data.countsRevision,count:existing};
        const lot=data.lots.find(row=>String(row.id)===String(record.lotId));
        const used=data.usages.filter(row=>String(row.lotId)===String(lot.id)).reduce((sum,row)=>sum+Number(row.qty),0);
        const adjustments=data.counts.filter(row=>String(row.lotId)===String(lot.id)).reduce((sum,row)=>sum+Number(row.adjustmentQty),0);
        const systemQty=Number((parseAppNumber(lot.qty)-used+adjustments).toFixed(6));
        if(Math.abs(systemQty-record.expectedSystemQty)>.000001)return {ok:false,code:'stock_conflict',message:'QA stock conflict'};
        const count={...lot,id:record.id,lotId:lot.id,date:today,qty:record.qty,systemQty,
          adjustmentQty:Number((record.qty-systemQty).toFixed(6)),manager:record.manager,note:record.note,createdAt:'2026-09-14T02:00:00Z'};
        data.counts.push(count);data.countsRevision='fixture-revision-'+rpcCalls.length;
        if(backendState)backendState=clone(data);
        if(rpcMode==='save_after_commit')throw new Error('QA response lost after commit');
        return {ok:true,counts:data.counts,countsRevision:data.countsRevision,count};
      };
      if(rpcMode==='delay_save')return new Promise(resolve=>pendingSaves.push(()=>resolve(complete())));
      return complete();
    }
    if(name==='dbmt_erp_delete_submaterial_count'){
      if(rpcMode==='delete_error')throw new Error('QA delete failure');
      if(body.p_expected_revision!==data.countsRevision)return {ok:false,message:'QA revision conflict'};
      data.counts=data.counts.filter(row=>row.id!==body.p_count_id);data.countsRevision='fixture-revision-'+rpcCalls.length;
      if(backendState)backendState=clone(data);
      return {ok:true,counts:data.counts,countsRevision:data.countsRevision};
    }
    throw new Error('Unexpected fixture RPC '+name);
  }
  function localDateString(){return today;}
  function subMaterialId(){return 'count-qa-'+(++nextId);}
  function toast(message){messages.push(message);}
  function confirm(){return true;}
  function dataChangeDateLabel(date){return date;}
  function queueAppDataChangeDetail(entity,detail){changeDetails.push({entity,detail});}
  function saveSubMaterials(){savedSnapshots.push(JSON.parse(JSON.stringify({items:subMaterialItems,lots:subMaterialLots,counts:subMaterialCounts})));}
  function downloadCSV(rows,name){csv={rows,name};}
  function ensureSubMaterialCodes(){}
  function refreshSubMaterialItemOptions(){}
  function updateSubMaterialLotPreview(){}
  function renderSubMaterialUsageHistory(){}
`;
function harness(){
  const elements = {};
  for(const id of ['sm-stock-view','sm-stock-search','sm-stock-status','sm-stock-count',
    'sm-stock-lot-wrap','sm-stock-item-wrap','sm-stock-lot-note','sm-stock-lot-body','sm-stock-body',
    'sm-filter-month','sm-stock-month-label','sm-count-lot-id','sm-count-system-qty','sm-count-system-display',
    'sm-count-date','sm-count-qty','sm-count-unit','sm-count-manager','sm-count-note','sm-count-target',
    'sm-count-difference','sm-count-history','sm-count-modal','sm-count-title','sm-count-save-btn']){
    elements[id] = {value:'', style:{}, innerHTML:'', textContent:'', validity:{}, focus(){}, querySelectorAll(){return [];}, classList:{add(){},remove(){}}};
  }
  elements['sm-stock-view'].value = 'lot';
  elements['sm-stock-status'].value = 'all';
  const context = {document:{getElementById:id => elements[id]}, elements};
  vm.createContext(context);
  vm.runInContext(setup + functions, context);
  return context;
}
async function testLogic(){
  const ctx = harness();
  const before = JSON.stringify([ctx.subMaterialLots,ctx.subMaterialUsages,ctx.subMaterialCounts]);
  let rows = ctx.getSubMaterialLotStockRows();
  const row = id => rows.find(r => r.id === id);
  assert.equal(rows.length,6);
  assert.equal(row('l1').stockQty,800);
  assert.equal(row('l2').stockQty,150);
  assert.equal(row('l3').stockQty,0, 'decimal subtraction must not leave phantom stock');
  assert.equal(row('l3').status,'소진');
  assert.equal(row('l4').stockQty,-1, 'do not hide overuse by clamping to zero');
  assert.equal(row('l4').status,'음수 재고');
  assert.equal(row('l5').stockQty,12, 'retain history after item master deletion');
  assert.equal(row('l6').stockQty,23, 'same LOT text must not mix different receipt IDs');
  for(const r of rows) assert.ok(Math.abs(r.stockQty - ctx.getSubMaterialLotAvailable(r.id)) < .000001);
  const item = ctx.getSubMaterialStockRows().find(r => r.item.id === 'i1');
  assert.equal(item.managedQty,850, 'existing item-level count reconciliation is preserved');
  assert.equal(item.totalIn,1200);
  assert.equal(item.totalUsed,250);
  assert.equal(row('l1').stockQty+row('l2').stockQty,950, 'never allocate item counts to arbitrary LOTs');
  ctx.renderSubMaterialStock();
  assert.equal(ctx.elements['sm-stock-count'].textContent,'(LOT 6건)');
  assert.equal(JSON.stringify([ctx.subMaterialLots,ctx.subMaterialUsages,ctx.subMaterialCounts]),before);
  for(const [status, expected] of [['available',4],['empty',1],['negative',1]]){
    ctx.elements['sm-stock-status'].value=status;
    ctx.renderSubMaterialStock();
    assert.equal(ctx.elements['sm-stock-count'].textContent,`(LOT ${expected}건)`);
  }
  ctx.elements['sm-stock-status'].value='all';
  ctx.elements['sm-stock-search'].value='000002-b';
  ctx.renderSubMaterialStock();
  assert.equal(ctx.elements['sm-stock-count'].textContent,'(LOT 1건)');
  ctx.elements['sm-stock-search'].value='not found';
  ctx.renderSubMaterialStock();
  assert.match(ctx.elements['sm-stock-lot-body'].innerHTML,/조건에 맞는.*없습니다/);
  ctx.elements['sm-stock-search'].value='';
  ctx.subMaterialUsages=ctx.subMaterialUsages.filter(u => u.id!=='u1');
  assert.equal(ctx.getSubMaterialLotStockRows().find(r=>r.id==='l1').stockQty,1000,'deleting usage restores stock');
  ctx.subMaterialUsages.find(u=>u.id==='u2').qty=60;
  assert.equal(ctx.getSubMaterialLotStockRows().find(r=>r.id==='l2').stockQty,140,'editing usage updates stock');
  ctx.subMaterialLots.push({id:88, itemId:'i1', qty:'10.125'});
  ctx.subMaterialUsages.push({lotId:'88',qty:.125});
  const legacy=ctx.getSubMaterialLotStockRows().find(r=>r.id===88);
  assert.equal(legacy.stockQty,10,'string/number ID normalization');
  assert.equal(legacy.itemName,items[0].name,'master fallback for missing snapshot');
  const attack='<img src=x onerror=alert(1)>';
  ctx.subMaterialLots[0].lot=attack;
  ctx.subMaterialLots[0].trader=attack;
  ctx.subMaterialLots[0].note=attack;
  ctx.renderSubMaterialStock();
  assert.ok(!ctx.elements['sm-stock-lot-body'].innerHTML.includes('<img'));
  assert.ok(ctx.elements['sm-stock-lot-body'].innerHTML.includes('&lt;img'));
  ctx.subMaterialLots=[];
  ctx.renderSubMaterialStock();
  assert.equal(ctx.elements['sm-stock-count'].textContent,'(LOT 0건)');
  await testCountLogic();
  testCountPersistence();
  console.log('PASS: LOT calculation, ID isolation, decimals, negatives, history, count adjustments and legacy isolation, filters, escaping, empty data');
}

function testCountPersistence(){
  const context={};vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(repo,'Code.gs'),'utf8')+'\nglobalThis.mapping=DOMAIN_SHEETS.subMaterialCounts;',context);
  const mapping=context.mapping;
  const current={...counts[0],id:'count-lot',lotId:'l1',lot:'000001-A',qty:0,systemQty:12.125,adjustmentQty:-12.125,createdAt:'2026-09-14T02:00:00Z'};
  for(const field of ['lotId','lot','systemQty','adjustmentQty','createdAt']) assert.ok(mapping.headers.includes(field));
  const roundTrip=mapping.fromRows(mapping.toRows([current]))[0];
  for(const field of Object.keys(current)) assert.equal(roundTrip[field],current[field],`Sheets preserves ${field}`);
  const legacy=mapping.fromRows(mapping.toRows(counts))[0];
  for(const field of Object.keys(counts[0])) assert.equal(legacy[field],counts[0][field],`Historical count preserves ${field}`);
  assert.equal(legacy.lotId,'');assert.equal(legacy.systemQty,'');assert.equal(legacy.adjustmentQty,'');
}

async function testCountLogic(){
  const ctx=harness();
  const count=(id,lotId,systemQty,qty,date='2026-09-14',createdAt='2026-09-14T02:00:00Z')=>{
    const stock=ctx.subMaterialLots.find(row=>row.id===lotId);
    return {id,lotId,lot:stock.lot,itemId:stock.itemId,itemCode:stock.itemCode,itemName:stock.itemName,itemSpec:stock.itemSpec,
      systemQty,qty,adjustmentQty:qty-systemQty,date,createdAt,unit:stock.unit};
  };
  const stock=id=>ctx.getSubMaterialLotStockRows().find(row=>row.id===id);
  const item=()=>ctx.getSubMaterialStockRows().find(row=>row.item.id==='i1');
  ctx.subMaterialCounts.push(count('new-1','l1',800,795));
  assert.equal(stock('l1').stockQty,795);
  assert.equal(ctx.getSubMaterialLotAvailable('l1'),795);
  assert.equal(ctx.getSubMaterialLotAvailable('l1','prod-u1'),995,'Editing production restores its own usage after LOT adjustments');
  assert.equal(stock('l6').stockQty,23,'Same printed LOT text stays independent');
  assert.equal(item().managedQty,845,'New LOT delta adjusts the old item count without replacing its baseline');
  assert.equal(item().lotStockQty,945);
  assert.equal(item().latest.id,'count1');
  ctx.subMaterialCounts.push(count('new-2','l1',795,797,'2026-09-14','2026-09-14T03:00:00Z'));
  assert.equal(stock('l1').stockQty,797,'Repeated counts accumulate deltas, never actual quantities');
  assert.equal(stock('l1').totalAdjusted,-3);
  assert.equal(stock('l1').latestCount.id,'new-2');
  assert.equal(item().managedQty,847);
  ctx.subMaterialCounts.push(count('prior-lot-count','l1',800,790,'2026-08-20','2026-08-20T03:00:00Z'));
  assert.equal(stock('l1').stockQty,787);
  assert.equal(item().managedQty,847,'A LOT adjustment before the legacy item snapshot is already covered by that snapshot');
  ctx.subMaterialUsages.find(row=>row.id==='u1').qty=210;
  assert.equal(stock('l1').stockQty,777,'Editing a usage changes stock around fixed count deltas');
  ctx.subMaterialUsages=ctx.subMaterialUsages.filter(row=>row.id!=='u1');
  assert.equal(stock('l1').stockQty,987,'Deleting a usage restores its quantity after counts');
  await ctx.deleteSubMaterialCount('new-2');
  assert.equal(stock('l1').stockQty,985,'Deleting one count reverses only its own adjustment');
  ctx.subMaterialCounts.push(count('linked-count','l5',12,10));
  ctx.deleteSubMaterialLot('l5');
  assert.ok(ctx.subMaterialLots.some(row=>row.id==='l5'),'A counted LOT cannot be deleted');
  assert.match(ctx.messages.at(-1),/실사/);
  await ctx.openSubMaterialCount('l2');
  for(const invalid of ['','abc','NaN','Infinity','-1']){
    const before=ctx.subMaterialCounts.length;
    ctx.elements['sm-count-qty'].value=invalid;
    await ctx.addSubMaterialCount();
    assert.equal(ctx.subMaterialCounts.length,before,`Reject invalid count ${invalid}`);
  }
  ctx.elements['sm-count-qty'].value='0';
  await ctx.addSubMaterialCount();
  assert.equal(stock('l2').stockQty,0,'Zero is a valid physical count');
  ctx.permissions.create=false;
  const before=ctx.subMaterialCounts.length;
  await ctx.addSubMaterialCount();
  assert.equal(ctx.subMaterialCounts.length,before,'Count create permission is enforced');
  ctx.permissions.delete=false;
  await ctx.deleteSubMaterialCount('count1');
  assert.ok(ctx.subMaterialCounts.some(row=>row.id==='count1'),'Legacy count deletion is permission protected');
  ctx.elements['sm-filter-month'].value='2026-09';
  assert.equal(ctx.getFilteredSubMaterialLotStockRows().length,4);
  ctx.elements['sm-stock-search'].value='000002-b';
  ctx.exportSubMaterialsCSV();
  assert.equal(ctx.csv.rows.length,2,'LOT CSV respects the current query');
  assert.equal(ctx.csv.rows[1][1],'000002-B');
  assert.equal(ctx.csv.rows[1][9],0);
  ctx.elements['sm-stock-view'].value='item';ctx.elements['sm-stock-search'].value='진공';
  ctx.exportSubMaterialsCSV();
  assert.equal(ctx.csv.rows.length,2,'Item CSV uses the item query');
  assert.equal(ctx.csv.rows[1][0],'B001');
}

async function testBrowser(){
  const {chromium} = require('playwright');
  const executablePath = process.env.CHROME_PATH || [chromium.executablePath(),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(p=>fs.existsSync(p));
  const browser = await chromium.launch({headless:true, executablePath});
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-submaterial-lot-stock-'));
  try{
    const page = await browser.newPage({viewport:{width:1280,height:1024}});
    await page.context().addInitScript(()=>{window.print=()=>{};});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.abort());
    const section=html.slice(html.indexOf('<div class="tab-panel" id="p-submaterials">'),html.indexOf('<div class="tab-panel" id="p-invoice">'));
    const css=fs.readFileSync(path.join(repo,'styles/main.css'),'utf8');
    await page.setContent(`<!doctype html><html lang="ko"><meta charset="utf-8"><style>${css}</style><body><main style="padding:16px">${section}</main></body></html>`);
    await page.evaluate(markup=>{const template=document.createElement('template');template.innerHTML=markup;document.body.append(template.content.querySelector('#sm-usage-modal'));},html);
    await page.addScriptTag({content:setup+functions});
    await page.evaluate(()=>{document.querySelector('#p-submaterials').classList.add('active');renderSubMaterials();});
    const body=page.locator('#sm-stock-lot-body');
    assert.equal(await body.locator('tr').count(),6);
    assert.equal(await page.locator('#sm-stock-item-wrap').isVisible(),false);
    assert.equal(await page.locator('#sm-filter-month').inputValue(),'','Default month includes older stock');
    assert.equal(await page.locator('#sm-lot-body,#sm-count-item').count(),0,'Duplicate LOT list and item-wide count form are removed');
    assert.equal((await body.locator('tr').first().locator('td').count()),14);
    assert.ok((await body.innerText()).includes('2026-07-01'),'old LOT stock is not limited by inbound month');
    await page.locator('#sm-stock-status').selectOption('available');
    assert.equal(await body.locator('tr').count(),4);
    await page.locator('#sm-stock-search').fill('000002-b');
    assert.equal(await body.locator('tr').count(),1);
    assert.equal((await body.locator('td').allTextContents())[8],'150');
    await page.evaluate(()=>exportSubMaterialsCSV());
    const csv=await page.evaluate(()=>globalThis.csv);
    assert.equal(csv.rows.length,2);assert.equal(csv.rows[1][1],'000002-B');assert.equal(csv.rows[1][9],150);
    const popupEvent=page.waitForEvent('popup');
    await page.evaluate(()=>printSubMaterialCountSheet());
    const popup=await popupEvent;
    await popup.waitForSelector('tbody tr');
    assert.equal(await popup.locator('tbody tr').count(),1,'Print follows the filtered LOT query');
    assert.equal(await popup.locator('thead th').count(),10);
    assert.equal(await popup.locator('tbody td').count(),10);
    assert.match(await popup.locator('tbody').innerText(),/000002-B/);
    await popup.screenshot({path:path.join(artifacts,'count-sheet.png'),fullPage:true});
    await popup.close();
    await page.locator('#sm-stock-search').fill('테스트 포장업체');
    assert.equal(await body.locator('tr').count(),4);
    await page.locator('#sm-stock-search').fill('');
    await page.locator('#sm-stock-status').selectOption('all');
    const card=page.locator('.card').filter({has:page.locator('#sm-stock-view')});
    await card.screenshot({path:path.join(artifacts,'lot-stock-1280.png')});
    await page.locator('#sm-stock-view').selectOption('item');
    assert.equal(await page.locator('#sm-stock-lot-wrap').isVisible(),false);
    assert.equal(await page.locator('#sm-stock-item-wrap').isVisible(),true);
    assert.equal(await page.locator('#sm-stock-status').isVisible(),false);
    assert.equal(await page.locator('#sm-stock-body tr').count(),2);
    const bagRow=page.locator('#sm-stock-body tr').filter({hasText:'진공포장지'});
    assert.equal((await bagRow.locator('td').allTextContents())[6],'950');
    assert.equal((await bagRow.locator('td').allTextContents())[7],'850');
    assert.equal(await bagRow.getByRole('button',{name:'기존 실사삭제'}).count(),1);
    assert.match(await page.locator('#sm-stock-lot-note').innerText(),/임의로 배분하지/);
    await page.locator('#sm-stock-search').fill('진공');
    assert.equal(await page.locator('#sm-stock-body tr').count(),1);
    await page.locator('#sm-stock-search').fill('');
    await page.locator('#sm-stock-view').selectOption('lot');
    await page.locator('#sm-filter-month').fill('2026-09');
    await page.locator('#sm-filter-month').dispatchEvent('change');
    assert.equal(await body.locator('tr').count(),4);
    await page.evaluate(()=>clearSubMaterialStockFilters());
    assert.equal(await body.locator('tr').count(),6);
    await page.evaluate(()=>{subMaterialUsages.find(u=>u.id==='u2').qty=60;renderSubMaterials();});
    const updated=body.locator('tr').filter({hasText:'000002-B'});
    assert.equal((await updated.locator('td').allTextContents())[8],'140');
    await page.locator('#sm-in-trader').fill('입력 중 거래처 보존');
    await page.locator('#sm-stock-search').fill('not found');
    assert.match(await body.innerText(),/조건에 맞는.*없습니다/);
    assert.equal(await page.locator('#sm-in-trader').inputValue(),'입력 중 거래처 보존');
    await page.locator('#sm-stock-search').fill('');
    await testCountBrowser(page,artifacts);
    await testRpcBrowser(page);
    await testUsageSnapshotBrowser(page);
    await page.setViewportSize({width:1024,height:768});
    await card.screenshot({path:path.join(artifacts,'lot-stock-1024.png')});
    assert.deepEqual(errors,[]);
    console.log(`PASS: unified LOT list, all-month default, item legacy totals, filtered CSV/print, count modal save/stale guards, permissions and draft preservation. Artifacts: ${artifacts}`);
  }finally{await browser.close();}
}

async function testCountBrowser(page,artifacts){
  const state=()=>page.evaluate(()=>({counts:subMaterialCounts,rows:getSubMaterialLotStockRows(),messages,snapshots:savedSnapshots}));
  const open=async lotId=>{await page.evaluate(id=>openSubMaterialCount(id),lotId);assert(await page.locator('#sm-count-modal').isVisible());};
  const save=()=>page.evaluate(()=>addSubMaterialCount());
  await open('l2');
  assert.equal(await page.locator('#sm-count-date').inputValue(),'2026-09-14');
  assert.equal(await page.locator('#sm-count-date').getAttribute('readonly'),'');
  assert.equal(await page.locator('#sm-count-system-qty').inputValue(),'140');
  await page.locator('#sm-count-qty').fill('135');
  await page.locator('#sm-count-manager').fill('가상 실사자');
  await page.locator('#sm-count-note').fill('가상 파손품 제외');
  assert.match(await page.locator('#sm-count-difference').innerText(),/조정수량: -5/);
  await page.locator('#sm-count-modal').screenshot({path:path.join(artifacts,'lot-count-modal.png')});
  await save();
  let current=await state();
  assert.equal(current.counts.length,2);
  assert.equal(current.rows.find(row=>row.id==='l2').stockQty,135);
  assert.equal(current.counts[1].lotId,'l2');assert.equal(current.counts[1].lot,'000002-B');
  assert.equal(current.counts[1].systemQty,140);assert.equal(current.counts[1].adjustmentQty,-5);assert.equal(current.counts[1].qty,135);
  assert.equal(current.counts[1].manager,'가상 실사자');assert.ok(current.counts[1].createdAt);
  assert(await page.locator('#sm-count-modal').isHidden());
  assert.equal(await page.locator('#sm-in-trader').inputValue(),'입력 중 거래처 보존');
  await open('l2');await page.locator('#sm-count-qty').fill('137');await save();
  current=await state();assert.equal(current.counts.length,3);assert.equal(current.rows.find(row=>row.id==='l2').stockQty,137);
  assert.equal(current.counts[2].adjustmentQty,2);
  await open('l2');await page.locator('#sm-count-qty').fill('130');
  await page.evaluate(()=>{subMaterialUsages.find(row=>row.id==='u2').qty=65;});
  await save();current=await state();
  assert.equal(current.counts.length,3,'A changed stock snapshot requires a second deliberate save');
  assert.match(current.messages.at(-1),/전산재고가 변경/);
  assert.equal(await page.locator('#sm-count-system-qty').inputValue(),'132');
  assert.equal(await page.locator('#sm-count-qty').inputValue(),'130','Keep entered physical count after a snapshot conflict');
  await save();current=await state();
  assert.equal(current.counts.length,4);assert.equal(current.rows.find(row=>row.id==='l2').stockQty,130);
  await open('l2');
  assert.equal(await page.locator('#sm-count-history button').count(),3);
  await page.evaluate(()=>deleteSubMaterialCount(subMaterialCounts.at(-1).id));
  current=await state();assert.equal(current.rows.find(row=>row.id==='l2').stockQty,132);
  assert.equal(await page.locator('#sm-count-system-qty').inputValue(),'132');
  await page.evaluate(()=>closeSubMaterialCount());
  await open('l6');
  for(const invalid of ['','-1','1.0000001']){
    await page.locator('#sm-count-qty').fill(invalid);await save();
    assert.equal((await state()).counts.length,3,'Invalid count must not persist');
  }
  await page.locator('#sm-count-qty').fill('0');await save();current=await state();
  assert.equal(current.rows.find(row=>row.id==='l6').stockQty,0);
  await page.evaluate(()=>{permissions.create=false;permissions.delete=false;renderSubMaterialStock();});
  assert.equal(await page.locator('#sm-stock-lot-body').getByRole('button',{name:'이력',exact:true}).count(),6,'Read-only users can open LOT count history');
  assert.equal(await page.locator('#sm-stock-lot-body').getByRole('button',{name:'삭제',exact:true}).count(),0);
  await page.locator('#sm-stock-lot-body tr').filter({hasText:'000002-B'}).getByRole('button',{name:'이력',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('sm-count-lot-id').value==='l2');
  assert(await page.locator('#sm-count-modal').isVisible());
  assert.match(await page.locator('#sm-count-title').innerText(),/실사 이력/);
  assert(await page.locator('#sm-count-save-btn').isHidden());
  assert(await page.locator('#sm-count-qty').isDisabled());assert(await page.locator('#sm-count-manager').isDisabled());
  assert.equal(await page.locator('#sm-count-history button').count(),0,'View-only users cannot delete count history');
  const readOnlyBefore=await page.evaluate(()=>JSON.stringify(subMaterialCounts));
  await page.evaluate(async()=>{await addSubMaterialCount();await deleteSubMaterialCount(getSubMaterialLotCounts('l2')[0].id);});
  assert.equal(await page.evaluate(()=>JSON.stringify(subMaterialCounts)),readOnlyBefore,'Direct count create/delete calls enforce permissions too');
  await page.evaluate(()=>{closeSubMaterialCount();permissions.delete=true;renderSubMaterialStock();});
  await page.locator('#sm-stock-lot-body tr').filter({hasText:'000002-B'}).getByRole('button',{name:'이력',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('sm-count-lot-id').value==='l2');
  const deletedId=await page.evaluate(()=>getSubMaterialLotCounts('l2')[0].id);
  const saveRpcCount=await page.evaluate(()=>rpcCalls.filter(call=>call.name==='dbmt_erp_save_submaterial_count').length);
  assert.equal(await page.locator('#sm-count-history button').count(),2,'View+delete users can reach count deletion without create permission');
  await page.locator('#sm-count-history button').first().click();
  await page.waitForFunction(id=>!subMaterialCounts.some(count=>count.id===id),deletedId);
  assert.equal(await page.locator('#sm-count-history button').count(),1,'Successful deletion refreshes read-only history');
  assert(await page.locator('#sm-count-modal').isVisible());assert(await page.locator('#sm-count-save-btn').isHidden());
  assert(await page.locator('#sm-count-qty').isDisabled());
  await page.evaluate(()=>addSubMaterialCount());
  assert.equal(await page.evaluate(()=>rpcCalls.filter(call=>call.name==='dbmt_erp_save_submaterial_count').length),saveRpcCount,'Delete permission never grants count creation');
  await page.evaluate(()=>{closeSubMaterialCount();permissions.view=false;});
  await page.evaluate(()=>openSubMaterialCount('l2'));assert(await page.locator('#sm-count-modal').isHidden(),'No-view users cannot open count history');
  await page.evaluate(()=>{permissions.view=true;permissions.create=true;permissions.delete=true;renderSubMaterialStock();});
}

async function testRpcBrowser(page){
  await page.evaluate(()=>{backendState=stockFixtureSnapshot();rpcMode='';});
  const open=()=>page.evaluate(()=>openSubMaterialCount('l1'));
  const save=()=>page.evaluate(()=>addSubMaterialCount());
  const snapshot=()=>page.evaluate(()=>({counts:clone(subMaterialCounts),server:clone(backendState),calls:clone(rpcCalls),messages,
    saving:subMaterialCountSaving,stock:getSubMaterialLotAvailable('l1'),requestId:subMaterialCountRequestId}));
  await open();await page.locator('#sm-count-qty').fill('790');
  let before=await snapshot();
  await page.evaluate(()=>rpcMode='save_error');await save();
  let after=await snapshot();
  assert.deepEqual(after.counts,before.counts,'A failed server write must leave local count history untouched');
  assert.equal(after.saving,false);assert(await page.locator('#sm-count-modal').isVisible());
  assert.equal(await page.locator('#sm-count-qty').inputValue(),'790');assert(await page.locator('#sm-count-qty').isEnabled());
  await page.evaluate(()=>rpcMode='');await save();after=await snapshot();
  const retried=after.calls.filter(call=>call.name==='dbmt_erp_save_submaterial_count').slice(-2);
  assert.equal(retried[0].body.p_record.id,retried[1].body.p_record.id,'Retry reuses the same idempotency ID');
  assert.equal(after.stock,790);

  await open();await page.locator('#sm-count-qty').fill('789');before=await snapshot();
  await page.evaluate(()=>rpcMode='save_after_commit');await save();after=await snapshot();
  assert.deepEqual(after.counts,before.counts,'Lost responses cannot optimistically mutate local history');
  assert.equal(after.server.counts.length,before.server.counts.length+1,'The fictional server committed before its response was lost');
  const ambiguousId=after.requestId;
  await page.evaluate(()=>rpcMode='');await save();after=await snapshot();
  assert.equal(after.counts.filter(count=>count.id===ambiguousId).length,1,'An uncertain retry must not apply the adjustment twice');
  assert.equal(after.stock,789);

  await open();await page.locator('#sm-count-qty').fill('785');
  await page.evaluate(()=>backendState.usages.push({id:'other-window-use',productionId:'other-window',lotId:'l1',qty:2}));
  before=await snapshot();await save();after=await snapshot();
  assert.equal(after.counts.length,before.counts.length,'Concurrent server stock changes require review before saving');
  assert.equal(await page.locator('#sm-count-system-qty').inputValue(),'787');
  assert.equal(await page.locator('#sm-count-qty').inputValue(),'785');
  assert(await page.locator('#sm-count-modal').isVisible());
  await save();after=await snapshot();assert.equal(after.stock,785);

  await open();await page.locator('#sm-count-qty').fill('784');before=await snapshot();
  await page.evaluate(()=>{rpcMode='delay_save';window.delayedMutation=addSubMaterialCount();});
  after=await snapshot();assert.equal(after.saving,true);assert.deepEqual(after.counts,before.counts,'Only a successful server response may update local counts');
  assert(await page.locator('#sm-count-qty').isDisabled());
  await page.evaluate(()=>{closeSubMaterialCount();addSubMaterialCount();});
  assert(await page.locator('#sm-count-modal').isVisible());
  assert.equal((await snapshot()).calls.length,after.calls.length,'Duplicate clicks while saving cannot start a second write');
  await page.evaluate(async()=>{pendingSaves.shift()();await delayedMutation;rpcMode='';});
  after=await snapshot();assert.equal(after.stock,784);

  await open();before=await snapshot();
  const deleteId=before.counts.find(count=>count.lotId==='l1').id;
  await page.evaluate(id=>{rpcMode='delete_error';return deleteSubMaterialCount(id);},deleteId);
  after=await snapshot();assert.deepEqual(after.counts,before.counts,'Delete failure retains the adjustment');
  await page.evaluate(id=>{rpcMode='';return deleteSubMaterialCount(id);},deleteId);
  after=await snapshot();assert(!after.counts.some(count=>count.id===deleteId));
  const deletion=after.calls.filter(call=>call.name==='dbmt_erp_delete_submaterial_count').at(-1);
  assert.ok(deletion.body.p_expected_revision,'Delete sends a fresh server revision');
  await page.evaluate(()=>closeSubMaterialCount());

  await page.evaluate(()=>{
    rpcMode='delay_read';window.firstRead=openSubMaterialCount('l1');window.secondRead=openSubMaterialCount('l2');
  });
  assert.equal(await page.evaluate(()=>pendingReads.length),2);
  await page.evaluate(async()=>{pendingReads[1]();await secondRead;});
  assert.equal(await page.locator('#sm-count-lot-id').inputValue(),'l2');
  await page.locator('#sm-count-qty').fill('111');
  await page.evaluate(async()=>{pendingReads[0]();await firstRead;pendingReads=[];});
  assert.equal(await page.locator('#sm-count-lot-id').inputValue(),'l2','A slower earlier read must not replace the later LOT selection');
  assert.equal(await page.locator('#sm-count-qty').inputValue(),'111');
  await page.evaluate(()=>{closeSubMaterialCount();window.closedRead=openSubMaterialCount('l1');closeSubMaterialCount();});
  await page.evaluate(async()=>{pendingReads[0]();await closedRead;pendingReads=[];rpcMode='';});
  assert(await page.locator('#sm-count-modal').isHidden(),'Closing a pending read keeps the modal closed when the response arrives');
  assert.equal(await page.locator('#sm-count-lot-id').inputValue(),'');
  console.log('PASS: response-only updates, failed-save retention, idempotent/ambiguous retries, concurrent stock conflict, busy guards, revision deletion and out-of-order reads');
}

async function testUsageSnapshotBrowser(page){
  await page.evaluate(()=>{
    permissions.update=true;rpcMode='';
    userProdEntries=[{id:'fresh-production',date:'2026/09/14',job_no:'1',outputs:[{product:'가상 생산품',qty:1}]},
      {id:'new-production',date:'2026/09/14',job_no:'2',outputs:[]}];
    subMaterialItems=[{id:'fresh-item',name:'오래된 품목명',unit:'장'}];
    subMaterialLots=[{id:'fresh-lot',itemId:'fresh-item',qty:999,lot:'FRESH-LOT',unit:'장'}];
    subMaterialCounts=[];subMaterialUsages=[];
    backendState={
      items:[{id:'fresh-item',name:'최신 가상 포장지',unit:'장'}],
      lots:[{id:'fresh-lot',itemId:'fresh-item',qty:100,lot:'FRESH-LOT',unit:'장',date:'2026-09-10'}],
      counts:[{id:'fresh-count',lotId:'fresh-lot',qty:40,systemQty:50,adjustmentQty:-10,date:'2026-09-14'}],
      usages:[{id:'fresh-use',productionId:'fresh-production',lotId:'fresh-lot',itemId:'fresh-item',qty:20},
        {id:'other-use',productionId:'other-production',lotId:'fresh-lot',itemId:'fresh-item',qty:30}],
      countsRevision:'fresh-revision'
    };
  });
  const beforeCalls=await page.evaluate(()=>rpcCalls.length);
  await page.evaluate(()=>openSubMaterialUsageModal('fresh-production'));
  assert(await page.locator('#sm-usage-modal').isVisible());
  const snapshot=await page.evaluate(()=>({drafts:clone(subMaterialUsageDraftRows),qty:getSubMaterialLotAvailable('fresh-lot'),
    available:subMaterialUsageDraftAvailable(subMaterialUsageDraftRows[0]),items:clone(subMaterialItems),calls:rpcCalls.length}));
  assert.equal(snapshot.calls,beforeCalls+1,'Opening production usage always fetches the whole latest stock snapshot');
  assert.equal(snapshot.items[0].name,'최신 가상 포장지');
  assert.equal(snapshot.qty,40,'Fresh physical-count adjustment is reflected before opening usage');
  assert.equal(snapshot.drafts.length,1);assert.equal(snapshot.drafts[0].id,'fresh-use');assert.equal(snapshot.drafts[0].qty,20);
  assert.equal(snapshot.available,60,'Editing restores the current production usage on top of refreshed count-adjusted stock');
  assert.equal(await page.locator('#sm-usage-edit-body tr td').nth(2).innerText(),'60');
  assert.match(await page.locator('#sm-usage-edit-body tr select').nth(1).innerText(),/가용 60/);
  await page.evaluate(()=>{closeSubMaterialUsageModal();return openSubMaterialUsageModal('new-production');});
  await page.evaluate(()=>{const draft=subMaterialUsageDraftRows[0];onSubMaterialUsageItemChange(draft.draftId,'fresh-item');onSubMaterialUsageLotChange(draft.draftId,'fresh-lot');});
  assert.equal(await page.locator('#sm-usage-edit-body tr').first().locator('td').nth(2).innerText(),'40','A new production uses current stock without restoring another production usage');
  await page.evaluate(()=>closeSubMaterialUsageModal());
  const beforeFailure=await page.evaluate(()=>JSON.stringify([subMaterialItems,subMaterialLots,subMaterialCounts,subMaterialUsages]));
  await page.evaluate(()=>{rpcMode='read_error';return openSubMaterialUsageModal('fresh-production');});
  assert(await page.locator('#sm-usage-modal').isHidden(),'A failed fresh-stock read does not open the usage editor');
  assert.equal(await page.evaluate(()=>JSON.stringify([subMaterialItems,subMaterialLots,subMaterialCounts,subMaterialUsages])),beforeFailure);
  assert.match(await page.evaluate(()=>messages.at(-1)),/QA read failure/);
  await page.evaluate(()=>rpcMode='');
  console.log('PASS: usage editor refreshes items/LOTs/counts/usages before draft creation, restores only its own usage and stays closed on read failure');
}

(async()=>{await testLogic(); if(!process.argv.includes('--unit-only')) await testBrowser();})()
  .catch(error=>{console.error(error);process.exitCode=1;});
