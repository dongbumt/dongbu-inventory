/* Shared print-only document. Does not change label contents, print logs or ERP data. */
(function(global){
  'use strict';
  function createDocument({labelsHtml='',sizeKey='7x10',preview=false}={}){
    const width=sizeKey==='10x10'?100:70;
    const height=100;
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
  .print-label,.lbl-label { width:${width}mm; height:${height}mm; margin:0; border:2px solid #000; padding:1.5pt 2pt 4pt; display:flex; flex-direction:column; line-height:1.2; font-weight:bold; overflow:hidden; background:#fff; page-break-inside:avoid; break-inside:avoid-page; page-break-after:always; break-after:page; }
  .print-label:last-child,.lbl-label:last-child { page-break-after:auto; break-after:auto; }
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
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      status.textContent='준비 완료 · 용지 ${width} × ${height} mm / 배율 100% / 여백 없음 / 머리글·바닥글 해제';
      if(andPrint) window.print();
    }catch(error){
      status.textContent='인증 마크 또는 글꼴을 불러오지 못해 인쇄를 중단했습니다. 인터넷 연결을 확인한 뒤 이 창의 인쇄 버튼을 다시 눌러주세요.';
    }finally{
      clearTimeout(timer);busy=false;button.disabled=false;
    }
  }
  button.addEventListener('click',()=>prepare(true));
  setTimeout(()=>prepare(${preview?'false':'true'}),0);
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
  global.DBMTLabelPrint={createDocument,write};
})(window);
