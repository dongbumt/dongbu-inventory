// Local print-layout fixtures only: never logs in, saves production data, or prints to hardware.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const repo = path.resolve(__dirname,'..');
const artifacts = fs.mkdtempSync(path.join(require('node:os').tmpdir(),'dbmt-label-layout-'));
function inspectPrintedPage(pdfPath,markRect,paperWidth){
  // Inspect real PDF rasterization at the installed XD5-40t's 203-dpi class,
  // not just CSS filter values or an enlarged on-screen logo.
  const prefix=pdfPath.replace(/\.pdf$/, '-203dpi');
  execFileSync('pdftoppm',['-f','1','-singlefile','-r','203','-png',pdfPath,prefix]);
  const png=PNG.sync.read(fs.readFileSync(prefix+'.png'));
  const pixel=(x,y)=>Array.from(png.data.subarray((y*png.width+x)*4,(y*png.width+x)*4+3));
  const mm=203/25.4, css=203/96;
  let samples=0,black=0,white=0,colored=0;
  for(let y=Math.ceil(markRect.y*css);y<Math.floor((markRect.y+markRect.height)*css);y++){
    for(let x=Math.ceil(markRect.x*css);x<Math.floor((markRect.x+markRect.width)*css);x++){
      const channels=pixel(x,y);samples++;
      if(Math.max(...channels)<32) black++;
      if(Math.min(...channels)>240) white++;
      if(Math.max(...channels)-Math.min(...channels)>2) colored++;
    }
  }
  assert(black/samples>0.2,'HACCP artwork must contain solid black, not pale cyan halftones');
  assert(white/samples>0.35,'HACCP white background and reverse lettering must stay white');
  assert.equal(colored,0,'HACCP must render monochrome in the actual PDF');
  const point=(fx,fy)=>pixel(Math.round((markRect.x+markRect.width*fx)*css),Math.round((markRect.y+markRect.height*fy)*css));
  assert(Math.max(...point(0.5,0.67))<32,'Original orange swoosh must also print black');
  assert(Math.min(...point(0.5,0.15))>240,'White interior of certification artwork must stay white');
  // The rightmost 3 mm is sacrificial printer clearance, not clipped content.
  for(let y=1;y<png.height-1;y++){
    for(let x=Math.ceil((paperWidth-3+0.25)*mm);x<Math.min(png.width,Math.floor((paperWidth-0.1)*mm));x++){
      assert(Math.min(...pixel(x,y))>240,'Right-hand printer clearance must be blank');
    }
  }
  const borderX=Math.floor((paperWidth-3-0.2)*mm);
  let borderRows=0;
  for(let y=2;y<png.height-2;y++) if(Math.min(...pixel(borderX,y))<96) borderRows++;
  assert(borderRows/(png.height-4)>0.95,'Right outer border must be continuous inside the safe area');
  return {blackRatio:black/samples,whiteRatio:white/samples};
}
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
    for(const [key,temperature,count,beef] of [['7x10','냉동',1,false],['7x10','냉장',3,false],['10x10','냉동',2,false],['7x10','냉동',1,true]]){
      const printHTML=await page.evaluate(({key,temperature,count,beef})=>{
        const product=beef?'소등심(작업)':temperature==='냉장'?'냉장돈등심(치즈용)':'돈등심(작업)';
        const log={product,labelWeight:20,lot:'903112100182',workOrderSnapshot:{product,origin:'미국산',mfgdate:'2026-09-10',expdate:'2027-09-09',itemno:'202502930933',lot:'903112100182',ingredients:beef?'소고기 100%':'돼지고기 100%',temptype:temperature}};
        let output='';const original=DBMTLabelPrint.write;
        try{DBMTLabelPrint.write=(win,value)=>{output=value;};writePrintDocument({},Array.from({length:count},()=>log),key);}finally{DBMTLabelPrint.write=original;}
        return output;
      },{key,temperature,count,beef});
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
        const notice=[...label.querySelectorAll('div')].find(el=>el.children.length===0&&el.textContent.includes('본 제품은'))?.getBoundingClientRect();
        const manufacturer=text?.parentElement.getBoundingClientRect();
        const mark=label.querySelector('img[alt="HACCP"]').getBoundingClientRect();
        return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,bottom:rect.bottom,footerBottom:footer?.bottom,footerText:text?.textContent,noticeBottom:notice?.bottom,manufacturerTop:manufacturer?.top,mark:{x:mark.x,y:mark.y,width:mark.width,height:mark.height}};
      }));
      const name=`${key}-${temperature==='냉동'?'frozen':'chilled'}-${count}${beef?'-beef':''}`;
      assert.equal(dimensions.length,count);
      assert(Math.abs(dimensions[0].x)<0.1 && Math.abs(dimensions[0].y)<0.1,'No blank space above label in print media');
      assert(Math.abs(dimensions[0].width-(key==='7x10'?67:97)*96/25.4)<1);
      assert(Math.abs(dimensions[0].height-100*96/25.4)<1);
      for(const d of dimensions){
        assert(d.footerBottom<=d.bottom,'Manufacturer address must be inside label');
        assert(d.noticeBottom<=d.manufacturerTop,'Narrower label must not overlap notice and manufacturer');
      }
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
      assert(text.includes(beef?'돼지고기를 사용한':'소고기를 사용한'),'Cross-facility notice must survive narrower layout');
      const ink=inspectPrintedPage(path.join(artifacts,name+'.pdf'),dimensions[0].mark,key==='7x10'?70:100);
      console.log(`${name}: HACCP black ${(ink.blackRatio*100).toFixed(1)}%, white ${(ink.whiteRatio*100).toFixed(1)}%; right border and 3mm clearance OK`);
      await popup.locator('.print-label').first().screenshot({path:path.join(artifacts,name+'.png')});
      await popup.close();
    }
    // Both ERP and standalone use the same print-only document, without changing label data.
    const index=fs.readFileSync(path.join(repo,'index.html'),'utf8');
    const start=index.indexOf('function printLabelData('),end=index.indexOf('\nfunction printLabel(){',start);
    assert(start>0&&end>start);
    const erpPage=await context.newPage();await erpPage.goto(base+'/label-print.html');
    // Use the actual ERP body and mark helper, not the standalone function of the same name.
    const bodyStart=index.indexOf('function formatLabelIngredients('),bodyEnd=index.indexOf('\nfunction autoSetExpiryWithDays(',bodyStart);
    assert(bodyStart>0&&bodyEnd>bodyStart);
    await erpPage.addScriptTag({content:'const htmlEscape=v=>String(v??" ").replace(/[&<>"\']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;","\'":"&#39;"}[c]));\n'+index.slice(bodyStart,bodyEnd)});
    await erpPage.addScriptTag({content:index.slice(start,end)});
    await erpPage.evaluate(()=>{
      window.__erpPrintHTML='';window.open=()=>({});DBMTLabelPrint.write=(win,value)=>{window.__erpPrintHTML=value;};
      printLabelData({product:'ERP 확인',manufacturer:'주식회사 동부엠티',weight:'20.00',temptype:'냉동',crossFacilityNotice:'본 제품은 소고기를 사용한 제품과 같은 제조시설에서 제조하고 있습니다'},'10x10',2);
    });
    const erpDoc=await erpPage.evaluate(()=>window.__erpPrintHTML);
    assert.equal((erpDoc.match(/class="lbl-label"/g)||[]).length,2);
    assert.match(erpDoc,/size:100mm 100mm/);assert.match(erpDoc,/머리글\/바닥글 해제/);
    for(const size of ['7x10','10x10']){
      const html=await erpPage.evaluate(size=>{
        printLabelData({product:'돈등심(작업)',manufacturer:'주식회사 동부엠티',phone:'032-766-1812',address:'인천광역시 검단구 소담2로 36 2동 201호 (금곡동)',weight:'20.00',origin:'미국산',mfgdate:'2026.09.14',expdate:'2027.09.13',temptype:'냉동',ingredients:'돼지고기 100%',crossFacilityNotice:'본 제품은 소고기를 사용한 제품과 같은 제조시설에서 제조하고 있습니다'},size,1);
        return window.__erpPrintHTML;
      },size);
      const actual=await context.newPage();await actual.goto(base+'/label-print.html');await actual.setContent(html);
      await actual.waitForFunction(()=>window.__printCalls===1);
      await actual.emulateMedia({media:'print'});
      const mark=await actual.locator('img[alt="HACCP"]').boundingBox();
      const pdfPath=path.join(artifacts,`erp-${size}.pdf`);
      await actual.pdf({path:pdfPath,preferCSSPageSize:true,printBackground:true});
      inspectPrintedPage(pdfPath,mark,size==='7x10'?70:100);
      await actual.close();
    }
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
    console.log('PASS: 70×100/100×100mm PDFs, 1/2/3 pages, 3mm right clearance, continuous border, 203dpi monochrome HACCP, no headers or setup UI, address/notice visible, actual ERP output, retry, preview and failed-image guard');
    console.log('Artifacts: '+artifacts);
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(err=>{console.error(err);process.exitCode=1;server.close();});
