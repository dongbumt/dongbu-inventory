// Actual transaction form and handlers with fictional traders/prices; no server writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
const source = name => {
  const match = html.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert(match, `Missing ${name}`);
  return match[0];
};
const section = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const traders = {
  '가상 삼성(용인센터)': {tradeType:'매출', fullname:'가상 삼성웰스토리 용인', category:'급식', manager:'가상 김담당', phone:'031-123-4567'},
  '가상 삼성(서울센터)': {tradeType:'매출', category:'급식'},
  '가상 겸용거래처': {tradeType:'매입/매출', fullname:'Fictional BOTH Company', managerPhone:'010-9876-5432'},
  '가상 매입거래처': {tradeType:'매입', category:'원료'},
  '가상 비활성 삼성': {tradeType:'매출', active:false},
  '가상 별칭 삼성': {tradeType:'매출', alias:true},
  '가상 <특수&기호> "거래처"': {tradeType:'매출', manager:'<가상담당>'}
};
const prices = [
  {product:'가상 제품', origin:'국내산', trader:'가상 삼성(용인센터)', price:7000},
  {product:'가상 제품', origin:'국내산', trader:'가상 삼성(서울센터)', price:8000},
  {product:'가상 제품', origin:'국내산', trader:'가상 겸용거래처', price:9000}
];
const setup = `
var traderInfoMap=${JSON.stringify(traders)}, prices=${JSON.stringify(prices)}, notices=[];
function autoFillTxnPrice(){} function toast(message){notices.push(message)}
${['htmlEscape','priceKey','priceProductKey','samePriceText','normalizeOriginName','originKey','sameOriginText','findPriceRow','getPrice','parseAppNumber',
  'addBulkInboundRow','addBulkInboundRows','addBulkOutboundRow','addBulkOutboundRows','removeBulkOutboundRow','clearBulkOutbound',
  'refreshBulkOutboundPrice','updateBulkOutboundAmount','applyBulkInboundTrader','applyBulkOutboundTrader'].map(source).join('\n')}
${section('let txnTraderSearchRows =', 'async function updateTxnPrice(')}
${section('let bulkTraderSearchRows =', 'function addBulkInboundRow(')}
document.getElementById('t-type').value='출고';
document.getElementById('bulk-outbound-body').style.display='block';
document.getElementById('bulk-inbound-body').style.display='block';
addBulkOutboundRows(5);addBulkInboundRows(2);
document.querySelectorAll('#bulk-outbound-tbody tr').forEach(tr=>{
  tr.querySelector('.bulk-out-product').value='가상 제품';
  tr.querySelector('.bulk-out-origin').value='국내산';
  tr.querySelector('.bulk-out-weight').value='2';
  tr.querySelector('.bulk-out-stock').value='10';
});
`;

