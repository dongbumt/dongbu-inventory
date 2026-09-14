/* Shared print-only document. Does not change label contents, print logs or ERP data. */
(function(global){
  'use strict';
  function createDocument({labelsHtml='',sizeKey='7x10',preview=false,autoPrint=true}={}){
    const width=sizeKey==='10x10'?100:70;
    const height=100;
    // Keep the working left/top origin. Reserve 3 mm on the right for the
    // label driver's non-printable edge; the physical page stays 70/100 x 100 mm.
    const contentWidth=width-3;
    const baseHref=global.document.baseURI.replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
    return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<base href="${baseHref}">
<title>라벨 출력</title>
<style>
  @page { size:${width}mm ${height}mm; margin:0 !important; }
  @page :first { margin:0 !important; }
  @page :left { margin:0 !important; }
  @page :right { margin:0 !important; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { margin:0; padding:0; background:#fff; }
  body { width:${width}mm; font-family:"Malgun Gothic","맑은 고딕",Arial,sans-serif; font-size:7pt; color:#000; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .print-label,.lbl-label { width:${contentWidth}mm; height:${height}mm; margin:0; border:2px solid #000; padding:1.5pt 2pt 4pt; display:flex; flex-direction:column; line-height:1.2; font-weight:bold; overflow:hidden; background:#fff; page-break-inside:avoid; break-inside:avoid-page; page-break-after:always; break-after:page; }
  .print-label:last-child,.lbl-label:last-child { page-break-after:auto; break-after:auto; }
  /* Preserve the original certification artwork, including its white lettering.
     Both turquoise and orange must print black rather than faint halftone dots. */
  #label-print-pages img[alt="HACCP"] { filter:grayscale(1) brightness(0.6) contrast(20); }
  .print-tools { display:none; }
  .preview-watermark { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; font-size:28pt; font-weight:900; color:rgba(100,100,100,.18); transform:rotate(-25deg); pointer-events:none; }
  @media screen {
    html,body { background:#eef0f2; }
    body { width:auto; padding:12px; }
    .print-tools { display:block; max-width:660px; padding:14px; margin-bottom:12px; border:1px solid #bcc2c8; border-radius:8px; background:#fff; color:#25292d; font-size:14px; line-height:1.6; }
    .print-tools strong { font-size:17px; }
    .print-tools p { margin:5px 0; }
    .print-tools button { min-height:48px; padding:8px 18px; margin-top:8px; border:1px solid #33383e; border-radius:6px; background:#33383e; color:#fff; font:inherit; cursor:pointer; }
    .print-tools button:disabled { background:#747b83; cursor:wait; }
    #label-print-status { margin-top:8px; }
    .print-label,.lbl-label { margin:0 0 12px; }
  }
  @media print {
    html,body { width:${width}mm !important; height:auto !important; min-height:0 !important; margin:0 !important; padding:0 !important; background:#fff !important; }
    .print-tools { display:none !important; }
    #label-print-pages { margin:0 !important; padding:0 !important; }
    .print-label,.lbl-label { margin:0 !important; }
  }
</style></head><body>
<aside class="print-tools" aria-label="라벨 인쇄 설정 안내">
  <strong>${preview?'라벨 미리보기':'라벨 인쇄'} · ${width} × ${height} mm</strong>
  <p>인쇄창 설정: <b>용지 ${width} × ${height} mm · 배율 100% · 여백 없음 · 머리글/바닥글 해제</b></p>
  <p>오른쪽 테두리 잘림 방지를 위해 라벨 내용에 우측 3mm 안전 여백을 적용했습니다. HACCP 마크는 흑백 인쇄용으로 표시됩니다.</p>
  <p>위에 날짜·제목이 찍히거나 아래가 잘리면 ‘설정 더보기’와 프린터 기본 설정을 확인하세요. 프로그램에서 저장된 프린터 설정을 강제로 변경할 수는 없습니다.</p>
  <p>한 장씩 시험 출력한 뒤 여러 장을 출력하세요. 이 창에서 다시 인쇄해도 생산량이나 출력이력은 추가되지 않습니다.</p>
  <button id="label-print-again" type="button">${preview?'미리보기 인쇄':'인쇄창 다시 열기'}</button>
  <div id="label-print-status" role="status" aria-live="polite">인쇄 자료 준비 중…</div>
</aside>
<main id="label-print-pages">${labelsHtml}</main>
${preview?'<div class="preview-watermark">미리보기</div>':''}
<script>
(() => {
  const button=document.getElementById('label-print-again');
  const status=document.getElementById('label-print-status');
  let busy=false;
  async function prepare(andPrint){
    if(busy) return;
    busy=true;button.disabled=true;
    status.textContent='글꼴과 인증 마크를 확인하고 있습니다…';
    let timer;
    try{
      const images=[...document.querySelectorAll('#label-print-pages img')];
      const loaded=images.map(img=>{
        if(img.complete&&!img.naturalWidth){const src=img.src;img.removeAttribute('src');img.src=src;}
        return img.decode();
      });
      await Promise.race([
        Promise.all([document.fonts.ready,...loaded]),
        new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('load timeout')),10000);})
      ]);
      if(images.some(img=>!img.complete||!img.naturalWidth)) throw new Error('image unavailable');
      // Off-screen frames may throttle animation frames. Images/fonts are ready;
      // force layout and yield without depending on a visible frame's RAF.
      document.getElementById('label-print-pages').getBoundingClientRect();
      await new Promise(resolve=>window.parent===window?requestAnimationFrame(()=>requestAnimationFrame(resolve)):setTimeout(resolve,0));
      status.textContent='준비 완료 · 용지 ${width} × ${height} mm / 배율 100% / 여백 없음 / 머리글·바닥글 해제';
      if(andPrint) window.print();
      return true;
    }catch(error){
      status.textContent='인증 마크 또는 글꼴을 불러오지 못해 인쇄를 중단했습니다. 인터넷 연결을 확인한 뒤 이 창의 인쇄 버튼을 다시 눌러주세요.';
      return false;
    }finally{
      clearTimeout(timer);busy=false;button.disabled=false;
    }
  }
  button.addEventListener('click',()=>prepare(true));
  window.DBMTLabelPrintReady=new Promise(resolve=>setTimeout(()=>resolve(prepare(${!preview&&autoPrint?'true':'false'})),0));
})();
<\/script></body></html>`;
  }
  function write(win,content){
    // Navigate to a complete document so fonts, images and startup scripts have a
    // normal load lifecycle, including newly opened about:blank popup windows.
    const url=global.URL.createObjectURL(new Blob([content],{type:'text/html;charset=utf-8'}));
    try{win.location.replace(url);}catch(error){global.URL.revokeObjectURL(url);throw error;}
    const cleanup=global.setInterval(()=>{
      if(win.closed){global.clearInterval(cleanup);global.URL.revokeObjectURL(url);}
    },1000);
  }
  let hiddenPrintQueue=Promise.resolve();
  let activeHiddenFrame=null;
  function printHidden(options={}){
    // One native print request at a time, including calls from different buttons.
    const task=hiddenPrintQueue.then(()=>new Promise((resolve,reject)=>{
      if(activeHiddenFrame?.isConnected){
        reject(new Error('이전 인쇄 요청이 아직 열려 있습니다. 인쇄창을 닫고 실제 출력을 확인해주세요. 계속되면 화면을 새로고침해주세요.'));
        return;
      }
      const frame=global.document.createElement('iframe');
      frame.dataset.dbmtLabelPrint='true';
      frame.title='라벨 인쇄 자료';
      frame.setAttribute('aria-hidden','true');
      frame.tabIndex=-1;
      // Keep a rendered browsing context, but no popup, focus change or UI space.
      // display:none/visibility:hidden can suppress print layout in some browsers.
      frame.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;z-index:-1;';
      let settled=false,started=false,loadHandled=false;
      let prepareTimer,printTimer;
      function dispose(){
        global.clearTimeout(prepareTimer);global.clearTimeout(printTimer);
        frame.remove();
        if(activeHiddenFrame===frame) activeHiddenFrame=null;
      }
      function fail(error,retainFrame=false){
        if(settled) return;
        settled=true;
        global.clearTimeout(prepareTimer);global.clearTimeout(printTimer);
        if(!retainFrame) dispose();
        reject(error);
      }
      function afterPrint(){
        if(!started) return;
        global.clearTimeout(printTimer);
        // afterprint also fires on cancellation: it is NOT proof of physical output.
        // Defer removal until the browser has returned from its print lifecycle.
        global.setTimeout(()=>{
          dispose();
          if(!settled){settled=true;resolve();}
        },0);
      }
      frame.addEventListener('load',async()=>{
        if(loadHandled||settled) return;
        const win=frame.contentWindow;
        if(win.location.href!=='about:srcdoc') return;
        loadHandled=true;
        try{
          if(!win.DBMTLabelPrintReady||!await win.DBMTLabelPrintReady){
            throw new Error('라벨 이미지나 글꼴을 준비하지 못해 인쇄하지 않았습니다. 연결을 확인한 뒤 출력이력에서 재출력해주세요.');
          }
          if(settled) return;
          global.clearTimeout(prepareTimer);
          win.addEventListener('afterprint',afterPrint,{once:true});
          started=true;
          printTimer=global.setTimeout(()=>fail(new Error('인쇄 종료 알림을 받지 못했습니다. 중복 출력하지 말고 실제 출력과 인쇄창을 확인한 뒤 화면을 새로고침해주세요.'),true),120000);
          win.print();
        }catch(error){fail(error);}
      });
      prepareTimer=global.setTimeout(()=>fail(new Error('인쇄 자료 준비 시간이 초과됐습니다. 출력이력에서 재출력해주세요.')),15000);
      try{
        frame.srcdoc=createDocument({...options,preview:false,autoPrint:false});
        activeHiddenFrame=frame;
        global.document.body.appendChild(frame);
      }catch(error){fail(error);}
    }));
    hiddenPrintQueue=task.catch(()=>{});
    return task;
  }
  global.DBMTLabelPrint={createDocument,write,printHidden};
})(window);
