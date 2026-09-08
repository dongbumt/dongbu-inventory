/* In-memory mocked RPC tests: no production reads/writes. Optional --photo PATH
   exercises a supplied photo without adding it to the repository. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),http=require('node:http');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..');
for(const file of ['temperature-record.js','driver-temperature.js','driver-temperature-office.js','driver-sw.js','m02-auth.js'])new vm.Script(fs.readFileSync(path.join(repo,file),'utf8'),{filename:file});
for(const file of ['index.html','driver-attendance.html'])for(const match of fs.readFileSync(path.join(repo,file),'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
const photoIndex=process.argv.indexOf('--photo'),photo=photoIndex>=0?process.argv[photoIndex+1]:null;
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-temperature-'));
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{
  const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1),file=path.resolve(repo,relative||'index.html');
  if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
const multiply=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const executablePath=process.env.CHROME_PATH||[chromium.executablePath(),'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(p=>fs.existsSync(p));
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const context=await browser.newContext({viewport:{width:430,height:930},serviceWorkers:'block',hasTouch:true});
    await context.addInitScript(()=>{localStorage.setItem('dbmt_driver_session_token','test-driver-token');window.print=()=>{window.printCalled=true;};});
    const requests=[],records=[];let failFirst=true;
    await context.route('https://**/*',async route=>{
      const name=route.request().url().split('/').pop(),body=route.request().postDataJSON();let response={};
      if(name==='dbmt_driver_state')response={account:{id:'test-driver',employeeName:'테스트 기사'},weekStart:'2026-09-07',weekEntries:[],todayEvents:[]};
      else if(name==='dbmt_temperature_record_list')response={ok:true,rows:records,total:records.length};
      else if(name==='dbmt_driver_save_temperature_record'){
        requests.push(body);
        if(!records.length)records.push({id:'test-record',record_date:body.p_record.date,vehicle_no:body.p_record.vehicleNo,employee_name:'테스트 기사',created_at:new Date().toISOString()});
        if(failFirst){failFirst=false;await route.abort('failed');return;}response={ok:true,id:'test-record'};
      }else{await route.abort();return;}
      await route.fulfill({contentType:'application/json',body:JSON.stringify(response)});
    });
    const page=await context.newPage();await page.goto(base+'/driver-attendance.html');await page.waitForSelector('#app-view:not(.hidden)');
    await page.evaluate(()=>{const original=DBMTTemperatureRecord.detectPaper;DBMTTemperatureRecord.detectPaper=source=>{const result=original(source);window.detectedPaper=result;return result;};});
    const sample=await page.evaluate(()=>{
      const c=document.createElement('canvas');c.width=1000;c.height=1600;const g=c.getContext('2d');g.fillStyle='#333';g.fillRect(0,0,c.width,c.height);g.fillStyle='#eee';g.fillRect(250,80,500,1440);g.fillStyle='#222';g.font='25px sans-serif';g.fillText('TEMPERATURE TEST / 4245',280,140);
      for(let i=0;i<24;i++)g.fillText(`${String(i).padStart(2,'0')}:00 A:-20.0 B:02.0 C`,280,220+i*48);
      g.fillRect(250,840,500,35);return c.toDataURL('image/jpeg',.95);
    });
    const upload=photo||{name:'test-slip.jpg',mimeType:'image/jpeg',buffer:Buffer.from(sample.split(',')[1],'base64')};
    await page.locator('#temp-photo-input').setInputFiles(upload);await page.waitForSelector('#temp-editor:not(.hidden)');
    await page.waitForFunction(()=>window.detectedPaper&&!document.getElementById('temp-crop-btn').disabled);
    const detection=await page.evaluate(()=>detectedPaper);console.log('Detection:',JSON.stringify(detection));
    assert.equal(detection.detected,true);assert.ok(Math.min(...detection.corners.map(p=>p.y))<.1);assert.ok(detection.corners[2].y>.9&&detection.corners[3].y>.9,'dark band must not truncate lower half');
    await page.screenshot({path:path.join(artifacts,'driver-corners.png'),fullPage:true});
    await page.locator('#temp-crop-btn').click();await page.waitForSelector('#temp-preview:not(.hidden)');
    await page.waitForFunction(()=>!document.getElementById('temp-upload-btn').disabled);
    await page.locator('#temp-date').fill('2026-09-07');await page.locator('#temp-vehicle').fill('4245');
    const crop=await page.locator('#temp-preview-image').evaluate(img=>({image:img.src,width:img.naturalWidth,height:img.naturalHeight}));
    assert.ok(crop.width>=450&&crop.width<=900);assert.ok(crop.height>crop.width);assert.ok(crop.image.startsWith('data:image/jpeg;base64,'));
    await page.screenshot({path:path.join(artifacts,'driver-preview.png'),fullPage:true});
    const cropView=await context.newPage();await cropView.setContent(`<img src="${crop.image}" style="max-width:650px">`);await cropView.locator('img').screenshot({path:path.join(artifacts,'cropped-slip.png')});await cropView.close();
    await page.locator('#temp-upload-btn').click();await page.waitForFunction(()=>document.getElementById('temp-message').textContent.includes('중복 저장되지'));
    await page.locator('#temp-upload-btn').click();await page.waitForFunction(()=>document.getElementById('temp-message').textContent.includes('전송 완료!'));
    assert.equal(requests.length,2);assert.deepEqual(requests[0].p_record,requests[1].p_record,'retry must reuse immutable payload');
    assert.equal(requests[0].p_record.image,crop.image);assert.equal(requests[0].p_record.width,crop.width);assert.equal(records.length,1);
    assert.equal(await page.locator('#temp-preview-image').getAttribute('src'),null,'clear image after confirmed delivery');
    console.log('PASS: driver photo -> detection -> crop -> upload -> lost-response retry, no overwrite');

    // Office UI uses authenticated image-detail retrieval, not public image URLs.
    const office=await browser.newPage({viewport:{width:1280,height:1000}});
    await office.addInitScript(()=>{window.print=()=>{};});
    const index=fs.readFileSync(path.join(repo,'index.html'),'utf8');
    const officeHtml=index.slice(index.indexOf('<div class="card" id="driver-temperature-office">'),index.indexOf('<div class="stat-grid" id="da-stat-grid">'));
    await office.setContent(`<style>${fs.readFileSync(path.join(repo,'styles/main.css'),'utf8')}</style>${officeHtml}`);
    await office.addScriptTag({content:fs.readFileSync(path.join(repo,'temperature-record.js'),'utf8')});
    const record={...records[0],...crop,image_width:crop.width,image_height:crop.height};
    await office.evaluate(record=>{
      window.DBMTAuth={isPersonal:()=>true,can:()=>true,getSessionToken:()=>'office-test'};window.toast=message=>{window.lastToast=message;};
      window.sbRpc=async(name,args)=>name==='dbmt_temperature_record_image'?record:{ok:true,rows:[record],total:1};
    },record);
    await office.addScriptTag({content:fs.readFileSync(path.join(repo,'driver-temperature-office.js'),'utf8')});
    await office.evaluate(()=>initDriverTemperatureOffice());await office.locator('#dt-body button').click();await office.waitForFunction(()=>!document.getElementById('dt-view-print').disabled);
    await office.screenshot({path:path.join(artifacts,'office-preview.png'),fullPage:true});
    const popupEvent=office.waitForEvent('popup');await office.locator('#dt-view-print').click();const preview=await popupEvent;
    await preview.waitForFunction(()=>document.documentElement.dataset.printReady==='true');
    assert.equal(await preview.locator('.cut').count(),Math.ceil(55*crop.height/crop.width/260));
    await preview.close();await office.close();

    const {getDocument,OPS}=await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
    const printPage=await context.newPage();await printPage.goto(base+'/driver-attendance.html');
    const longImage=await printPage.evaluate(()=>{const c=document.createElement('canvas');c.width=550;c.height=9000;const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,550,9000);g.fillStyle='#111';g.font='28px sans-serif';for(let y=40;y<9000;y+=70)g.fillText('Temperature '+y+' -20.0 C',20,y);return c.toDataURL('image/jpeg');});
    for(const [name,docRecord,pages] of [['sample',record,1],['long',{...record,image:longImage},2]]){
      const documentHtml=await page.evaluate(record=>DBMTTemperatureRecord.buildPrintDocument(record),docRecord);await printPage.setContent(documentHtml);
      await printPage.waitForFunction(()=>document.documentElement.dataset.printReady==='true');
      const widths=await printPage.locator('.cut').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().width*25.4/96));
      widths.forEach(width=>assert.ok(Math.abs(width-55)<.05));
      await printPage.screenshot({path:path.join(artifacts,`${name}-a4.png`),fullPage:true});
      const pdf=await printPage.pdf({path:path.join(artifacts,`${name}-a4.pdf`),preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false});
      const document=await getDocument({data:new Uint8Array(pdf)}).promise;assert.equal(document.numPages,pages);
      let imageCount=0;
      for(let n=1;n<=document.numPages;n++){
        const p=await document.getPage(n);assert.ok(Math.abs(p.view[2]-595.28)<2&&Math.abs(p.view[3]-841.89)<2);
        assert.ok((await p.getTextContent()).items.map(item=>item.str).join('').includes('55mm'), 'printed calibration ruler');
        const operations=await p.getOperatorList();let matrix=[1,0,0,1,0,0],stack=[];
        for(let i=0;i<operations.fnArray.length;i++){
          const op=operations.fnArray[i],args=operations.argsArray[i];
          if(op===OPS.save)stack.push([...matrix]);else if(op===OPS.restore)matrix=stack.pop();else if(op===OPS.transform)matrix=multiply(matrix,args);
          else if(op===OPS.paintImageXObject){const mm=Math.hypot(matrix[0],matrix[1])*25.4/72;assert.ok(Math.abs(mm-55)<.15,`PDF image width ${mm}mm`);imageCount++;}
        }
      }
      assert.ok(imageCount>=widths.length);await document.destroy();console.log(`${name}: ${pages} A4 page(s); image width verified as 55mm in PDF drawing operators`);
    }
    // No injected markup from record metadata.
    const escaped=await page.evaluate(record=>DBMTTemperatureRecord.buildPrintDocument({...record,employee_name:'</script><img onerror=alert(1)>'}),record);
    assert.equal((escaped.match(/<script>/g)||[]).length,1);assert.ok(!escaped.includes('<img onerror'));
    console.log(`Artifacts: ${artifacts}`);
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
