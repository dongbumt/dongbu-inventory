/* Node.js regression checks. Browser checks require playwright, pdf-lib, pdfjs-dist
   (NODE_PATH may point to bundled dependencies). Only fictional in-memory data is used. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const repo = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
const printSource = fs.readFileSync(path.join(repo, 'stock-report.js'), 'utf8');
const auth = fs.readFileSync(path.join(repo, 'm02-auth.js'), 'utf8');
const functions = [
  'localDateString','normProdDate','priceKey','priceProductKey','samePriceText','samePriceProductText',
  'normalizeOriginName','originKey','sameOriginText','normalizeStockLocation','stockLocationKey','getTxnStockLocation',
  'parseAppNumber','stockPriceKey','stockDateKey','stockMapKey','sameStockIdentity','getTxnUnitPrice','getStockTxnProddate',
  'stockLedgerDateKey','getStockMap','invalidateStockMap','htmlEscape','jsArg',
  'stockCanAdjustCurrent','stockTableColspan','setStockExportEnabled','getStockQueryFilters','stockQueryDescription',
  'showStockQueryState','markStockSearchPending','runStockSearch','resetStockAsOfDate','renderStock',
  'stockPersonalCan','applyStockPermissionState','closeStockAdjust','openStockAdjust','saveStockAdjust',
  'getStockExportSnapshot','printStockReport','exportStockCSV','stockSort'
].map(name => {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, `Missing ${name}`);
  new vm.Script(match[0]);
  return match[0];
}).join('\n');
for(const [i, match] of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries()) new vm.Script(match[1], {filename:`inline-${i}`});
new vm.Script(auth);
assert.match(auth, /printStockReport:\['stock','view'\]/);
assert.match(auth, /exportStockCSV:\['stock','view'\]/);

const base = {product:'테스트 원료육', origin:'국내산', lot:'000123', packunit:'10 KG', price:5000, stockLocation:'가공장', proddate:'2026-08-31', brand:'테스트 브랜드', grade:'1등급'};
const made = {product:'테스트 생산품', origin:'국내산', lot:'000987', packunit:'5 KG', price:6000, stockLocation:'가공장'};
const fixture = [
  {...base, date:'2026-09-10', type:'입고', weight:100}, // deliberately stored out of order
  {...base, date:'2026/9/1', type:'입고', weight:100},
  {...base, date:'2026-09-02', type:'사용', weight:30, _isProdUse:true},
  {...made, date:'2026-09-02', type:'생산입고', weight:25, _isProdOut:true},
  {...made, date:'2026-09-03', type:'출고', weight:5, stockUnitPrice:6000},
  {...base, date:'2026-09-04', type:'재고이동', weight:20, fromLocation:'가공장', toLocation:'물류창고', stockUnitPrice:5000},
  {...base, date:'2026-09-05', type:'재고조정', weight:-5},
  {...base, date:'2026-09-05T23:59:59+09:00', type:'재고조정', weight:2},
  {...base, date:'2026-09-06', type:'출고', weight:5, stockLocation:'물류창고', stockUnitPrice:5000},
  {...base, date:'2026-09-07', type:'입고', weight:40, product:'나중 입고', lot:'FUTURE', proddate:'2026-08-01'},
  {...base, date:'', type:'입고', weight:9, product:'날짜 누락'},
  {...base, date:'2026-02-30', type:'입고', weight:9, product:'잘못된 날짜'}
];
const setup = `
  var STOCK_LOCATION_DEFAULT='가공장', EXCEL_STOCK=[], labelProducts=[];
  var _stockMapCache=null, stockQuerySnapshot=null, stockSearchActivated=false, stockSearchDirty=true;
  var stockRenderTimer=null, stockSortKey='product', stockSortDir='asc';
  var userTransactions=${JSON.stringify(fixture)};
  var DBMTAuth={isPersonal:()=>true, can:()=>true};
  var DBMT_PERF={record:()=>{}};
  function normalizeLabelProductTaxType(v){return v;}
  function refreshStockLocationFilter(){}
  function activePageId(){return 'p-stock';}
  function toast(message){globalThis.lastMessage=message;}
  function downloadCSV(rows,name){globalThis.csvResult={rows,name};}
`;

function harness(){
  const elements = {};
  for(const id of ['stock-as-of-date','stock-search','stock-location-filter','stock-filter-status','stock-search-btn',
    'stock-print-btn','stock-csv-btn','stock-query-note','stock-stats','stock-body','stock-manage-head','stock-adjust-modal']){
    elements[id] = {value:'', innerHTML:'', textContent:'', disabled:false, style:{}, classList:{add(){},remove(){}}};
  }
  elements['stock-filter-status'].value = '재고';
  const context = {document:{getElementById:id=>elements[id]}, window:{}, elements, setTimeout, clearTimeout, performance, console};
  vm.createContext(context);
  vm.runInContext(setup + functions + printSource, context);
  return context;
}
function sum(map){return Object.values(map).reduce((total, row)=>total + row.stock, 0);}
function bucket(map, product, location='가공장'){
  return Object.values(map).find(row=>row.product === product && row.stockLocation === location);
}

async function testLogic(){
  const ctx = harness();
  for(const date of ['2026/9/5','2026-09-05','2026-09-05T23:59:59+09:00']) assert.equal(ctx.stockLedgerDateKey(date), '2026-09-05');
  for(const date of ['', 'abc', '2026-02-30', '2026-13-01']) assert.equal(ctx.stockLedgerDateKey(date), '');
  assert.throws(()=>ctx.getStockMap('2026-02-30'), /기준일/);
  assert.equal(Object.keys(ctx.getStockMap('2026-08-31')).length, 0);
  assert.equal(sum(ctx.getStockMap('2026-09-01')), 100);
  assert.equal(sum(ctx.getStockMap('2026-09-02')), 95);
  assert.equal(sum(ctx.getStockMap('2026-09-03')), 90);
  assert.equal(sum(ctx.getStockMap('2026-09-04')), 90, 'transfer conserves stock');
  const atDate = ctx.getStockMap('2026-09-05');
  assert.equal(sum(atDate), 87, 'inclusive through end of chosen day');
  assert.equal(bucket(atDate, base.product).stock, 47);
  assert.equal(bucket(atDate, base.product).total_in, 100);
  assert.equal(bucket(atDate, base.product).total_use, 30);
  assert.equal(bucket(atDate, base.product).total_adjust, -23);
  assert.equal(bucket(atDate, base.product, '물류창고').stock, 20);
  assert.equal(bucket(atDate, made.product).stock, 20);
  assert.equal(bucket(atDate, '나중 입고'), undefined, 'must use transaction date, not production date');
  assert.equal(sum(ctx.getStockMap('2026-09-06')), 82);
  assert.equal(sum(ctx.getStockMap('2026-09-07')), 122);
  assert.equal(bucket(ctx.getStockMap('2026-09-07'), '나중 입고').stock, 40);
  const current = ctx.getStockMap();
  const currentJson = JSON.stringify(current);
  ctx.getStockMap('2026-09-01');
  assert.equal(ctx.getStockMap(), current, 'historical query must not replace current cache');
  assert.equal(JSON.stringify(current), currentJson);
  ctx.userTransactions.push({...base, date:'2026-09-05', type:'재고조정', weight:1});
  ctx.invalidateStockMap();
  assert.equal(sum(ctx.getStockMap('2026-09-05')), 88, 'backdated saved changes are recalculated');
  ctx.userTransactions.pop(); ctx.invalidateStockMap();
  ctx.EXCEL_STOCK.push({...base, stock:100});
  assert.throws(()=>ctx.getStockMap('2026-09-01'), /기초재고/);
  ctx.EXCEL_STOCK.pop();

  const el = ctx.elements;
  assert.equal(ctx.getStockExportSnapshot(), null, 'cannot print before query');
  el['stock-as-of-date'].value = '2026-09-05'; ctx.renderStock();
  assert.equal(ctx.stockQuerySnapshot.rows.length, 3);
  assert.match(ctx.stockQuerySnapshot.warning, /2건/);
  assert.match(el['stock-query-note'].textContent, /2026-09-05 마감/);
  assert.equal(el['stock-print-btn'].disabled, false);
  assert.equal(ctx.stockCanAdjustCurrent(), false);
  ctx.openStockAdjust('x'); assert.match(ctx.lastMessage, /조회 전용/);
  await ctx.saveStockAdjust(); assert.match(ctx.lastMessage, /조회 전용/);
  el['stock-location-filter'].value = '물류창고'; ctx.markStockSearchPending();
  assert.equal(el['stock-print-btn'].disabled, true);
  assert.equal(ctx.getStockExportSnapshot(), null, 'stale results blocked');
  ctx.renderStock();
  assert.equal(ctx.stockQuerySnapshot.rows.length, 1);
  assert.equal(ctx.stockQuerySnapshot.rows[0].stock, 20);
  ctx.exportStockCSV();
  assert.equal(ctx.csvResult.name, '재고현황_2026-09-05.csv');
  assert.equal(ctx.csvResult.rows.length, 2);
  assert.equal(ctx.csvResult.rows[1][0], '2026-09-05');
  assert.equal(ctx.csvResult.rows[1][13], '20.00');
  ctx.window.DBMTStockReport.open = data=>{ctx.printed=data; return true;};
  ctx.printStockReport(); assert.equal(ctx.printed.rows[0].stock, 20);
  assert.equal(ctx.printed.filters.location, '물류창고');
  el['stock-search'].value = '검색결과 없음'; ctx.renderStock();
  assert.equal(ctx.stockQuerySnapshot.rows.length, 0);
  assert.match(el['stock-body'].innerHTML, /항목 없음/);
  el['stock-search'].value = ''; el['stock-location-filter'].value = '';
  ctx.stockSort('stock');
  const sorted = ctx.stockQuerySnapshot.rows.map(row=>row.stock);
  assert.deepEqual([...sorted], [...sorted].sort((a,b)=>a-b));
  el['stock-as-of-date'].value = ''; ctx.markStockSearchPending(); ctx.renderStock();
  assert.equal(ctx.stockCanAdjustCurrent(), true);
  assert.equal(ctx.stockQuerySnapshot.warning, '');
  ctx.DBMTAuth.can=()=>false;
  assert.equal(ctx.getStockExportSnapshot(), null);
  assert.match(ctx.lastMessage, /권한/);

  const split = harness();
  split.userTransactions = [
    {...base, date:'2026-09-01', type:'입고', price:10, weight:100},
    {...base, date:'2026-09-01', type:'입고', price:20, weight:200},
    {...base, date:'2026-09-02', type:'사용', price:20, stockUnitPrice:20, weight:80},
    {...base, date:'2026-09-02', type:'출고', price:999, stockUnitPrice:10, weight:30},
    {...base, date:'2026-09-03', type:'입고', price:30, weight:1000}
  ];
  const splitRows = Object.values(split.getStockMap('2026-09-02'));
  assert.equal(splitRows.length, 2);
  assert.equal(splitRows.find(row=>row.price===10).stock, 70);
  assert.equal(splitRows.find(row=>row.price===20).stock, 120);
  const deficit = harness();
  deficit.userTransactions=[{...base,date:'2026-09-01',type:'출고',weight:5,stockUnitPrice:5000}];
  assert.equal(sum(deficit.getStockMap('2026-09-01')), -5, 'negative stock is retained');
  console.log('PASS: cutoff, inclusive dates, production, transfers, adjustments, cost/LOT buckets, cache isolation, filters, permissions, CSV, stale guards');
}

async function testBrowser(){
  const {chromium} = require('playwright');
  const {PDFDocument} = require('pdf-lib');
  const {getDocument} = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  const executablePath = process.env.CHROME_PATH || [chromium.executablePath(), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(candidate=>fs.existsSync(candidate));
  const browser = await chromium.launch({headless:true, executablePath});
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmt-stock-report-'));
  try{
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    await page.addInitScript(()=>{window.print=()=>{window.printCalled=true;};});
    await page.goto('about:blank');
    const pageHtml = html.slice(html.indexOf('<div class="tab-panel" id="p-stock">'), html.indexOf('<!-- ═', html.indexOf('id="stock-adjust-modal"')));
    const css = fs.readFileSync(path.join(repo, 'styles/main.css'), 'utf8');
    await page.setContent(`<html lang="ko"><head><meta charset="utf-8"><style>${css}</style></head><body><main>${pageHtml}</main></body></html>`);
    await page.evaluate(()=>document.getElementById('p-stock').classList.add('active'));
    await page.addScriptTag({content:setup + functions + printSource});
    assert.equal(await page.locator('#stock-print-btn').isDisabled(), true);
    await page.locator('#stock-as-of-date').fill('2026-09-05');
    await page.locator('#stock-search-btn').click();
    await page.waitForFunction(()=>!stockSearchDirty && !!stockQuerySnapshot);
    assert.equal(await page.locator('#stock-body tr').count(), 3);
    assert.equal(await page.locator('.stock-adjust-btn').count(), 0);
    await page.screenshot({path:path.join(artifacts,'stock-page.png'),fullPage:true});
    const popupEvent = page.waitForEvent('popup');
    await page.locator('#stock-print-btn').click();
    const popup = await popupEvent;
    await popup.waitForFunction(()=>document.documentElement.dataset.printReady === 'true');
    assert.equal(await popup.locator('h1').innerText(), '재고현황');
    assert.equal(await popup.locator('tbody tr').count(), 3);
    assert.ok((await popup.locator('article').innerText()).includes('455,000원'));
    await popup.close();
    await page.locator('#stock-search').fill('생산품');
    assert.equal(await page.locator('#stock-print-btn').isDisabled(), true);
    await page.locator('#stock-search-btn').click();
    await page.waitForFunction(()=>!stockSearchDirty);
    assert.equal(await page.locator('#stock-body tr').count(), 1);
    await page.locator('button', {hasText:'현재'}).click();
    await page.waitForFunction(()=>!stockSearchDirty);
    assert.equal(await page.locator('#stock-as-of-date').inputValue(), '');
    assert.equal(await page.locator('.stock-adjust-btn').count(), 1);

    const ctx = harness();
    const report = ctx.window.DBMTStockReport;
    const rows = Object.values(ctx.getStockMap('2026-09-05'));
    const model = {filters:{asOfDate:'2026-09-05',status:'재고'},rows,queriedAt:'2026. 9. 7. 오전 10:00:00'};
    const attack = '<script>window.INJECTED=true</script><img src=x onerror=alert(1)>';
    const cases = [
      ['normal', model],
      ['medium', {...model,rows:Array.from({length:15},(_,i)=>({...rows[i%rows.length],lot:`0000000000${i}`}))}],
      ['long', {...model,rows:Array.from({length:60},(_,i)=>({...rows[i%rows.length],lot:`TEST-LOT-${String(i).padStart(4,'0')}`,product:'긴 품목명과 포장규격 줄바꿈 확인용 테스트 원료육'}))}],
      ['empty', {...model,rows:[]}],
      ['escaped', {...model,companyName:attack,filters:{...model.filters,query:attack},rows:[{...rows[0],product:attack,lot:attack}],warning:attack}]
    ];
    for(const [name, data] of cases){
      await page.setContent(report.buildDocument(data));
      await page.waitForFunction(()=>document.documentElement.dataset.printReady==='true');
      const geometry=await page.evaluate(()=>{
        const sheet=document.querySelector('.sheet').getBoundingClientRect(), report=document.querySelector('.report').getBoundingClientRect();
        return {height:report.height,maxHeight:sheet.height,width:report.width,maxWidth:sheet.width,scale:document.querySelector('.report').style.zoom};
      });
      assert.ok(geometry.height<=geometry.maxHeight && geometry.width<=geometry.maxWidth+1, `${name}: overflow ${JSON.stringify(geometry)}`);
      assert.equal(await page.evaluate(()=>window.INJECTED),undefined);
      await page.screenshot({path:path.join(artifacts,`${name}.png`),fullPage:true});
      const pdf = await page.pdf({path:path.join(artifacts,`${name}.pdf`),preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false});
      const parsed = await PDFDocument.load(pdf);
      assert.equal(parsed.getPageCount(),1,`${name}: one page`);
      const size = parsed.getPage(0).getSize();
      assert.ok(Math.abs(size.width-841.89)<2 && Math.abs(size.height-595.28)<2,`${name}: A4 landscape`);
      const doc = await getDocument({data:new Uint8Array(pdf),useSystemFonts:true}).promise;
      const pdfPage=await doc.getPage(1);
      const text=(await pdfPage.getTextContent()).items.map(item=>item.str).join('').replace(/\s/g,'');
      assert.ok(text.includes('2026-09-05마감'),`${name}: cutoff missing`);
      assert.ok(text.includes('기준일이후거래는날짜별조회에서제외됩니다.'),`${name}: footer missing`);
      for(const row of data.rows) assert.ok(text.includes(row.lot.replace(/\s/g,'')),`${name}: missing LOT ${row.lot}`);
      await doc.destroy();
      console.log(`${name}: 1 A4 landscape page, ${data.rows.length} rows, scale ${geometry.scale}`);
    }
    console.log(`Artifacts: ${artifacts}`);
  }finally{await browser.close();}
}
(async()=>{await testLogic(); if(!process.argv.includes('--unit-only')) await testBrowser();})().catch(error=>{console.error(error);process.exitCode=1;});
