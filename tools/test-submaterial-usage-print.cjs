/* Run with Node.js. Browser checks additionally need playwright, pdf-lib and Chrome.
   NODE_PATH can point to the desktop's bundled node_modules. Artifacts go to TEMP. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');

const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'submaterial-usage-print.js'), 'utf8');
const index = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
const auth = fs.readFileSync(path.join(repo, 'm02-auth.js'), 'utf8');
const moduleContext = {window:{}};
vm.runInNewContext(source, moduleContext);
const printer = moduleContext.window.DBMTSubMaterialUsagePrint;

const production = {
  id:'test-production', date:'2026-09-07', job_no:'TEST-007', jobNo:'TEST-007', jobType:'생산',
  note:'테스트 자료 · 오전 생산 / 실사용 데이터 아님',
  outputs:[
    {product:'냉장돈등심(치즈용)', packunit:'5 KG / 봉', lot:'00120008906379', qty:250},
    {product:'냉장돈등심(돈까스용)', packunit:'10 KG / 박스', lot:'00120008906380', qty:'1,000.5'}
  ]
};
const usages = [
  {id:'u1', itemId:'i1', lotId:'l1', itemName:'진공 포장지', itemCode:'B001', itemSpec:'300 × 400 mm', lot:'000001-260901', qty:50, unit:'장', note:'치즈용 포장'},
  {id:'u2', itemId:'i1', lotId:'l2', itemName:'진공 포장지', itemCode:'B001', itemSpec:'300 × 400 mm', lot:'000002-260902', qty:100, unit:'장', note:'돈까스용 포장'},
  {id:'u3', itemId:'i2', lotId:'l3', itemName:'제품 표시 라벨', itemCode:'B002', itemSpec:'80 × 100 mm', lot:'LABEL-260903', qty:0.125, unit:'롤', note:'라벨 교체\n잔량 확인'}
];
const drafts = usages.map(({id,itemId,lotId,qty,note}) => ({id,itemId,lotId,qty,note}));
const model = {companyName:'주식회사 동부엠티', production, usages};

// Parse all inline app scripts without running authentication or touching live data.
for(const [i, match] of [...index.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries()){
  new vm.Script(match[1], {filename:`index-inline-${i}.js`});
}
new vm.Script(auth);
assert.match(index, /id="sm-usage-print-btn"[^>]*onclick="printSubMaterialUsage\(\)"/);
assert.match(auth, /printSubMaterialUsage:\['production','view'\]/);
assert.equal(printer.hasUnsavedChanges(drafts, usages), false);
assert.equal(printer.hasUnsavedChanges([...drafts].reverse().concat({qty:''}), usages), false);
assert.equal(printer.hasUnsavedChanges(drafts.map(row => ({...row, qty:String(row.qty), note:` ${row.note} `})), usages), false);
for(const field of ['qty', 'itemId', 'lotId', 'note']){
  assert.equal(printer.hasUnsavedChanges(drafts.map((row, i) => i ? row : {...row, [field]:'changed'}), usages), true, field);
}
assert.equal(printer.hasUnsavedChanges(drafts.slice(1), usages), true);
assert.equal(printer.hasUnsavedChanges([...drafts, {itemId:'new'}], usages), true);
const documentHtml = printer.buildDocument(model);
assert.ok(documentHtml.includes('150 장 / 0.125 롤'));
assert.ok(documentHtml.includes('1,250.5 KG'));
assert.ok(documentHtml.includes('000001-260901'));
const malicious = '<script>window.INJECTED = true</script><img src=x onerror=alert(1)>';
const escapedHtml = printer.buildDocument({companyName:malicious, production:{...production, note:malicious}, usages:[{...usages[0], lot:malicious, itemName:malicious, note:malicious}]});
assert.equal((escapedHtml.match(/<script>/g) || []).length, 1);
assert.ok(escapedHtml.includes('&lt;img'));
moduleContext.window.open = () => null;
assert.equal(printer.open(model), false);

const integrationSource = index.slice(index.indexOf('function printSubMaterialUsage(){'), index.indexOf('function syncSubMaterialUsageProductionMetadata('));
function harness(){
  const elements = {'sm-usage-editor-status':{style:{}}, 'sm-usage-print-btn':{disabled:false}};
  const state = {
    window:{DBMTSubMaterialUsagePrint:{...printer, open:data => {state.printed = data; return true;}}},
    document:{getElementById:id => elements[id]},
    subMaterialUsageSaving:false, activeSubMaterialUsageProductionId:production.id,
    subMaterialUsageDraftRows:structuredClone(drafts), subMaterialUsages:structuredClone(usages),
    subMaterialItems:usages.map(row => ({id:row.itemId, name:row.itemName, spec:row.itemSpec, code:row.itemCode})),
    subMaterialLots:usages.map(row => ({id:row.lotId, itemId:row.itemId, lot:row.lot, unit:row.unit})),
    subMaterialUsagePersonalCan:() => true,
    subMaterialUsageProductionEntry:() => production,
    getProductionSubMaterialUsages:() => state.subMaterialUsages,
    subMaterialUsageWorkDate:entry => entry.date,
    subMaterialProductionSummary:() => '생산품 요약',
    getProdJobType:entry => entry.jobType,
    getProdEntryNote:entry => entry.note,
    getSubMaterialLotAvailable:() => 100000,
    parseAppNumber:value => Number(String(value).replace(/,/g, '')) || 0,
    asArray:value => value, toast:message => {state.message = message;},
    closeSubMaterialUsageModal:() => {state.closed = true;}, renderAll:() => {},
    console:{error:() => {}}, elements
  };
  vm.createContext(state);
  vm.runInContext(integrationSource, state);
  return state;
}

async function testIntegration(){
  let state = harness();
  state.printSubMaterialUsage();
  assert.equal(state.printed.production.jobNo, production.job_no);
  assert.equal(state.printed.usages[0].lot, usages[0].lot);
  state = harness(); state.subMaterialUsageDraftRows[0].qty = 51;
  state.printSubMaterialUsage();
  assert.equal(state.printed, undefined);
  assert.match(state.message, /먼저 저장/);
  state = harness(); state.subMaterialUsagePersonalCan = () => false;
  state.printSubMaterialUsage(); assert.equal(state.printed, undefined);
  state = harness(); state.subMaterialUsageDraftRows = []; state.subMaterialUsages = [];
  state.printSubMaterialUsage(); assert.match(state.message, /저장된.*없습니다/);
  state = harness(); state.window.DBMTSubMaterialUsagePrint.open = () => false;
  state.printSubMaterialUsage(); assert.match(state.message, /팝업 차단/);
  for(const fail of [false, true]){
    state = harness();
    let finish;
    state.saveSubMaterialUsageRows = () => new Promise((resolve,reject) => {finish = () => fail ? reject(new Error('test failure')) : resolve();});
    const previous = state.subMaterialUsages;
    const saving = state.saveSubMaterialUsageModal();
    assert.equal(state.subMaterialUsageSaving, true);
    assert.equal(state.elements['sm-usage-print-btn'].disabled, true);
    state.printSubMaterialUsage(); assert.equal(state.printed, undefined);
    assert.match(state.message, /저장이 완료된 후/);
    finish(); await saving;
    assert.equal(state.subMaterialUsageSaving, false);
    assert.equal(state.elements['sm-usage-print-btn'].disabled, false);
    if(fail) assert.equal(state.subMaterialUsages, previous);
    else assert.equal(state.closed, true);
  }
}

async function testBrowser(){
  const {chromium} = require('playwright');
  const {PDFDocument} = require('pdf-lib');
  const {getDocument} = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  const executablePath = process.env.CHROME_PATH || [
    chromium.executablePath(),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].find(candidate => fs.existsSync(candidate));
  const browser = await chromium.launch({headless:true, executablePath});
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmt-submaterial-print-'));
  try{
    const page = await browser.newPage({viewport:{width:1000,height:1200}});
    // Keep browser-native print dialogs closed; PDF generation still exercises print CSS.
    await page.addInitScript(() => {window.print = () => {window.printCalls = (window.printCalls || 0) + 1;};});
    await page.goto('about:blank');
    const cases = [
      ['normal', model],
      ['medium', {...model, usages:Array.from({length:15}, (_,i) => ({...usages[i % 3], lot:`TEST-LOT-${String(i + 1).padStart(4,'0')}`}))}],
      ['long', {...model, production:{...production, note:'긴 생산 비고 확인 '.repeat(30)}, usages:Array.from({length:60}, (_,i) => ({...usages[i % 3], lot:`TEST-LOT-${String(i + 1).padStart(4,'0')}`, note:`${i + 1}번째 사용내역 · 상세 비고 확인\n다음 줄 메모`}))}],
      ['escaped', {companyName:malicious, production:{...production, note:malicious}, usages:[{...usages[0], itemName:malicious, note:malicious}]}]
    ];
    for(const [name, data] of cases){
      await page.setContent(printer.buildDocument(data), {waitUntil:'load'});
      await page.waitForFunction(() => document.documentElement.dataset.printReady === 'true');
      const geometry = await page.evaluate(() => {
        const sheet = document.querySelector('.sheet').getBoundingClientRect();
        const report = document.querySelector('.report').getBoundingClientRect();
        return {height:report.height, limit:sheet.height, width:report.width, widthLimit:sheet.width, scale:document.querySelector('.report').style.zoom};
      });
      assert.ok(geometry.height <= geometry.limit, `${name}: height ${JSON.stringify(geometry)}`);
      assert.ok(geometry.width <= geometry.widthLimit + 1, `${name}: width overflow ${JSON.stringify(geometry)}`);
      assert.equal(await page.locator('table[aria-label="부자재 LOT별 사용 내역"] tbody tr').count(), data.usages.length);
      assert.equal(await page.evaluate(() => window.INJECTED), undefined);
      for(const usage of data.usages) assert.ok((await page.locator('article').innerText()).includes(usage.lot));
      await page.screenshot({path:path.join(artifactDir, `${name}.png`), fullPage:true});
      const pdf = await page.pdf({path:path.join(artifactDir, `${name}.pdf`), preferCSSPageSize:true, printBackground:true, displayHeaderFooter:false});
      const parsed = await PDFDocument.load(pdf);
      assert.equal(parsed.getPageCount(), 1, `${name}: must fit on one A4 page`);
      const size = parsed.getPage(0).getSize();
      assert.ok(Math.abs(size.width - 595.28) < 2 && Math.abs(size.height - 841.89) < 2, `${name}: A4 portrait`);
      const pdfTextDocument = await getDocument({data:new Uint8Array(pdf), useSystemFonts:true}).promise;
      const pdfPage = await pdfTextDocument.getPage(1);
      const text = (await pdfPage.getTextContent()).items.map(item => item.str).join(' ').replace(/\s/g, '');
      assert.ok(text.includes('생산부자재사용내역서'), `${name}: PDF title`);
      assert.ok(text.includes('부자재별입고LOT와사용수량을확인해주세요.'), `${name}: PDF footer`);
      for(const usage of data.usages) assert.ok(text.includes(usage.lot.replace(/\s/g, '')), `${name}: PDF missing ${usage.lot}`);
      await pdfTextDocument.destroy();
      console.log(`${name}: 1 A4 page, ${data.usages.length} usage rows, scale ${geometry.scale}`);
    }
    // Exercise the actual module's popup opening, rendering and auto-print lifecycle.
    await page.setContent('<button id="print">출력 (A4)</button>');
    await page.addScriptTag({content:source});
    await page.evaluate(data => {document.querySelector('#print').onclick = () => window.DBMTSubMaterialUsagePrint.open(data);}, model);
    const popupReady = page.waitForEvent('popup');
    await page.locator('#print').click();
    const popup = await popupReady;
    await popup.waitForFunction(() => document.documentElement.dataset.printReady === 'true');
    assert.equal(await popup.locator('h1').innerText(), '생산 부자재 사용내역서');
    assert.equal(await popup.evaluate(() => window.opener), null);
    await popup.close();
    console.log(`Artifacts: ${artifactDir}`);
  }finally{
    await browser.close();
  }
}

(async () => {
  await testIntegration();
  console.log('PASS: syntax, saved-data guards, permissions, escaping, LOTs, unit totals, save success/failure');
  if(!process.argv.includes('--unit-only')) await testBrowser();
})().catch(error => {console.error(error); process.exitCode = 1;});
