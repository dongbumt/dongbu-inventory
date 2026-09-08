/* Vehicle metadata only. OCR runs locally; the printable slip is never rewritten. */
(function(root){
  'use strict';
  const base=new URL('./vendor/temperature-ocr/',document.currentScript.src);
  let enginePromise;
  function loadEngine(){
    if(root.Tesseract)return Promise.resolve(root.Tesseract);
    if(enginePromise)return enginePromise;
    enginePromise=new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src=new URL('tesseract.min.js',base).href;
      const timer=setTimeout(()=>fail(),15000);
      function fail(){clearTimeout(timer);script.remove();enginePromise=null;reject(new Error('차량번호 인식 도구를 불러오지 못했습니다.'));}
      script.onload=()=>{clearTimeout(timer);if(root.Tesseract)resolve(root.Tesseract);else fail();};script.onerror=fail;
      document.head.append(script);
    });
    return enginePromise;
  }
  function parseVehicle(data){
    const lines=(data.blocks||[]).flatMap(block=>(block.paragraphs||[]).flatMap(paragraph=>paragraph.lines||[]));
    const found=[];
    for(const line of lines){
      const text=String(line.text||'').normalize('NFKC').trim();
      // Require the vehicle label, not just any four digits (date/time/temperature).
      // Thermal printing frequently makes 차 read as 자 and 번 read as 빈.
      const match=text.match(/(?:[차자]\s*량\s*[번빈]\s*호|차\s*번|vehicle\s*(?:no\.?|number)|car\s*no\.?)\s*[:：.\-]?\s*(.+)$/i);
      if(!match)continue;
      const value=match[1].replace(/\s/g,'');
      if(!/^(?:[0-9]{4}|(?:[가-힣]{2,4})?[0-9]{2,3}[가-힣][0-9]{4})$/.test(value))continue;
      const words=(line.words||[]).filter(word=>/[0-9]/.test(word.text||''));
      const confidence=words.length?Math.min(...words.map(word=>Number(word.confidence)||0)):Number(line.confidence)||0;
      if(confidence>=70)found.push({vehicleNo:value,confidence});
    }
    if(new Set(found.map(item=>item.vehicleNo)).size!==1)return null;
    return found.sort((a,b)=>b.confidence-a.confidence)[0];
  }
  async function headerImage(image){
    const img=new Image();img.src=image;await img.decode();
    const height=Math.min(img.naturalHeight*.25,img.naturalWidth*.65);
    const canvas=document.createElement('canvas');canvas.width=1400;canvas.height=Math.max(1,Math.round(height*1400/img.naturalWidth));
    canvas.getContext('2d').drawImage(img,0,0,img.naturalWidth,height,0,0,canvas.width,canvas.height);
    return canvas;
  }
  function increaseContrast(canvas){
    const ctx=canvas.getContext('2d',{willReadFrequently:true}),pixels=ctx.getImageData(0,0,canvas.width,canvas.height),hist=new Uint32Array(256);
    for(let i=0;i<pixels.data.length;i+=4){const gray=Math.round(pixels.data[i]*.299+pixels.data[i+1]*.587+pixels.data[i+2]*.114);hist[gray]++;pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=gray;}
    const total=canvas.width*canvas.height;let sum=0,low=0,high=255;
    for(let i=0;i<256;i++){sum+=hist[i];if(sum<total*.02)low=i;if(sum<total*.9)high=i;}
    for(let i=0;i<pixels.data.length;i+=4){const gray=Math.max(0,Math.min(255,(pixels.data[i]-low)*255/Math.max(30,high-low)));pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=gray;}
    ctx.putImageData(pixels,0,0);
  }
  async function recognizeVehicle(image,{signal,onProgress=()=>{}}={}){
    let worker=null,stopped=false,timer,abortHandler;
    const stoppedError=()=>new DOMException('인식 취소','AbortError');
    const guard=()=>{if(stopped||signal?.aborted)throw stoppedError();};
    const interruption=new Promise((resolve,reject)=>{
      abortHandler=()=>{stopped=true;reject(stoppedError());};
      signal?.addEventListener('abort',abortHandler,{once:true});
      timer=setTimeout(()=>{stopped=true;reject(new Error('차량번호 인식 시간이 초과되었습니다.'));},45000);
    });
    const work=(async()=>{
      try{
        guard();const engine=await loadEngine();guard();
        const header=await headerImage(image);guard();
        worker=await engine.createWorker(['kor','eng'],1,{
          workerPath:new URL('worker.min.js',base).href,corePath:new URL('core',base).href,
          langPath:new URL('lang',base).href,cachePath:'dbmt-vehicle-fast-8741641',workerBlobURL:false,
          logger:progress=>{if(!stopped&&!signal?.aborted)onProgress(progress);},errorHandler:()=>{}
        });
        guard();await worker.setParameters({tessedit_pageseg_mode:'6',user_defined_dpi:'300'});guard();
        for(let pass=0;pass<2;pass++){
          if(pass)increaseContrast(header);
          const {data}=await worker.recognize(header,{}, {text:true,blocks:true});guard();
          const result=parseVehicle(data);if(result)return result;
        }
        return null;
      }finally{if(worker){await worker.terminate().catch(()=>{});worker=null;}}
    })();
    try{return await Promise.race([work,interruption]);}
    finally{
      stopped=true;clearTimeout(timer);signal?.removeEventListener('abort',abortHandler);
      if(worker){await worker.terminate().catch(()=>{});worker=null;}
    }
  }
  root.DBMTTemperatureOCR={recognizeVehicle,parseVehicle};
})(window);
