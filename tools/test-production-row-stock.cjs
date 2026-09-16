/* Fictional in-memory data only. Browser checks use an isolated DOM and mock saves. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const repo = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');

function source(name) {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, `Missing function ${name}`);
  return match[0];
}
function section(start, end) {
  const at = html.indexOf(start), stop = html.indexOf(end, at);
  assert.ok(at >= 0 && stop > at, `Missing section ${start} / ${end}`);
  return html.slice(at, stop);
}
const stockFunctions = [
  'localDateString', 'normProdDate', 'priceKey', 'priceProductKey', 'samePriceText', 'samePriceProductText',
  'normalizeOriginName', 'originKey', 'sameOriginText', 'normalizeStockLocation', 'stockLocationKey', 'getTxnStockLocation',
  'parseAppNumber', 'stockPriceKey', 'stockDateKey', 'stockMapKey', 'sameStockIdentity', 'getTxnUnitPrice',
  'getStockTxnProddate', 'stockLedgerDateKey', 'getStockMap', 'invalidateStockMap', 'htmlEscape', 'jsArg'
];
const stockSource = stockFunctions.map(source).join('\n');
const common = {
  product: '가상 돈등심 생산품', productId: 'qa-product', labelProductId: 'qa-product',
  origin: '국내산', lot: 'QA-LOT-0001', packunit: '5 KG', price: 6000,
  stockLocation: '가공장', proddate: '2026-09-13', stockProddate: '2026-09-13'
};
const incoming = (id, weight, note) => ({...common, date: '2026-09-13', type: '생산입고',
  _isProdOut: true, _prodId: 'qa-production', weight, stockRowId: id, stockNote: note});
const consume = (id, weight, type = '출고', extra = {}) => ({...common, date: '2026-09-14', type,
  weight, price: type === '출고' ? 9000 : common.price, stockUnitPrice: common.price, stockRowId: id, ...extra});

function harness(rows = []) {
  const context = {console, performance, setTimeout, clearTimeout};
  vm.createContext(context);
  vm.runInContext(`
    var STOCK_LOCATION_DEFAULT='가공장', EXCEL_STOCK=[], labelProducts=[], userProdEntries=[];
    var _stockMapCache=null, userTransactions=${JSON.stringify(rows)};
    var DBMT_PERF={record:()=>{}};
    function normalizeLabelProductTaxType(value){return value;}
    function setStockExportEnabled(){}
    ${stockSource}
  `, context);
  return context;
}
function buckets(ctx, asOf = '') { return Object.values(ctx.getStockMap(asOf)); }
function row(ctx, id, location = '가공장', asOf = '') {
  const found = buckets(ctx, asOf).filter(item => (item.stockRowId || '') === id && item.stockLocation === location);
  assert.equal(found.length, 1, `Expected one bucket for row ${id || '(legacy)'} at ${location}`);
  return found[0];
}
function testLogic() {
  for (const notes of [['삼성웰스토리 / 3mm', '일반 / 5mm'], ['같은 비고', '같은 비고'], ['', '']]) {
    const ctx = harness([incoming('row-A', 30, notes[0]), incoming('row-B', 70, notes[1])]);
    assert.equal(buckets(ctx).length, 2, 'Each production line remains independent regardless of note');
    assert.equal(row(ctx, 'row-A').stock, 30);
    assert.equal(row(ctx, 'row-B').stock, 70);
    ctx.userTransactions.push(consume('row-A', 20)); ctx.invalidateStockMap();
    assert.equal(row(ctx, 'row-A').stock, 10);
    assert.equal(row(ctx, 'row-A').total_out, 20);
    assert.equal(row(ctx, 'row-B').stock, 70);
    assert.equal(row(ctx, 'row-A').stockNote, notes[0]);
    assert.equal(row(ctx, 'row-B').stockNote, notes[1]);
    assert.equal(row(ctx, 'row-A', '가공장', '2026-09-13').stock, 30, 'Historical cutoffs retain row identity');
  }

  const operations = harness([incoming('row-A', 30, '3mm'), incoming('row-B', 70, '5mm'),
    consume('row-A', 20), consume('row-B', 7, '사용'),
    consume('row-B', 13, '재고이동', {fromLocation: '가공장', toLocation: '물류창고', stockNote: '5mm'}),
    consume('row-A', -2, '재고조정', {stockNote: '3mm'})]);
  assert.equal(row(operations, 'row-A').stock, 8);
  assert.equal(row(operations, 'row-B').stock, 50);
  assert.equal(row(operations, 'row-B').total_use, 7);
  assert.equal(row(operations, 'row-B', '물류창고').stock, 13);
  assert.equal(row(operations, 'row-B', '물류창고').stockNote, '5mm');
  operations.userTransactions.push(consume('row-B', 3, '출고', {stockLocation: '물류창고'}));
  operations.invalidateStockMap();
  assert.equal(row(operations, 'row-B', '물류창고').stock, 10);
  assert.equal(row(operations, 'row-B').stock, 50, 'Destination sales must not consume the source branch');

  const deficit = harness([incoming('row-A', 30, ''), incoming('row-B', 70, ''), consume('row-A', 35)]);
  assert.equal(row(deficit, 'row-A').stock, -5, 'An overdraw remains attached to the selected production line');
  assert.equal(row(deficit, 'row-B').stock, 70, 'An overdraw never falls through to another line');

  const legacy = harness([incoming('', 40, ''), incoming('row-A', 30, '신규'), incoming('row-B', 70, '신규'), consume('', 15)]);
  assert.equal(row(legacy, '').stock, 25);
  assert.equal(row(legacy, 'row-A').stock, 30);
  assert.equal(row(legacy, 'row-B').stock, 70);
  legacy.userTransactions.push(consume('', 50)); legacy.invalidateStockMap();
  assert.equal(row(legacy, '').stock, -25, 'Historical untagged consumption stays in the legacy bucket');
  assert.equal(row(legacy, 'row-A').stock, 30);
  assert.equal(row(legacy, 'row-B').stock, 70);

  const edit = harness([incoming('row-A', 30, '옛 비고'), incoming('row-B', 70, '유지'), consume('row-A', 20, '출고', {stockNote: '옛 비고'})]);
  const beforeKeys = Object.keys(edit.getStockMap()).sort();
  edit.userTransactions[0].stockNote = '삼성웰스토리 / 거래처 수정 / 3mm';
  edit.userTransactions = [edit.userTransactions[1], edit.userTransactions[0], edit.userTransactions[2]];
  edit.invalidateStockMap();
  assert.deepEqual(Object.keys(edit.getStockMap()).sort(), beforeKeys, 'Changing notes and row order must preserve stock keys');
  assert.equal(row(edit, 'row-A').stock, 10);
  assert.equal(row(edit, 'row-A').stockNote, '삼성웰스토리 / 거래처 수정 / 3mm', 'The production note is authoritative over stale outbound snapshots');
  console.log('PASS: independent production rows, blank/duplicate notes, exact outbound/use/transfer/adjustment allocation, overdraw isolation, legacy isolation, date cutoffs and note edits');
}

async function testTransactionFlows(page, artifacts) {
  await page.evaluate(markup => {
    const template = document.createElement('template'); template.innerHTML = markup;
    for (const id of ['p-transactions', 'stock-adjust-modal']) document.querySelector('main').append(template.content.querySelector('#' + id));
    document.getElementById('p-production').classList.remove('active');
    document.getElementById('p-transactions').classList.add('active');
    for (const id of ['t-stock-location', 't-move-from', 't-move-to']) {
      document.getElementById(id).innerHTML = '<option>가공장</option><option>물류창고</option>';
    }
    document.getElementById('t-origin-managed').style.display = 'none';
    document.getElementById('t-origin-display').style.display = '';
  }, html);
  const names = [
    'getTProduct', 'getTOrigin', 'getTStorage', 'getTPackunit', 'getTLabelProductId', 'getTStockLocation',
    'getTMoveFromLocation', 'getTMoveToLocation', 'getEditingTransaction', 'stockOptionFromTransaction',
    'bulkOutboundIdentityKey', 'bulkOutboundKeyFromValues', 'bulkOutboundStockOptions', 'sameBulkOutboundStockOption',
    'outboundStockOptionsForEdit', 'availableStockForEdit', 'ensureOutProductOption', 'bulkOutboundStockLabel',
    'selectTxnStock', 'addTransaction', 'addBulkOutboundRow', 'addBulkOutboundRows', 'clearBulkOutbound',
    'selectBulkOutboundStock', 'refreshBulkOutboundPrice', 'updateBulkOutboundAmount', 'saveBulkOutbound',
    'openStockAdjust', 'closeStockAdjust', 'calcStockAdjustDiff', 'saveStockAdjust'
  ];
  await page.addScriptTag({content: `
    var _editTxnId=null, bulkOutboundStockOptionsCacheMap=null, bulkOutboundStockOptionsCacheRows=null;
    var savedTransactionCalls=[], adjustCalls=[], DBMTAuth={getSessionToken:()=> 'isolated-token'};
    function getTxnStockSearchOptions(){return outboundStockOptionsForEdit(getEditingTransaction());}
    function autoFillTxnPrice(){}
    function clearTransactionForm(){_editTxnId=null;}
    function renderTransactions(){}
    function updateProductList(){}
    function updateOutProductList(){}
    function showTransactionSaveStatus(){}
    function stockPersonalCan(){return true;}
    function stockCanAdjustCurrent(){return true;}
    function safeLocalStorageSet(){}
    function markLocalCoreChanged(){invalidateStockMap();}
    function renderStock(){}
    async function saveTransactionRows(rows){savedTransactionCalls.push(JSON.parse(JSON.stringify(rows)));invalidateStockMap();}
    async function sbRpc(name, body){adjustCalls.push({name,body});return {ok:true,transaction:body.p_record};}
    ${names.map(source).join('\n')}
  `});
  await page.evaluate(rows => {userTransactions = rows; userProdEntries = []; invalidateStockMap();}, [incoming('action-A', 30, '삼성 / 3mm'), incoming('action-B', 70, '일반 / 5mm')]);
  await page.evaluate(() => {
    document.getElementById('t-date').value = '2026-09-14';
    document.getElementById('t-type').value = '출고';
    selectTxnStock(bulkOutboundStockOptions().find(item => item.stockRowId === 'action-A').key);
    document.getElementById('t-trader').value = '가상 납품처';
    document.getElementById('t-weight').value = '20';
    document.getElementById('t-price').value = '9000';
  });
  await page.evaluate(() => addTransaction());
  let saved = await page.evaluate(() => savedTransactionCalls);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].type, '출고');
  assert.equal(saved[0].stockRowId, 'action-A');
  assert.equal(saved[0].stockNote, '삼성 / 3mm');
  assert.equal(await page.evaluate(() => Object.values(getStockMap()).find(item => item.stockRowId === 'action-A').stock), 10);
  await page.evaluate(() => {
    document.getElementById('t-type').value = '재고이동';
    selectTxnStock(bulkOutboundStockOptions().find(item => item.stockRowId === 'action-B').key);
    document.getElementById('t-move-to').value = '물류창고';
    document.getElementById('t-weight').value = '13';
  });
  await page.evaluate(() => addTransaction());
  saved = await page.evaluate(() => savedTransactionCalls);
  assert.equal(saved.length, 2);
  assert.equal(saved[1].type, '재고이동');
  assert.equal(saved[1].stockRowId, 'action-B');
  assert.equal(saved[1].stockNote, '일반 / 5mm');
  assert.equal(saved[1].fromLocation, '가공장'); assert.equal(saved[1].toLocation, '물류창고');
  assert.equal(await page.evaluate(() => Object.values(getStockMap()).find(item => item.stockRowId === 'action-B' && item.stockLocation === '물류창고').stock), 13);
  await page.evaluate(() => {
    document.getElementById('bulk-out-date').value = '2026-09-14';
    document.getElementById('bulk-outbound-tbody').innerHTML = ''; addBulkOutboundRow();
    const row = document.querySelector('#bulk-outbound-tbody tr');
    const stock = bulkOutboundStockOptions().find(item => item.stockRowId === 'action-B' && item.stockLocation === '가공장');
    selectBulkOutboundStock(row.querySelector('.bulk-out-stock-input'), stock.key);
    row.querySelector('.bulk-out-trader').value = '가상 일괄 납품처';
    row.querySelector('.bulk-out-weight').value = '5';
    row.querySelector('.bulk-out-price-input').value = '9000';
  });
  await page.evaluate(() => saveBulkOutbound());
  saved = await page.evaluate(() => savedTransactionCalls);
  assert.equal(saved.length, 3);
  assert.equal(saved[2][0].stockRowId, 'action-B');
  assert.equal(saved[2][0].stockNote, '일반 / 5mm');
  assert.equal(saved[2][0].weight, 5);
  await page.evaluate(() => {
    document.getElementById('t-type').value = '사용';
    selectTxnStock(bulkOutboundStockOptions().find(item => item.stockRowId === 'action-B' && item.stockLocation === '가공장').key);
    document.getElementById('t-weight').value = '2';
  });
  await page.evaluate(() => addTransaction());
  saved = await page.evaluate(() => savedTransactionCalls);
  assert.equal(saved.length, 4);
  assert.equal(saved[3].type, '사용');
  assert.equal(saved[3].stockRowId, 'action-B');
  assert.equal(saved[3].stockNote, '일반 / 5mm');
  assert.equal(saved[3].price, 6000, 'General consumption keeps the selected stock cost');
  await page.evaluate(() => {
    const stock = Object.values(getStockMap()).find(item => item.stockRowId === 'action-A');
    openStockAdjust(stock.product, stock.lot, stock.origin, stock.price, stock.stock, stock.proddate,
      stock.packunit, stock.stockLocation, stock.stockRowId, stock.stockNote);
    document.getElementById('stock-adj-date').value = '2026-09-14';
    document.getElementById('stock-adj-actual').value = '8';
    document.getElementById('stock-adj-note').value = '가상 실사';
  });
  assert.equal(await page.locator('#stock-adj-row-id').inputValue(), 'action-A');
  assert.equal(await page.locator('#stock-adj-stock-note').inputValue(), '삼성 / 3mm');
  await page.evaluate(() => saveStockAdjust());
  const adjusted = await page.evaluate(() => ({calls: adjustCalls, rows: Object.values(getStockMap())}));
  assert.equal(adjusted.calls.length, 1); assert.equal(adjusted.calls[0].name, 'dbmt_erp_save_stock_adjust');
  assert.equal(adjusted.calls[0].body.p_record.stockRowId, 'action-A');
  assert.equal(adjusted.calls[0].body.p_record.stockNote, '삼성 / 3mm');
  assert.equal(adjusted.calls[0].body.p_record.weight, -2);
  assert.equal(adjusted.rows.find(item => item.stockRowId === 'action-A').stock, 8);
  assert.equal(adjusted.rows.find(item => item.stockRowId === 'action-B' && item.stockLocation === '가공장').stock, 50);
  await page.screenshot({path: path.join(artifacts, 'transaction-stock-rows.png'), fullPage: true});
  console.log('PASS: actual single outbound, general use, branch transfer, bulk outbound and adjustment DOM save paths preserve row IDs and stock notes');
}

async function testProductionGuards(page) {
  const results = await page.evaluate(({stock, issued, common}) => {
    const before = userTransactions;
    userTransactions = [stock, issued]; invalidateStockMap();
    const previous = {id: 'qa-guard-production', date: '2026/09/13', outputs: [{...common, qty: 100, stockRowId: 'guard-row', note: '3mm'}]};
    const next = (changes = {}) => ({...previous, outputs: [{...previous.outputs[0], ...changes}]});
    const result = {
      safeReduction: validateProductionStockRowChanges(previous, next({qty: 90})),
      unsafeReduction: validateProductionStockRowChanges(previous, next({qty: 5})),
      noteEdit: validateProductionStockRowChanges(previous, next({note: '거래처 수정'})),
      identityEdit: validateProductionStockRowChanges(previous, next({lot: 'CHANGED-LOT'})),
      deleteRow: validateProductionStockRowChanges(previous, {...previous, outputs: []}),
      duplicateId: validateProductionStockRowChanges(null, {...previous, outputs: [previous.outputs[0], previous.outputs[0]]})
    };
    userTransactions = before; invalidateStockMap();
    return result;
  }, {stock: incoming('guard-row', 100, '3mm'), issued: consume('guard-row', 10), common});
  assert.equal(results.safeReduction, '', '100 produced / 10 issued may be corrected to 90 produced');
  assert.match(results.unsafeReduction, /줄일 수 없습니다/);
  assert.equal(results.noteEdit, '');
  assert.match(results.identityEdit, /변경할 수 없습니다/);
  assert.match(results.deleteRow, /삭제할 수 없습니다/);
  assert.match(results.duplicateId, /두 행/);
  console.log('PASS: production edits allow safe quantity corrections and note changes while guarding consumed stock, identity changes, row deletion and duplicate IDs');
}

async function testBrowser() {
  const {chromium} = require('playwright');
  const executablePath = process.env.CHROME_PATH || [chromium.executablePath(), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(candidate => fs.existsSync(candidate));
  const browser = await chromium.launch({headless: true, executablePath});
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmt-production-rows-'));
  try {
    const page = await browser.newPage({viewport: {width: 1520, height: 1100}});
    await page.route('**/*', route => route.abort());
    await page.setContent('<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body><main></main></body></html>');
    await page.evaluate(markup => {
      const template = document.createElement('template'); template.innerHTML = markup;
      window.assertNoSamsung = !template.content.querySelector('#p-samsung,#nav-samsung');
      window.missingCoreControls = ['p-transactions', 't-add-btn', 'bulk-inbound-tbody', 'bulk-outbound-tbody',
        't-count', 'p-production', 'stock-body'].filter(id => !template.content.querySelector('#' + id));
      document.querySelector('main').append(template.content.querySelector('#p-production'));
      document.getElementById('p-production').classList.add('active');
    }, html);
    await page.addStyleTag({content: fs.readFileSync(path.join(repo, 'styles/main.css'), 'utf8')});
    const extraFunctions = ['autoSetJobNo', 'getProdEntryNote', 'getProdJobType', 'makeProductionTxnId', 'getWeightedTxnPrice', 'getPriceFromLot'];
    if (html.includes('function normalizeSamsungMeta(')) extraFunctions.push('normalizeSamsungMeta');
    await page.addScriptTag({content: `
      var STOCK_LOCATION_DEFAULT='가공장', EXCEL_STOCK=[], EXCEL_PROD=[], EXCEL_TRANSACTIONS=[], today='2026-09-13';
      var userProdEntries=[], userTransactions=[], transactions=[], _stockMapCache=null, stockSearchDirty=true, stockQuerySnapshot=null;
      var labelProducts=[{id:'qa-product',name:${JSON.stringify(common.product)},packunit:'5 KG',origin:'국내산'}];
      var DBMT_PERF={record:()=>{}}, testSequence=0, saveCalls=[], notices=[], modalIds=[];
      var SUPABASE_ENABLED_KEY='qa-enabled', localCoreRevision=0;
      window.confirm=()=>true; window.alert=message=>notices.push(message);
      function makeAppId(prefix){return prefix+'-qa-'+(++testSequence);}
      function toast(message){notices.push(message);}
      function setStockExportEnabled(){}
      function normalizeLabelProductTaxType(value){return value || '면세';}
      function nationalPartNameForCode(){return '';}
      function getPrice(){return 0;}
      function getSamsungProductMeta(){return null;}
      function showPage(){initProdForm();}
      function renderProduction(){}
      function syncSubMaterialUsageProductionMetadata(){}
      function openSubMaterialUsageModal(id){modalIds.push(id);}
      async function saveProductionRows(entry, rows, deletedId, previous){
        saveCalls.push(JSON.parse(JSON.stringify({entry,rows,deletedId,previous})));
        invalidateStockMap();
      }
      ${stockSource}
      ${extraFunctions.map(source).join('\n')}
      ${section('let prodInputRowCount = 0;', '// ─── 생산일보 ─')}
      initProdForm();
    `});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    assert.deepEqual(await page.evaluate(() => missingCoreControls), [], 'Core transaction, stock and production controls survive menu removal');
    assert.equal(await page.evaluate(() => assertNoSamsung), true, 'Dedicated Samsung menu is removed');
    assert.equal(await page.locator('[id^="prod-out-sw-"],[id^="prod-in-sw-"]').count(), 0, 'Production form has no Samsung-specific inputs');
    await page.evaluate(() => {selectProdOutProduct(1, 0); addProdOutputRow(); selectProdOutProduct(2, 0);});
    for (const [index, weight, note] of [[1, '30', '삼성웰스토리 / 3mm'], [2, '70', '일반 / 5mm']]) {
      await page.locator(`#prod-out-lot-${index}`).fill(common.lot);
      await page.locator(`#prod-out-qty-${index}`).fill(weight);
      await page.locator(`#prod-out-price-${index}`).fill('6000');
      await page.locator(`#prod-out-origin-${index}`).fill(common.origin);
      await page.locator(`#prod-out-note-${index}`).fill(note);
    }
    const originalIds = await page.locator('[id^="prod-out-stock-row-id-"]').evaluateAll(elements => elements.map(element => element.value));
    assert.equal(new Set(originalIds).size, 2); assert.ok(originalIds.every(Boolean), 'New lines receive fixed identities');
    await page.screenshot({path: path.join(artifacts, 'production-two-rows.png'), fullPage: true});
    await page.evaluate(() => saveProdEntry());
    assert.equal(await page.evaluate(() => saveCalls.length), 1);
    const saved = await page.evaluate(() => ({entry: userProdEntries[0], rows: userTransactions}));
    assert.deepEqual(saved.entry.outputs.map(output => output.stockRowId), originalIds);
    assert.deepEqual(saved.entry.outputs.map(output => output.note), ['삼성웰스토리 / 3mm', '일반 / 5mm']);
    assert.deepEqual(saved.rows.filter(item => item._isProdOut).map(item => item.stockRowId), originalIds);
    assert.deepEqual(saved.rows.filter(item => item._isProdOut).map(item => item.stockNote), ['삼성웰스토리 / 3mm', '일반 / 5mm']);
    assert.equal(await page.evaluate(() => Object.keys(getStockMap()).length), 2);

    await page.evaluate(({entryId, transaction}) => {
      userTransactions.push(transaction); invalidateStockMap(); openEditProdEntry(entryId);
    }, {entryId: saved.entry.id, transaction: consume(originalIds[0], 20, '출고', {id: 'qa-outbound', stockNote: '삼성웰스토리 / 3mm'})});
    await page.locator('#prod-out-note-1').fill('삼성웰스토리 / 거래처 수정 / 3mm');
    await page.evaluate(() => document.getElementById('prod-output-rows').prepend(document.getElementById('prod-out-2')));
    await page.evaluate(() => saveProdEntry());
    const edited = await page.evaluate(() => ({entry: userProdEntries[0], rows: Object.values(getStockMap()), txns: userTransactions, calls: saveCalls.length, notices}));
    assert.equal(edited.calls, 2, 'Journal edit must save: ' + edited.notices.join(' | '));
    assert.deepEqual(edited.entry.outputs.map(output => output.stockRowId), originalIds.slice().reverse(), 'Reordering retains hidden row identities');
    assert.equal(edited.rows.find(item => item.stockRowId === originalIds[0]).stock, 10);
    assert.equal(edited.rows.find(item => item.stockRowId === originalIds[1]).stock, 70);
    assert.equal(edited.rows.find(item => item.stockRowId === originalIds[0]).stockNote, '삼성웰스토리 / 거래처 수정 / 3mm');
    assert.equal(edited.txns.filter(item => item.id === 'qa-outbound').length, 1, 'Editing the journal preserves external outbound history');

    await page.evaluate(rowId => {
      initProdForm();
      const stock = Object.entries(getStockMap()).map(([key, item]) => ({key, ...item})).find(item => item.stockRowId === rowId);
      selectProdInputStock(1, stock.product, stock.lot, stock.origin, stock.packunit, stock.stock, '생산입고', stock.price,
        stock.proddate, stock.price, stock.stockLocation, stock.key, stock.stockRowId, stock.stockNote);
    }, originalIds[1]);
    assert.equal(await page.locator('#prod-in-stock-row-id-1').inputValue(), originalIds[1]);
    assert.equal(await page.locator('#prod-in-stock-note-1').inputValue(), '일반 / 5mm');
    await page.locator('#prod-in-qty-1').fill('7');
    await page.evaluate(() => saveProdEntry());
    const reused = await page.evaluate(() => ({entry: userProdEntries[userProdEntries.length - 1], rows: userTransactions, stock: Object.values(getStockMap())}));
    assert.equal(reused.entry.inputs[0].stockRowId, originalIds[1]);
    assert.equal(reused.entry.inputs[0].stockNote, '일반 / 5mm');
    assert.equal(reused.rows.find(item => item._isProdUse).stockRowId, originalIds[1]);
    assert.equal(reused.stock.find(item => item.stockRowId === originalIds[1]).stock, 63);

    const legacyMeta = {vendorId: 'legacy-vendor', vendorName: '과거 삼성 거래처', productRowId: 'legacy-product', spec: '과거 8mm', customArchive: '원본 보존'};
    const legacyEntry = {id: 'qa-legacy', date: '2026/09/12', job_no: '1', job_type: '생산', note: '', inputs: [], outputs: [
      {...common, qty: 40, note: '과거 비고', samsung: legacyMeta}
    ]};
    await page.evaluate(entry => {userProdEntries.push(entry); openEditProdEntry(entry.id);}, legacyEntry);
    assert.equal(await page.locator('#prod-out-stock-row-id-1').inputValue(), '', 'Historical merged stock remains untagged');
    assert.match(await page.locator('#prod-out-note-1').inputValue(), /과거 삼성 거래처/);
    assert.match(await page.locator('#prod-out-note-1').inputValue(), /과거 8mm/);
    await page.evaluate(() => saveProdEntry());
    const legacySaved = await page.evaluate(() => userProdEntries.find(entry => entry.id === 'qa-legacy'));
    assert.equal(legacySaved.outputs[0].stockRowId || '', '');
    assert.deepEqual(legacySaved.outputs[0].samsung, legacyMeta, 'Removing Samsung controls must preserve historical metadata');
    await testProductionGuards(page);
    await testTransactionFlows(page, artifacts);
    assert.deepEqual(errors, []);
    console.log('PASS: real production DOM, automatic IDs, row notes, save/reopen/reorder, outbound history retention, reuse linkage, legacy metadata preservation and Samsung controls removal');
    console.log('Artifacts: ' + artifacts);
  } finally { await browser.close(); }
}

async function main() {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
  testLogic();
  if (process.argv.includes('--browser')) await testBrowser();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
