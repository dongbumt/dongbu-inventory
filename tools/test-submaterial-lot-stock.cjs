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
  'getSubMaterialStockRows', 'getSubMaterialLotStockRows', 'renderSubMaterialStock', 'renderSubMaterials'];
const functions = names.map(name => {
  const match = html.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}).join('\n');
for(const [i, match] of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries()){
  new vm.Script(match[1], {filename:`index-inline-${i}`});
}
assert.match(auth, /'nav-submaterials':'submaterials'/);

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
  var today='2026-09-10';
  function ensureSubMaterialCodes(){}
  function refreshSubMaterialItemOptions(){}
  function updateSubMaterialLotPreview(){}
  function renderSubMaterialUsageHistory(){}
`;
function harness(){
  const elements = {};
  for(const id of ['sm-stock-view','sm-stock-search','sm-stock-status','sm-stock-count',
    'sm-stock-lot-wrap','sm-stock-item-wrap','sm-stock-lot-note','sm-stock-lot-body','sm-stock-body']){
    elements[id] = {value:'', style:{}, innerHTML:'', textContent:''};
  }
  elements['sm-stock-view'].value = 'lot';
  elements['sm-stock-status'].value = 'all';
  const context = {document:{getElementById:id => elements[id]}, elements};
  vm.createContext(context);
  vm.runInContext(setup + functions, context);
  return context;
}
function testLogic(){
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
  console.log('PASS: LOT calculation, ID isolation, decimals, negatives, history, edits/deletes, counts unchanged, filters, escaping, empty data');
}

async function testBrowser(){
  const {chromium} = require('playwright');
  const executablePath = process.env.CHROME_PATH || [chromium.executablePath(),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(p=>fs.existsSync(p));
  const browser = await chromium.launch({headless:true, executablePath});
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-submaterial-lot-stock-'));
  try{
    const page = await browser.newPage({viewport:{width:1280,height:1024}});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.abort());
    const section=html.slice(html.indexOf('<div class="tab-panel" id="p-submaterials">'),html.indexOf('<div class="tab-panel" id="p-invoice">'));
    const css=fs.readFileSync(path.join(repo,'styles/main.css'),'utf8');
    await page.setContent(`<!doctype html><html lang="ko"><meta charset="utf-8"><style>${css}</style><body><main style="padding:16px">${section}</main></body></html>`);
    await page.addScriptTag({content:setup+functions});
    await page.evaluate(()=>{document.querySelector('#p-submaterials').classList.add('active');renderSubMaterials();});
    const body=page.locator('#sm-stock-lot-body');
    assert.equal(await body.locator('tr').count(),6);
    assert.equal(await page.locator('#sm-stock-item-wrap').isVisible(),false);
    assert.equal(await page.locator('#sm-filter-month').inputValue(),'2026-09');
    assert.ok((await body.innerText()).includes('2026-07-01'),'old LOT stock is not limited by inbound month');
    await page.locator('#sm-stock-status').selectOption('available');
    assert.equal(await body.locator('tr').count(),4);
    await page.locator('#sm-stock-search').fill('000002-b');
    assert.equal(await body.locator('tr').count(),1);
    assert.equal((await body.locator('td').allTextContents())[8],'150');
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
    assert.equal((await bagRow.locator('td').allTextContents())[8],'850');
    assert.equal(await bagRow.getByRole('button',{name:'실사삭제'}).count(),1);
    await page.locator('#sm-stock-search').fill('진공');
    assert.equal(await page.locator('#sm-stock-body tr').count(),1);
    await page.locator('#sm-stock-search').fill('');
    await page.locator('#sm-stock-view').selectOption('lot');
    await page.evaluate(()=>{subMaterialUsages.find(u=>u.id==='u2').qty=60;renderSubMaterials();});
    const updated=body.locator('tr').filter({hasText:'000002-B'});
    assert.equal((await updated.locator('td').allTextContents())[8],'140');
    await page.locator('#sm-in-trader').fill('입력 중 거래처 보존');
    await page.locator('#sm-stock-search').fill('not found');
    assert.match(await body.innerText(),/조건에 맞는.*없습니다/);
    assert.equal(await page.locator('#sm-in-trader').inputValue(),'입력 중 거래처 보존');
    await page.locator('#sm-stock-search').fill('');
    await page.setViewportSize({width:1024,height:768});
    await card.screenshot({path:path.join(artifacts,'lot-stock-1024.png')});
    assert.deepEqual(errors,[]);
    console.log(`PASS: browser view switch, real input/change events, item count management retained, refresh and draft preservation. Artifacts: ${artifacts}`);
  }finally{await browser.close();}
}

(async()=>{testLogic(); if(!process.argv.includes('--unit-only')) await testBrowser();})()
  .catch(error=>{console.error(error);process.exitCode=1;});
