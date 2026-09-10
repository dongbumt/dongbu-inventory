// Local print-layout fixtures only: never logs in, saves production data, or prints to hardware.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const repo = path.resolve(__dirname,'..');
const artifacts = fs.mkdtempSync(path.join(require('node:os').tmpdir(),'dbmt-label-layout-'));
new vm.Script(fs.readFileSync(path.join(repo,'label-print-document.js'),'utf8'));
const server = http.createServer((req,res)=>{
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
    const context=await browser.newContext({viewport:{width:900,height:1100}});
    await context.route('https://**/*',route=>route.abort());
    await context.addInitScript(()=>{window.__printCalls=0;window.print=()=>window.__printCalls++;});
    const page=await context.newPage();await page.goto(base+'/label-print.html');
    const errors=[];context.on('page',popup=>popup.on('pageerror',err=>errors.push(err.message)));
    for(const [key,temperature,count] of [['7x10','냉동',1],['7x10','냉장',3],['10x10','냉동',2]]){
      const printHTML=await page.evaluate(({key,temperature,count})=>{
        const log={product:'돈등심(작업)',labelWeight:2,lot:'903112100182',workOrderSnapshot:{product:'돈등심(작업)',origin:'미국산',mfgdate:'2026-09-10',expdate:'2027-09-09',itemno:'202502930933',lot:'903112100182',ingredients:'돼지고기 100%',temptype:temperature}};
        let output='';const original=DBMTLabelPrint.write;
        try{DBMTLabelPrint.write=(win,value)=>{output=value;};writePrintDocument({},Array.from({length:count},()=>log),key);}finally{DBMTLabelPrint.write=original;}
        return output;
      },{key,temperature,count});
      const popup=await context.newPage();await popup.goto(base+'/label-print.html');
      await popup.setContent(printHTML);
      await popup.waitForSelector('.print-label');
      await popup.waitForFunction(()=>[...document.images].every(img=>img.complete&&img.naturalWidth>0));
      await popup.evaluate(()=>document.fonts.ready);
      await popup.waitForFunction(()=>window.__printCalls===1);
      assert(await popup.locator('.print-tools').isVisible());
      await popup.locator('#label-print-again').click();
      await popup.waitForFunction(()=>window.__printCalls===2);
      await popup.emulateMedia({media:'print'});
      assert(await popup.locator('.print-tools').isHidden(),'Setup guidance must not occupy printed space');
      const dimensions=await popup.locator('.print-label').evaluateAll(labels=>labels.map(label=>{
        const rect=label.getBoundingClientRect();
        const text=[...label.querySelectorAll('div')].find(el=>el.children.length===0&&el.textContent.includes('인천광역시'));
        const footer=text?.getBoundingClientRect();
        return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,bottom:rect.bottom,footerBottom:footer?.bottom,footerText:text?.textContent};
      }));
      const name=`${key}-${temperature==='냉동'?'frozen':'chilled'}-${count}`;
      assert.equal(dimensions.length,count);
      assert(Math.abs(dimensions[0].x)<0.1 && Math.abs(dimensions[0].y)<0.1,'No blank space above label in print media');
      assert(Math.abs(dimensions[0].width-(key==='7x10'?70:100)*96/25.4)<1);
      assert(Math.abs(dimensions[0].height-100*96/25.4)<1);
      for(const d of dimensions) assert(d.footerBottom<=d.bottom,'Manufacturer address must be inside label');
      await popup.pdf({path:path.join(artifacts,name+'.pdf'),preferCSSPageSize:true,printBackground:true,displayHeaderFooter:true});
      const info=execFileSync('pdfinfo',[path.join(artifacts,name+'.pdf')],{encoding:'utf8'});
      assert.match(info,new RegExp(`Pages:\\s+${count}\\b`),'One page per label, no extra blank pages');
      const pageSize=info.match(/Page size:\s+([\d.]+) x ([\d.]+) pts/);
      assert(pageSize);
      assert(Math.abs(Number(pageSize[1])-(key==='7x10'?70:100)*72/25.4)<1);
      assert(Math.abs(Number(pageSize[2])-100*72/25.4)<1);
      const text=JSON.parse(execFileSync(process.env.PYTHON_PATH||'python',['-c','import json,sys; from pypdf import PdfReader; print(json.dumps("\\n".join(p.extract_text() for p in PdfReader(sys.argv[1]).pages)))',path.join(artifacts,name+'.pdf')],{encoding:'utf8'}));
      assert(!text.includes('라벨 출력')&&!text.includes('인쇄창')&&!text.includes('http://'),'No browser headers, footers, or setup UI on paper');
      assert(text.includes('동부엠티')&&text.includes('검단구'),'Manufacturer and address must survive PDF pagination');
      await popup.locator('.print-label').first().screenshot({path:path.join(artifacts,name+'.png')});
      await popup.close();
    }
    // Both ERP and standalone use the same print-only document, without changing label data.
    const index=fs.readFileSync(path.join(repo,'index.html'),'utf8');
    const start=index.indexOf('function printLabelData('),end=index.indexOf('\nfunction printLabel(){',start);
    assert(start>0&&end>start);
    const erpPage=await context.newPage();await erpPage.goto(base+'/label-print.html');
    await erpPage.addScriptTag({content:index.slice(start,end)});
    await erpPage.evaluate(()=>{
      window.__erpPrintHTML='';window.open=()=>({});DBMTLabelPrint.write=(win,value)=>{window.__erpPrintHTML=value;};
      printLabelData({product:'ERP 확인',weight:'2.00',temptype:'냉동',crossNotice:'본 제품은 소고기를 사용한 제품과 같은 제조시설에서 제조하고 있습니다'},'10x10',2);
    });
    const erpDoc=await erpPage.evaluate(()=>window.__erpPrintHTML);
    assert.equal((erpDoc.match(/class="lbl-label"/g)||[]).length,2);
    assert.match(erpDoc,/size:100mm 100mm/);assert.match(erpDoc,/머리글\/바닥글 해제/);
    await erpPage.close();
    // Preview does not auto-print, but still has a watermark and print settings guide.
    const previewHTML=await page.evaluate(()=>DBMTLabelPrint.createDocument({labelsHtml:'<section class="print-label">미리보기 확인</section>',preview:true}));
    const preview=await context.newPage();await preview.goto(base+'/label-print.html');await preview.setContent(previewHTML);
    await preview.waitForFunction(()=>document.getElementById('label-print-status').textContent.startsWith('준비 완료'));
    assert.equal(await preview.evaluate(()=>window.__printCalls),0);assert(await preview.locator('.preview-watermark').isVisible());await preview.close();
    // Missing image must stop printing instead of silently omitting certification marks.
    const brokenHTML=await page.evaluate(base=>DBMTLabelPrint.createDocument({labelsHtml:`<section class="print-label"><img src="${base}/missing-qa-mark.png" alt="QA 누락 마크"></section>`}),base);
    const broken=await context.newPage();await broken.goto(base+'/label-print.html');await broken.setContent(brokenHTML);
    await broken.waitForFunction(()=>document.getElementById('label-print-status').textContent.includes('인쇄를 중단'));
    assert.equal(await broken.evaluate(()=>window.__printCalls),0);assert(await broken.locator('#label-print-again').isEnabled());await broken.close();
    // Exercise the real about:blank print-popup lifecycle, not just document capture.
    const realEvent=page.waitForEvent('popup');
    await page.evaluate(()=>{
      const win=window.open('','_blank');win.__printCalls=0;win.print=()=>win.__printCalls++;
      writePrintDocument(win,[{product:'팝업 확인',labelWeight:2,workOrderSnapshot:{product:'팝업 확인',temptype:'냉동'}}],'7x10');
    });
    const real=await realEvent;
    await real.waitForFunction(()=>window.__printCalls===1,null,{timeout:15000});
    assert.match(await real.locator('#label-print-status').textContent(),/준비 완료/);await real.close();
    assert.deepEqual(errors,[]);
    console.log('PASS: 70×100/100×100mm PDFs, 1/2/3 pages, no headers or setup UI, address visible, shared ERP output, retry, preview and failed-image guard');
    console.log('Artifacts: '+artifacts);
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(err=>{console.error(err);process.exitCode=1;server.close();});
