/* Real local OCR + mocked ERP. Optional --photo PATH never leaves this device. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-vehicle-ocr-'));
const photoIndex=process.argv.indexOf('--photo'),photo=photoIndex>=0?process.argv[photoIndex+1]:null;
const localRequests=[];
const server=http.createServer((req,res)=>{
  localRequests.push({url:req.url,method:req.method});
  const file=path.resolve(repo,decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'driver-attendance.html');
  if(!file.startsWith(repo+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png'};
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const executablePath=process.env.CHROME_PATH||[chromium.executablePath(),'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(p=>fs.existsSync(p));
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:430,height:930},hasTouch:true});
    await context.addInitScript(()=>localStorage.setItem('dbmt_driver_session_token','mock-driver-token'));
    const uploads=[],unexpected=[];
    await context.route('https://**/*',async route=>{
      const name=new URL(route.request().url()).pathname.split('/').pop();let response;
      if(name==='dbmt_driver_state')response={account:{id:'qa-driver',employeeName:'테스트 기사'},weekStart:'2026-09-07',weekEntries:[],todayEvents:[]};
      else if(name==='dbmt_temperature_record_list')response={total:1,rows:[{id:'old-record',vehicle_no:'9999',record_date:'2026-09-07',created_at:new Date().toISOString()}]};
      else if(name==='dbmt_driver_save_temperature_record'){uploads.push(route.request().postDataJSON());response={ok:true,id:`new-record-${uploads.length}`};}
      else {unexpected.push(name);await route.abort();return;}
      await route.fulfill({contentType:'application/json',body:JSON.stringify(response)});
    });
    const page=await context.newPage();await page.goto(base+'/driver-attendance.html');await page.waitForSelector('#app-view:not(.hidden)');
    assert.equal(await page.locator('#temp-vehicle').inputValue(),'','Do not copy the previous vehicle from history');
    const parserResults=await page.evaluate(()=>{
      const data=(text,confidence=95)=>({blocks:[{paragraphs:[{lines:[{text,confidence,words:[{text,confidence}]}]}]}]});
      const parse=(text,confidence)=>DBMTTemperatureOCR.parseVehicle(data(text,confidence));
      return {
        short:parse('차량번호: 4245'),leading:parse('자 량 번 호 : 0123'),full:parse('차량번호: 123가 4567'),regional:parse('차량번호: 서울12가3456'),
        date:parse('2026년 09월 07일'),interval:parse('기록간격: 1300분'),temperature:parse('14:33 A:-20.0 B:01.6'),
        low:parse('차량번호: 4245',40),long:parse('차량번호: 42456'),empty:parse('차량번호:'),
        ambiguous:DBMTTemperatureOCR.parseVehicle({blocks:[{paragraphs:[{lines:[...data('차량번호: 4245').blocks[0].paragraphs[0].lines,...data('차량번호: 0123').blocks[0].paragraphs[0].lines]}]}]})
      };
    });
    assert.equal(parserResults.short.vehicleNo,'4245');assert.equal(parserResults.leading.vehicleNo,'0123');
    assert.equal(parserResults.full.vehicleNo,'123가4567');assert.equal(parserResults.regional.vehicleNo,'서울12가3456');
    for(const key of ['date','interval','temperature','low','long','empty','ambiguous'])assert.equal(parserResults[key],null,key);
    await page.evaluate(()=>{
      window.realVehicleOCR=DBMTTemperatureOCR.recognizeVehicle;
      const crop=DBMTTemperatureRecord.cropPaper;
      DBMTTemperatureRecord.cropPaper=async(...args)=>{const result=await crop(...args);window.originalCrop=result.image;return result;};
    });
    async function sample(number){
      const image=await page.evaluate(number=>{
        const c=document.createElement('canvas');c.width=1100;c.height=1800;const g=c.getContext('2d');
        g.fillStyle='#333';g.fillRect(0,0,c.width,c.height);g.fillStyle='#fff';g.fillRect(220,60,660,1660);g.fillStyle='#111';g.font='38px sans-serif';
        g.fillText(`차량번호: ${number}`,260,150);g.fillText('기록간격: 13분',260,220);g.fillText('2026년 09월 07일',260,330);
        for(let i=0;i<18;i++)g.fillText(`14:33 A:-20.0 B:01.6`,260,410+i*65);
        return c.toDataURL('image/jpeg',.95);
      },number);
      return {name:'vehicle-slip.jpg',mimeType:'image/jpeg',buffer:Buffer.from(image.split(',')[1],'base64')};
    }
    const synthetic=await sample('4245');
    async function openPhoto(file=synthetic,wait=true){
      await page.locator('#temp-photo-input').setInputFiles(file);
      await page.waitForSelector('#temp-editor:not(.hidden)');
      await page.waitForFunction(()=>!document.getElementById('temp-crop-btn').disabled);
      await page.locator('#temp-crop-btn').click();await page.waitForSelector('#temp-preview:not(.hidden)');
      if(wait)await page.waitForFunction(()=>!document.getElementById('temp-upload-btn').disabled,{},{timeout:60000});
    }
    await openPhoto(photo||synthetic);
    assert.equal(await page.locator('#temp-vehicle').inputValue(),'4245','Real OCR should fill vehicle without typing');
    assert.match(await page.locator('#temp-vehicle-status').textContent(),/자동 인식 완료/);
    assert.equal(await page.locator('#temp-preview-image').getAttribute('src'),await page.evaluate(()=>originalCrop),'OCR must not rewrite the printed image');
    await page.locator('#temperature-panel').screenshot({path:path.join(artifacts,'auto-vehicle-mobile.png')});
    await page.locator('#temp-upload-btn').click();await page.waitForFunction(()=>document.getElementById('temp-message').textContent.includes('전송 완료!'));
    assert.equal(uploads[0].p_record.vehicleNo,'4245');assert.equal(uploads[0].p_record.image,await page.evaluate(()=>originalCrop));
    assert.equal(await page.locator('#temp-vehicle').inputValue(),'');
    console.log('PASS: real OCR -> automatic vehicle 4245 -> upload, unchanged printable image');

    await openPhoto(await sample('0123'));
    assert.equal(await page.locator('#temp-vehicle').inputValue(),'0123','Leading zero must survive actual OCR');
    await page.locator('#temp-vehicle').fill('12가3456');await page.locator('#temp-upload-btn').click();
    await page.waitForFunction(()=>document.getElementById('temp-message').textContent.includes('전송 완료!'));
    assert.equal(uploads[1].p_record.vehicleNo,'12가3456','Manual correction must be saved');

    await page.evaluate(()=>{DBMTTemperatureOCR.recognizeVehicle=async()=>null;});
    await openPhoto();assert.equal(await page.locator('#temp-vehicle').inputValue(),'');
    await page.locator('#temp-upload-btn').click();assert.equal(uploads.length,2,'Unknown vehicle must not reuse history or prior photo');
    await page.locator('#temp-vehicle').fill('9898');await page.locator('#temp-upload-btn').click();
    await page.waitForFunction(()=>document.getElementById('temp-message').textContent.includes('전송 완료!'));assert.equal(uploads[2].p_record.vehicleNo,'9898');
    await page.evaluate(()=>{DBMTTemperatureOCR.recognizeVehicle=async()=>{throw new Error('mock OCR load failure');};});
    await openPhoto();assert.match(await page.locator('#temp-vehicle-status').textContent(),/직접 입력/);
    await page.evaluate(()=>{DBMTTemperatureOCR.recognizeVehicle=async()=>({vehicleNo:'7373'});});
    await page.locator('#temp-vehicle-retry-btn').click();await page.waitForFunction(()=>document.getElementById('temp-vehicle').value==='7373');
    await page.locator('#temp-cancel-btn').click();

    await page.evaluate(()=>{DBMTTemperatureOCR.recognizeVehicle=(image,options)=>new Promise(resolve=>{window.oldOCRResolve=resolve;window.oldOCRSignal=options.signal;});});
    await openPhoto(synthetic,false);await page.waitForFunction(()=>!!window.oldOCRResolve);
    await page.locator('#temp-cancel-btn').click();assert.equal(await page.evaluate(()=>oldOCRSignal.aborted),true);
    await page.evaluate(()=>{DBMTTemperatureOCR.recognizeVehicle=async()=>({vehicleNo:'0088'});});
    await openPhoto();await page.evaluate(()=>oldOCRResolve({vehicleNo:'9999'}));
    assert.equal(await page.locator('#temp-vehicle').inputValue(),'0088','Late recognition cannot overwrite the next photo');
    await page.locator('#temp-cancel-btn').click();
    console.log('PASS: leading zero, correction, no history carryover, failed OCR, retry, cancellation and stale results');

    const timeout=await page.evaluate(async()=>{
      const create=Tesseract.createWorker,delay=window.setTimeout;let terminated=0;
      Tesseract.createWorker=async()=>({setParameters:async()=>{},recognize:()=>new Promise(()=>{}),terminate:async()=>{terminated++;}});
      window.setTimeout=(fn,ms,...args)=>delay(fn,ms===45000?50:ms,...args);
      try{await realVehicleOCR(originalCrop);return {error:false,terminated};}
      catch(error){return {error:error.message.includes('초과'),terminated};}
      finally{Tesseract.createWorker=create;window.setTimeout=delay;}
    });
    assert.equal(timeout.error,true);assert.ok(timeout.terminated>0);
    assert.deepEqual(unexpected,[],'No external OCR/image endpoint');
    assert.ok(localRequests.every(r=>r.method==='GET'),'OCR must not post photos');
    assert.ok(localRequests.some(r=>r.url.includes('/lang/kor.traineddata.gz')));
    assert.ok(localRequests.some(r=>r.url.includes('/lang/eng.traineddata.gz')));
    console.log('PASS: bounded OCR timeout, local-only engine and models');console.log(`Artifacts: ${artifacts}`);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