(async()=>{
  const browser = await chromium.launch({headless:true, executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const page = await browser.newPage({viewport:{width:1390,height:900}}), errors=[];
    page.on('pageerror', error=>errors.push(error.message));
    await page.route('**/*', route=>route.abort());
    await page.setContent('<!doctype html><html lang="ko"><meta charset="utf-8"><body></body></html>');
    const panel = await page.evaluate(markup=>{
      const template=document.createElement('template');template.innerHTML=markup;
      const panel=template.content.querySelector('#p-transactions');panel.classList.add('active');return panel.outerHTML;
    }, html);
    const fixture = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>거래처 검색 확인 (가상 자료)</title><style>${fs.readFileSync(path.join(root,'styles/main.css'),'utf8')}body{padding:16px;}</style><body>${panel}<script>${setup}</script></body></html>`;
    await page.setContent(fixture);
    const artifactDir=path.join(root,'output','playwright','trader-search');fs.mkdirSync(artifactDir,{recursive:true});
    fs.writeFileSync(path.join(artifactDir,'fixture.html'),fixture);
    const txn=page.locator('#t-trader'), common=page.locator('#bulk-out-trader-common');
    const rowInputs=page.locator('#bulk-outbound-tbody .bulk-out-trader');
    const popup=input=>input.locator('..').locator('.txn-trader-results');
    const candidates=input=>popup(input).locator('.txn-trader-option strong').allTextContents();
    for(const input of [common,rowInputs.first()]){
      assert.equal(await input.getAttribute('list'),null,'Native browser datalist is removed');
      assert.equal(await input.getAttribute('autocomplete'),'off');
      for(const query of ['','용인','삼성','김담당','급식','031-123','9876','fictional','없는검색어']){
        await txn.fill(query);const expected=await candidates(txn);
        await input.fill(query);assert.deepEqual(await candidates(input),expected,`Same search results for ${query}`);
        assert.deepEqual(await popup(input).locator('.txn-trader-option span').allTextContents(), await popup(txn).locator('.txn-trader-option span').allTextContents());
      }
    }
    await rowInputs.first().fill('용인');
    await popup(rowInputs.first()).getByRole('option').click();
    assert.equal(await rowInputs.first().inputValue(),'가상 삼성(용인센터)');
    assert.equal(await page.locator('#bulk-outbound-tbody .bulk-out-price-input').first().inputValue(),'7000');
    assert.equal(await page.locator('.bulk-out-amount-cell').first().innerText(),'14,000');
    assert.equal(await popup(rowInputs.first()).isVisible(),false);
    await rowInputs.first().fill('없는 거래처');
    assert.equal(await page.locator('#bulk-outbound-tbody .bulk-out-price-input').first().inputValue(),'','Typing refreshes/clears the automatic price');
    await rowInputs.first().fill('삼성');await rowInputs.first().press('ArrowDown');
    const highlighted=await popup(rowInputs.first()).locator('.active strong').innerText();
    await rowInputs.first().press('Enter');assert.equal(await rowInputs.first().inputValue(),highlighted);
    assert.equal(await popup(rowInputs.first()).isVisible(),false);
    await rowInputs.first().click();await rowInputs.first().press('Escape');assert.equal(await popup(rowInputs.first()).isVisible(),false);
    await rowInputs.first().press('ArrowDown');assert.equal(await popup(rowInputs.first()).isVisible(),true);
    await rowInputs.nth(1).focus();
    assert.equal(await rowInputs.first().getAttribute('aria-expanded'),'false');
    assert.equal(await popup(rowInputs.first()).isVisible(),false,'Changing rows closes the previous list');
    await rowInputs.nth(1).press('Tab');await page.waitForFunction(()=>document.querySelectorAll('.bulk-trader-results[style*="display: block"]').length===0);
    await page.evaluate(()=>document.getElementById('t-type').value='입고');
    await common.fill('用');assert.equal(await candidates(common).then(rows=>rows.length),0);
    await common.fill('용인');await popup(common).getByRole('option').click();
    assert.equal(await common.inputValue(),'가상 삼성(용인센터)','Bulk outbound scope is independent of single-entry type');
    await page.locator('#bulk-outbound-body button[onclick="applyBulkOutboundTrader()"] ').click();
    assert.equal(await rowInputs.nth(1).inputValue(),'가상 삼성(용인센터)');
    assert.equal(await rowInputs.first().inputValue(),highlighted,'Common fill keeps existing row traders');
    assert.equal(await page.locator('.bulk-out-price-input').nth(1).inputValue(),'7000');
    const manualPrice=page.locator('.bulk-out-price-input').nth(1);await manualPrice.fill('12345');
    await rowInputs.nth(1).fill('서울');await popup(rowInputs.nth(1)).getByRole('option').click();
    assert.equal(await manualPrice.inputValue(),'12345','Selecting a trader preserves manually entered prices');
    assert.equal(await page.locator('.bulk-out-amount-cell').nth(1).innerText(),'24,690');
    const inbound=page.locator('#bulk-inbound-tbody .bulk-in-trader').first();
    await inbound.fill('');assert.deepEqual(await candidates(inbound),['가상 겸용거래처','가상 매입거래처']);
    await inbound.fill('매입');await popup(inbound).getByRole('option',{name:/가상 매입거래처/}).click();
    assert.equal(await inbound.inputValue(),'가상 매입거래처');
    const inboundCommon=page.locator('#bulk-in-trader-common');await inboundCommon.fill('fictional');await inboundCommon.press('Enter');
    assert.equal(await inboundCommon.inputValue(),'가상 겸용거래처');
    await page.locator('#bulk-inbound-body button[onclick="applyBulkInboundTrader()"] ').click();
    assert.equal(await page.locator('#bulk-inbound-tbody .bulk-in-trader').nth(1).inputValue(),'가상 겸용거래처');
    await page.evaluate(()=>addBulkOutboundRow());const added=rowInputs.last();
    await added.fill('특수');assert.deepEqual(await candidates(added),['가상 <특수&기호> "거래처"']);
    assert.equal(await popup(added).locator('script,img,기호').count(),0,'Trader text cannot create HTML');
    await popup(added).getByRole('option').click();assert.equal(await added.inputValue(),'가상 <특수&기호> "거래처"');
    await rowInputs.first().fill('용인');await page.locator('#bulk-outbound-body').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(artifactDir,'outbound-search.png')});
    const option=popup(rowInputs.first()).getByRole('option');
    assert.equal(await option.evaluate(node=>{const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));}),true,'Table dropdown is visible and clickable above following rows');
    await rowInputs.first().press('Escape');await page.evaluate(()=>clearBulkOutbound());
    assert.equal(await rowInputs.count(),5);await rowInputs.last().fill('용인');await rowInputs.last().press('Enter');
    assert.equal(await rowInputs.last().inputValue(),'가상 삼성(용인센터)','Recreated rows keep working');
    assert.deepEqual(errors,[]);
    console.log('PASS: consistent trader search/detail/scope, mouse and keyboard, row focus/blur, dynamic rows, common fill, automatic/manual prices, inbound compatibility and escaped text');
    console.log('Artifacts: '+artifactDir);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
