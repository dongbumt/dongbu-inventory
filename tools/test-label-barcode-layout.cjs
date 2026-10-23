// Local fixtures only. No logins, business-data writes or physical printer calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os'),vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-label-barcodes-'));
for(const file of ['label-layout.js','label-print-document.js']) new vm.Script(fs.readFileSync(path.join(repo,file),'utf8'),{filename:file});
const server=http.createServer((req,res)=>{
  const file=path.resolve(repo,new URL(req.url,'http://localhost').pathname.slice(1)||'label-print.html');
  if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try{
    const context=await browser.newContext({viewport:{width:1000,height:1000},deviceScaleFactor:1});
    await context.route('https://**/*',route=>route.abort());
    await context.addInitScript(()=>{window.print=()=>{throw Error('Physical printing is forbidden in this test');};});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/label-print.html');
    const fixture={id:'qa-barcode-order',product:'돈사태(작업)',origin:'국내산',grade:'1',mfgdate:'2026-08-21',expdate:'2027-08-20',weight:12,itemno:'2025029309311',lot:'L12608194894027',ingredients:'돼지고기 100%',temptype:'냉동'};
    for(const [name,size,patch] of [
      ['maximum-details','7x10',{ingredients:'소고기 100% ('+'추가원재료'.repeat(8)+')'}],
      ['frozen','7x10',{}],['chilled','7x10',{product:'냉장돈등심(치즈용)',temptype:'냉장',weight:5}],
      ['wide','10x10',{}],['long-lot','10x10',{lot:'TEST-20260729-12345678901234567890'}],
      ['long-product','7x10',{product:'냉장돈등심(치즈돈까스용 10mm 슬라이스 특수규격)',weight:1000.12}],
      ['weight-omitted','7x10',{weightOmitted:true,weight:0}],['legacy-lot','7x10',{lot:'수기 LOT-123'}],
      ['mixed-origin','7x10',{product:'우민찌(지방15%)',origin:'미국산/국내산',ingredients:'소고기 100% (전각(미국산) 85%, 우지방(국내산) 15%)'}],
      ['mixed-origin-wide','10x10',{product:'우민찌(지방15%)',origin:'미국산/국내산',ingredients:'소고기 100% (전각(미국산) 85%, 우지방(국내산) 15%)'}]
    ]){
      const doc=await page.evaluate(({fixture,size,patch})=>{
        const log=makePrintLog({...fixture,...patch,labelSize:size},'QA',1);
        const data=labelDataFromLog(log);
        return {code:log.code,barcode:data.productBarcode,restoredCode:DBMTLabelLayout.decodePrintCode(data.productBarcode),lot:data.lot,html:DBMTLabelPrint.createDocument({labelsHtml:`<section class="print-label">${buildLabelBody(data)}</section>`,sizeKey:size,autoPrint:false})};
      },{fixture,size,patch});
      assert(!doc.html.includes('98110000002477'),'Mockup-only identity must never reach operational labels');
      assert.equal(doc.restoredCode,doc.code,'Numeric barcode must preserve the original saved identity');
      assert.match(doc.barcode,/^98\d{20}$/);
      const print=await context.newPage();
      await print.goto(base+'/label-print.html');await print.setContent(doc.html);
      assert(await print.evaluate(()=>DBMTLabelPrintReady),'Fonts, marks and generated SVGs must load');
      await print.emulateMedia({media:'print'});
      const bounds=await print.locator('.print-label').boundingBox();
      assert(Math.abs(bounds.x-2*96/25.4)<0.1,'Left inset must be 2 mm');
      assert(Math.abs(bounds.width-(size==='7x10'?66:96)*96/25.4)<0.1,'Retain content width and right 2 mm clearance');
      assert.equal(await print.locator('.dl-top-code .dl-code-caption').count(),0,'Remove the top caption, not the barcode/number');
      assert.equal(await print.locator('.dl-top-code .dl-code-number').textContent(),doc.barcode);
      const dateLine=await print.locator('.dl-date-row').evaluate(row=>{
        const key=row.querySelector('span'),value=row.querySelector('strong'),a=key.getBoundingClientRect(),b=value.getBoundingClientRect();
        const range=document.createRange();range.selectNodeContents(value);
        return {lines:range.getClientRects().length,horizontal:a.right<=b.left+0.5,gap:b.left-a.right,sameLine:a.top<b.bottom&&b.top<a.bottom,fits:value.scrollWidth<=value.clientWidth+1,height:row.getBoundingClientRect().height};
      });
      assert.equal(dateLine.lines,1,`${name}: date must not wrap`);assert(dateLine.horizontal&&dateLine.sameLine&&dateLine.fits,`${name}: title and dates share one line`);
      assert(dateLine.gap<=1.5*96/25.4,`${name}: dates sit immediately after the title`);
      assert(dateLine.height<=5*96/25.4,'Date row saves vertical space');
      const ingredientLayout=await print.locator('.dl-ingredients-row').evaluate(row=>{
        const details=row.querySelector('.dl-ingredients-details'),head=row.querySelector('.dl-ingredients-main'),base=row.querySelector('.dl-ingredients-value');
        return {text:row.textContent.replace(/\s/g,''),details:details?.textContent,below:details&&details.getBoundingClientRect().top>=head.getBoundingClientRect().bottom-0.5,smaller:details&&parseFloat(getComputedStyle(details).fontSize)<parseFloat(getComputedStyle(base).fontSize)};
      });
      assert.equal(ingredientLayout.text,('원료 및 함량:'+(patch.ingredients||fixture.ingredients)).replace(/\s/g,''),'Preserve every ingredient character');
      if(patch.ingredients){assert(ingredientLayout.below&&ingredientLayout.smaller,'Additional composition has its own smaller line');assert(ingredientLayout.details.startsWith('(')&&ingredientLayout.details.endsWith(')'));}
      if(patch.temptype!=='냉장')assert(await print.locator('.dl-storage-note').evaluate(node=>parseFloat(getComputedStyle(node).fontSize)<parseFloat(getComputedStyle(node.parentElement).fontSize)),'Refreezing note is smaller than storage instructions');
      const result=await print.locator('.print-label').evaluate(label=>{
        const bounds=label.getBoundingClientRect(),overflow=[];
        const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right};};
        const textBounds=el=>{const range=document.createRange();range.selectNodeContents(el);return [...range.getClientRects()];};
        for(const el of label.querySelectorAll('.dbmt-label-body div,.dbmt-label-body span,.dbmt-label-body strong,.dbmt-label-body img')){
          const r=el.getBoundingClientRect();
          if(r.left<bounds.left-0.1||r.right>bounds.right+0.1||r.bottom>bounds.bottom+0.1||r.top<bounds.top-0.1)overflow.push(el.className);
        }
        for(const row of label.querySelectorAll('.dl-row')){
          const rowRect=row.getBoundingClientRect();
          for(const el of row.querySelectorAll('span,strong,.dl-code-number,.dl-ingredients-details,.dl-storage-copy>div'))for(const r of textBounds(el)){
            if(r.left<rowRect.left-0.5||r.right>rowRect.right+0.5||r.top<rowRect.top-0.5||r.bottom>rowRect.bottom+0.5)overflow.push({text:el.textContent,row:rect(row),textRect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom}});
          }
        }
        const address=label.querySelector('.dl-company-address'),addressLines=textBounds(address);
        const companyLines=['.dl-company-role','.dl-company-name','.dl-company-phone','.dl-company-address'].map(selector=>rect(label.querySelector(selector)));
        const marks=rect(label.querySelector('.dl-marks'));
        return {overflow,addressLineCount:addressLines.length,addressRight:addressLines[0].right,right:bounds.right,
          companyLines,marks,noticesBottom:rect(label.querySelector('.dl-notices')).bottom,manufacturerTop:rect(label.querySelector('.dl-manufacturer')).top,
          noticeTextBottom:Math.max(...[...label.querySelectorAll('.dl-notices div')].flatMap(el=>textBounds(el).map(r=>r.bottom))),
          badge:rect(label.querySelector('.dl-temperature')),heading:rect(label.querySelector('.dl-notice-heading')),
          sideText:label.querySelector('.dl-side-code').textContent,weightOmitted:label.querySelector('.dl-weight-value').textContent,
          barcodes:[...label.querySelectorAll('[data-barcode-kind]')].map(image=>({kind:image.dataset.barcodeKind,value:image.dataset.barcodeValue,src:image.src,...rect(image)}))};
      });
      assert.deepEqual(result.overflow,[],`${name}: clipped content`);
      assert.equal(result.addressLineCount,1);assert(result.addressRight<result.right);
      assert(result.marks.bottom<=result.companyLines[3].top,'Marks must stay above the one-line address');
      for(let i=1;i<result.companyLines.length;i++)assert(result.companyLines[i-1].bottom<=result.companyLines[i].top,'Manufacturer, company, phone, address order');
      assert(result.noticesBottom<=result.manufacturerTop,'Notice/manufacturer gap');
      assert(result.noticeTextBottom<=result.manufacturerTop+0.5,`${name}: notice text overlaps manufacturer by ${result.noticeTextBottom-result.manufacturerTop}px`);
      assert(Math.abs(result.badge.top-result.heading.top)<0.1,'Temperature badge must follow the original footer position');
      assert.equal(result.sideText,'','Vertical barcode must not contain human-readable text');
      const products=result.barcodes.filter(b=>b.kind==='product');
      assert.equal(products.length,2);assert(products.every(b=>b.value===doc.barcode));assert.equal(products[0].src,products[1].src);
      assert.equal(result.barcodes.filter(b=>b.kind==='trace').length,name==='legacy-lot'?0:1);
      if(patch.weightOmitted)assert.equal(result.weightOmitted,'');
      const pdf=path.join(artifacts,name+'.pdf');
      await print.pdf({path:pdf,preferCSSPageSize:true,printBackground:true});
      const prefix=path.join(artifacts,name+'-203dpi');
      execFileSync('pdftoppm',['-f','1','-singlefile','-r','203','-png',pdf,prefix]);
      // Optional scanner QA: pip install zxing-cpp==2.3.0 into the test environment.
      if(process.env.DBMT_TEST_BARCODE_DECODE==='1'){
        const decoded=JSON.parse(execFileSync(process.env.PYTHON_PATH||'python',['-c',
          `import sys, json, math
from PIL import Image
import zxingcpp
im = Image.open(sys.argv[1])
scale = 203 / 96
results = []
for r in json.loads(sys.argv[2]):
    crop = im.crop((max(0, math.floor(r["x"] * scale) - 2), max(0, math.floor(r["y"] * scale) - 2), math.ceil((r["x"] + r["width"]) * scale) + 2, math.ceil((r["y"] + r["height"]) * scale) + 2))
    results.append([b.text for b in zxingcpp.read_barcodes(crop)])
print(json.dumps(results))`,
          prefix+'.png',JSON.stringify(result.barcodes.map(({x,y,width,height})=>({x,y,width,height})))],{encoding:'utf8'}));
        for(let i=0;i<result.barcodes.length;i++) assert(decoded[i].includes(result.barcodes[i].value),`${name}: 203dpi barcode ${i} failed to decode`);
      }
      await print.locator('.print-label').screenshot({path:path.join(artifacts,name+'.png')});
      await print.close();console.log(`PASS: ${name} ${size}, barcode values/layout/address${process.env.DBMT_TEST_BARCODE_DECODE==='1'?' and 203dpi decoding':''}`);
    }
    for(const [name,size,patch] of [
      ['inner-frozen','7x10',{}],['inner-wide','10x10',{}],
      ['inner-chilled','7x10',{temptype:'냉장'}],['inner-weight-omitted','7x10',{weightOmitted:true,weight:0}],
      ['inner-mixed-origin','7x10',{product:'우민찌(지방15%)',origin:'미국산/국내산',ingredients:'소고기 100% (전각(미국산) 85%, 우지방(국내산) 15%)'}],
      ['inner-maximum-details','7x10',{ingredients:'소고기 100% ('+'추가원재료'.repeat(8)+')'}]
    ]){
      const doc=await page.evaluate(({fixture,size,patch})=>{
        const log={...makePrintLog({...fixture,...patch,labelSize:size},'QA',1),untrackedLabel:true};
        const data=labelDataFromLog(log),body=buildLabelBody(data);
        return DBMTLabelPrint.createDocument({labelsHtml:`<section class="print-label">${body}</section>`,sizeKey:size,autoPrint:false});
      },{fixture,size,patch});
      const print=await context.newPage();await print.setContent(doc);
      assert(await print.evaluate(()=>DBMTLabelPrintReady));await print.emulateMedia({media:'print'});
      assert.equal(await print.locator('.dbmt-inner-label').count(),1);
      assert.equal(await print.locator('[data-barcode-kind],.dl-top-code,.dl-side-strip,.dbmt-label-body').count(),0,'Inner must have no barcode artwork or reserved outer regions');
      assert.doesNotMatch(await print.locator('.print-label').textContent(),/미발급/);
      assert.match(await print.locator('.il-trace').textContent(),/L12608194894027/,'Keep the LOT as text');
      assert((await print.locator('.il-product').textContent()).includes(patch.product||fixture.product));
      const innerDate=await print.locator('.il-date').evaluate(row=>{
        const key=row.querySelector('span').getBoundingClientRect(),value=row.querySelector('strong'),r=value.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(value);
        return range.getClientRects().length===1&&key.right<=r.left+0.5&&r.left-key.right<=1.5*96/25.4&&key.top<r.bottom&&r.top<key.bottom&&value.scrollWidth<=value.clientWidth+1;
      });
      assert(innerDate,`${name}: inner title and dates share one line`);
      const innerIngredients=await print.locator('.il-ingredients').evaluate(row=>{
        const details=row.querySelector('.il-ingredients-details'),head=row.querySelector('.il-ingredients-main');
        return {text:row.textContent.replace(/\s/g,''),below:details&&details.getBoundingClientRect().top>=head.getBoundingClientRect().bottom-0.5,smaller:details&&parseFloat(getComputedStyle(details).fontSize)<parseFloat(getComputedStyle(head.querySelector('strong')).fontSize)};
      });
      assert.equal(innerIngredients.text,('원료 및 함량:'+(patch.ingredients||fixture.ingredients)).replace(/\s/g,''));
      if(patch.ingredients)assert(innerIngredients.below&&innerIngredients.smaller,'Inner composition has its own smaller line');
      assert.match(await print.locator('.il-manufacturer').textContent(),/제조판매원.*주식회사 동부엠티.*032-766-1812.*소담2로/s);
      assert.equal(await print.locator('img').count(),2,'Only the original recycling and HACCP artwork');
      if(patch.weightOmitted)assert.equal((await print.locator('.il-weight').textContent()).trim(),'');
      else assert.match(await print.locator('.il-weight').textContent(),/12\.00.*Kg/);
      const geometry=await print.locator('.print-label').evaluate(label=>{
        const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
        const inner=label.querySelector('.dbmt-inner-label'),product=label.querySelector('.il-product');
        const overflow=[...inner.querySelectorAll('div,span,strong,img')].filter(el=>{const r=rect(el),b=rect(label);return r.left<b.left-.5||r.right>b.right+.5||r.top<b.top-.5||r.bottom>b.bottom+.5;}).map(el=>el.textContent||el.alt);
        return {inner:rect(inner),product:rect(product),overflow,noticeBottom:Math.max(...[...label.querySelectorAll('.il-notices div')].map(el=>rect(el).bottom)),manufacturerTop:rect(label.querySelector('.il-manufacturer')).top};
      });
      assert.deepEqual(geometry.overflow,[],`${name}: clipped inner label`);
      if(patch.ingredients)assert(geometry.noticeBottom<=geometry.manufacturerTop+0.5,`${name}: extended inner notices overlap manufacturer`);
      assert.equal(geometry.product.top,geometry.inner.top,'Product starts at the top without a barcode band');
      assert.equal(geometry.product.right,geometry.inner.right,'Product information uses the full width');
      await print.locator('.print-label').screenshot({path:path.join(artifacts,name+'.png')});
      const pdf=path.join(artifacts,name+'.pdf');await print.pdf({path:pdf,preferCSSPageSize:true,printBackground:true});
      assert.match(execFileSync('pdfinfo',[pdf],{encoding:'utf8'}),/Pages:\s+1\b/,'One physical label per page');
      execFileSync('pdftoppm',['-f','1','-singlefile','-r','203','-png',pdf,path.join(artifacts,name+'-203dpi')]);
      await print.close();console.log(`PASS: ${name} ${size}, original full-width barcode-free form, complete text and marks`);
    }
    const safety=await page.evaluate(()=>{
      const data=labelDataFromLog({labelWeight:12,workOrderSnapshot:{product:'<img src=x onerror=alert(1)>',lot:'LOT-1'}});
      const missing=buildLabelBody(data);
      let invalid=false;try{DBMTLabelLayout.buildBody({...data,productBarcode:'한글번호'});}catch(error){invalid=true;}
      const originals=[0,1,35,36,36**6-1].map(n=>'DB2610131000-'+n.toString(36).toUpperCase());
      const roundtrips=originals.map(code=>DBMTLabelLayout.decodePrintCode(DBMTLabelLayout.encodePrintCode(code)));
      const inner=buildLabelBody(labelDataFromLog({code:'DB2610131000-ABC123',untrackedLabel:true,labelWeight:12,workOrderSnapshot:{product:'내포장',lot:'LOT-1'}}));
      return {missing,noProductBarcodes:!missing.includes('data-barcode-kind="product"'),innerBarcodeFree:!inner.includes('data-barcode-kind')&&!inner.includes('미발급')&&inner.includes('dbmt-inner-label'),invalid,originals,roundtrips};
    });
    assert(safety.noProductBarcodes,'Never invent an issued code for an old/manual label');
    assert(safety.innerBarcodeFree,'Restore the original inner label, without any barcode or unissued band');
    assert(safety.missing.includes('&lt;img'));assert(safety.invalid);
    assert.deepEqual(safety.roundtrips,safety.originals);
    assert.deepEqual(errors,[]);
    console.log('PASS: no invented identity, invalid-code guard, escaped text, no page errors');
    console.log('Artifacts: '+artifacts);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
