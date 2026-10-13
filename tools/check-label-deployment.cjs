// Read-only release check. Backend writes and physical printing are intercepted.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const {setOuter}=require('./label-touch-test-helpers.cjs');
const repo=path.resolve(__dirname,'..');
const base=new URL(process.env.DBMT_LABEL_RELEASE_URL||'https://dongbumt.github.io/dongbu-inventory/');
const ref=process.env.DBMT_LABEL_RELEASE_REF||'HEAD';
const normalize=text=>text.replace(/\r\n/g,'\n');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-label-release-'));
async function read(file){
  const url=new URL(file,base);url.searchParams.set('release-check',Date.now());
  const response=await fetch(url,{headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(20000)});
  assert.equal(response.status,200,`${file}: release asset unavailable`);
  return response.text();
}
(async()=>{
  for(const file of ['label-print.html','label-layout.js','label-print-document.js','vendor/jsbarcode/JsBarcode.code128.min.js']){
    const expected=execFileSync('git',['show',`${ref}:${file}`],{cwd:repo,encoding:'utf8'});
    assert(normalize(await read(file))===normalize(expected),`${file}: deployed content differs from ${ref}`);
    console.log(`PASS: deployed ${file} matches ${ref}`);
  }
  const main=await read('index.html');
  assert.match(main,/<script src="label-layout\.js\?v=20261013inset1"><\/script>/);
  assert.match(main,/return DBMTLabelLayout\.buildBody\(/);
  assert.match(main,/label-print\.html\?v=20261013inset1/);
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:1024}});
    const saves=[],errors=[];
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(request.method()==='POST'&&url.pathname==='/rest/v1/rpc/dbmt_label_print_save_logs'){
        saves.push(request.postDataJSON());
        return route.fulfill({contentType:'application/json',body:'{"ok":true}'});
      }
      if(request.method()==='GET'&&url.origin===base.origin&&url.pathname.startsWith(base.pathname))return route.continue();
      return route.abort();
    });
    await context.addInitScript(()=>{
      window.__releasePrints=[];
      window.print=()=>{
        if(window.parent===window)throw Error('Physical printing is forbidden');
        window.parent.__releasePrints.push(document.documentElement.outerHTML);
        setTimeout(()=>window.dispatchEvent(new Event('afterprint')),10);
      };
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(new URL('label-print.html?v=20261013inset1',base).href);
    await page.evaluate(()=>{
      state.pin='qa-no-real-login';
      state.workOrders=[{id:'qa-release-order',date:'2026-10-13',product:'돈사태(작업)',inputWeight:100,weight:12,origin:'국내산',lot:'L12608194894027',mfgdate:'2026-08-21',expdate:'2027-08-20',temptype:'냉동',itemno:'2025029309311'}];
      state.selectedId='qa-release-order';state.allDates=true;renderAll();
    });
    await setOuter(page,12,1);
    await page.locator('#outer-actions #print-btn').click();
    await page.waitForFunction(()=>!state.loading&&__releasePrints.length===1);
    assert.equal(saves.length,1,'Save must be intercepted, not sent to the backend');
    const id=await page.evaluate(()=>state.logs[0].id);
    await page.evaluate(id=>reprintLog(id),id);
    const documents=await page.evaluate(()=>__releasePrints);
    assert.equal(documents.length,2);assert.equal(saves.length,2);
    let firstCode;
    for(let i=0;i<documents.length;i++){
      const print=await context.newPage();await print.setContent(documents[i]);
      await print.waitForFunction(()=>[...document.images].every(img=>img.complete&&img.naturalWidth>0));
      await print.emulateMedia({media:'print'});
      assert.equal(await print.locator('.dbmt-label-body').count(),1);
      const bounds=await print.locator('.print-label').boundingBox();
      assert(Math.abs(bounds.x-96/25.4)<0.1,'Left border must be inset 1 mm');
      assert(Math.abs(bounds.width-66*96/25.4)<0.1,'Right 3 mm clearance must remain');
      assert.equal(await print.locator('.dl-top-code .dl-code-caption').count(),0);
      const codes=await print.locator('[data-barcode-kind="product"]').evaluateAll(images=>images.map(img=>img.dataset.barcodeValue));
      assert.equal(codes.length,2);assert.equal(codes[0],codes[1]);assert.match(codes[0],/^98\d{20}$/);
      if(i===0)firstCode=codes[0];else assert.equal(codes[0],firstCode,'Reprint must retain the issued identity');
      assert.equal(await print.locator('[data-barcode-kind="trace"]').count(),1);
      assert.equal(await print.locator('.dl-side-code').textContent(),'');
      assert.equal(await print.locator('.dl-temperature').textContent(),'냉동');
      assert.equal(await print.locator('.dl-company-role').textContent(),'제조판매원');
      assert.match(await print.locator('.dl-company-address').textContent(),/소담2로/);
      await print.locator('.print-label').screenshot({path:path.join(artifacts,i?'reprint.png':'outer.png')});
      await print.pdf({path:path.join(artifacts,i?'reprint.pdf':'outer.pdf'),preferCSSPageSize:true,printBackground:true});
      await print.close();
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: deployed outer-print button and reprint emit the new layout; two product barcodes, one trace barcode, unchanged reprint identity');
    console.log('PASS: no real login, backend writes or physical printing');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
