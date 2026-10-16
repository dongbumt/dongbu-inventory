/* Actual usage dialog and save handler, fictional production/stock, mocked saves. */
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const source=name=>{const match=html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));assert(match,name);return match[0]};
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
const names=['parseAppNumber','parseOptionalBoxCount','boxCountDisplay','totalRecordedBoxes','htmlEscape','jsArg',
  'asArray','getProdEntryNote','getProdJobType','subMaterialUsageProductionEntry','subMaterialProductionSummary','subMaterialUsageWorkDate',
  'getProductionSubMaterialUsages','subMaterialUsageDraftId','createSubMaterialUsageDraft','subMaterialUsagePersonalCan',
  'updateSubMaterialUsageDraft','addSubMaterialUsageDraftRow','removeSubMaterialUsageDraftRow','onSubMaterialUsageItemChange',
  'onSubMaterialUsageLotChange','subMaterialUsageDraftAvailable','renderSubMaterialUsageDraftRows','buildSubMaterialProductionReference',
  'openSubMaterialUsageModal','closeSubMaterialUsageModal','saveSubMaterialUsageModal'];
const entry={id:'saved',date:'2026/10/16',job_no:'1',job_type:'생산',note:'연장 작업 · 거래처 포장 확인',
  inputs:[{product:'가상 이겹살',origin:'스페인',lot:'917024600073',packunit:'벌크',qty:326.31,price:4911},
    {product:'가상 삼겹살(작업)',origin:'스페인',lot:'917024600073',qty:3.54,price:4911,boxCount:1,note:'연장 재작업'}],
  outputs:[{product:'가상 삼겹살(작업)',origin:'스페인',lot:'917024600073',packunit:'5KG',qty:326.46,boxCount:16,price:4952,note:'연장 포장 · 거래처 A'}]};
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-production-usage-reference-'));
  try{
    const page=await browser.newPage({viewport:{width:1453,height:981}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort());
    await page.setContent('<!doctype html><html lang="ko"><meta charset="utf-8"><body><main><input id="cleared-production-input" value=""><p>생산일보 입력폼은 저장 후 초기화된 상태입니다.</p></main></body></html>');
    await page.evaluate(markup=>{const t=document.createElement('template');t.innerHTML=markup;document.body.append(t.content.querySelector('#sm-usage-modal'));},html);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'styles/main.css'),'utf8')});
    await page.addScriptTag({content:`
      var userProdEntries=[${JSON.stringify(entry)}],EXCEL_PROD=[],activeSubMaterialUsageProductionId='',subMaterialUsageDraftSeq=0;
      var subMaterialUsageDraftRows=[],subMaterialUsageSaving=false,subMaterialUsages=[],messages=[],saved=[],failSave=false;
      var subMaterialItems=[{id:'item',code:'B001',name:'가상 진공포장지',spec:'250×350',unit:'장'}];
      var subMaterialLots=[{id:'lot',itemId:'item',lot:'PACK-20261016',date:'2026-10-16',qty:10000,unit:'장'}];
      var DBMTAuth={isPersonal:()=>true,can:()=>true};
      function toast(message){messages.push(message)}
      function makeAppId(){return 'fixture-usage'}
      function getSubMaterialLotAvailable(id,exclude){return 10000-subMaterialUsages.filter(r=>r.lotId===id&&r.productionId!==exclude).reduce((sum,r)=>sum+Number(r.qty),0)}
      async function refreshSubMaterialStockSnapshot(){return {}}
      function applySubMaterialStockResponse(){}
      function renderAll(){}
      async function saveSubMaterialUsageRows(rows,deletedIds){if(failSave)throw Error('QA save failure');saved.push(structuredClone({rows,deletedIds}))}
      ${names.map(source).join('\n')}
    `});
    await page.evaluate(()=>openSubMaterialUsageModal('saved'));
    const reference=page.locator('#sm-usage-production-details');
    assert.match(await reference.innerText(),/연장 작업 · 거래처 포장 확인/);
    assert.match(await reference.innerText(),/329.85 KG/);assert.match(await reference.innerText(),/326.46 KG/);
    assert.match(await reference.innerText(),/16 박스/);assert.match(await reference.innerText(),/박스 미기록/);
    assert.match(await reference.innerText(),/포장 5KG/);assert.match(await reference.innerText(),/917024600073/);
    assert.match(await reference.innerText(),/연장 포장 · 거래처 A/);
    assert.equal(await reference.locator('input,select,textarea,button').count(),0,'Production reference is read-only');
    const original=await page.evaluate(()=>JSON.stringify(userProdEntries)),originalReference=await reference.innerHTML();
    const row=page.locator('#sm-usage-edit-body tr').first();
    await row.locator('select').nth(0).selectOption('item');await row.locator('select').nth(1).selectOption('lot');
    await row.locator('input[type="number"]').fill('16');await row.locator('input:not([type="number"])').fill('16박스 포장');
    assert.equal(await reference.innerHTML(),originalReference,'Changing material fields keeps production visible');
    assert.equal(await page.evaluate(()=>JSON.stringify(userProdEntries)),original);
    const positions=await page.locator('.sm-usage-pane').evaluateAll(nodes=>nodes.map(n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y})));
    assert.ok(positions[1].x>positions[0].x&&positions[1].y===positions[0].y,'Wide screens show production and usage side by side');
    await page.screenshot({path:path.join(artifacts,'side-by-side.png'),fullPage:true});
    await page.evaluate(()=>failSave=true);await page.locator('button[onclick="saveSubMaterialUsageModal()"]').click();
    assert.match(await page.locator('#sm-usage-editor-status').innerText(),/QA save failure/);
    assert.equal(await reference.innerHTML(),originalReference,'Save failure preserves the reference');assert.equal(await row.locator('input[type="number"]').inputValue(),'16');
    await page.evaluate(()=>failSave=false);await page.locator('button[onclick="saveSubMaterialUsageModal()"]').click();
    assert.equal(await page.locator('#sm-usage-modal').isVisible(),false);
    assert.equal(await page.evaluate(()=>saved[0].rows[0].productionId),'saved');assert.equal(await page.evaluate(()=>saved[0].rows[0].qty),16);
    assert.equal(await page.evaluate(()=>JSON.stringify(userProdEntries)),original,'Saving materials cannot change production');
    // A different job must not retain the previously displayed production details.
    await page.evaluate(()=>{userProdEntries.push({id:'empty',date:'2026/10/16',job_no:'2',inputs:[],outputs:[],note:''});return openSubMaterialUsageModal('empty')});
    assert.doesNotMatch(await reference.innerText(),/가상 삼겹살/);assert.equal(await reference.locator('.sm-usage-production-empty').count(),2);
    // Escape all saved values, even in old imported production records.
    await page.evaluate(()=>{const item={product:'<img src=x onerror=alert(1)>',qty:1,note:'<script>bad</script>',lot:'<&>',origin:'<&>'};document.getElementById('sm-usage-production-details').innerHTML=buildSubMaterialProductionReference({inputs:[item],outputs:[],note:'<img src=x>'})});
    assert.equal(await reference.locator('img,script').count(),0);
    // Large jobs and many usage rows scroll within their own panes; actions stay visible.
    await page.evaluate(()=>{userProdEntries[0].inputs=Array.from({length:18},()=>({...userProdEntries[0].inputs[0]}));userProdEntries[0].outputs=Array.from({length:18},()=>({...userProdEntries[0].outputs[0]}));return openSubMaterialUsageModal('saved')});
    for(let i=0;i<16;i++)await page.evaluate(()=>addSubMaterialUsageDraftRow());
    for(const [width,height] of [[1453,981],[1280,720],[1024,768],[768,600],[390,844]]){
      await page.setViewportSize({width,height});
      const layout=await page.locator('.sm-usage-dialog').evaluate(n=>({top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom,ref:document.getElementById('sm-usage-production-details').clientHeight,editor:document.querySelector('.sm-usage-table-wrap').clientHeight,overflow:document.documentElement.scrollWidth>innerWidth}));
      assert.ok(layout.top>=8&&layout.bottom<=height-8,JSON.stringify({width,height,layout}));assert.ok(layout.ref>50&&layout.editor>50);assert.equal(layout.overflow,false);
      const button=await page.locator('button[onclick="saveSubMaterialUsageModal()"]').boundingBox();assert.ok(button.y>=0&&button.y+button.height<=height);
    }
    await page.setViewportSize({width:1453,height:981});
    assert.equal(await reference.evaluate(n=>n.scrollHeight>n.clientHeight),true);
    assert.equal(await page.locator('.sm-usage-table-wrap').evaluate(n=>n.scrollHeight>n.clientHeight),true);
    await page.screenshot({path:path.join(artifacts,'long-production.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('PASS: saved production reference after cleared form, products/LOTs/weight/boxes/notes/totals, read-only data, material input and save/failure retention, reopen/empty jobs, escaping, side-by-side layout and independent responsive scrolling');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
