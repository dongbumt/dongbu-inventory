/* Shared label artwork for ERP previews, standalone printing and reprints. */
(function(global){
  'use strict';
  const styles = `
    .dbmt-label-body { flex:1; min-height:0; height:100%; display:flex; flex-direction:column; font-family:"Malgun Gothic","맑은 고딕",Arial,sans-serif; font-size:6.5pt; font-weight:700; line-height:1.13; color:#000; background:#fff; }
    .dbmt-label-body,.dbmt-label-body * { box-sizing:border-box; margin:0; padding:0; }
    .dbmt-label-body .dl-row { flex-shrink:0; border-bottom:0.3mm solid #000; padding:0.4mm 0.5mm; }
    .dbmt-label-body .dl-key { flex-shrink:0; font-size:6pt; font-weight:900; }
    .dbmt-label-body .dl-top-code { height:8.5mm; display:flex; align-items:center; gap:1mm; }
    .dbmt-label-body .dl-code-caption { flex-shrink:0; font-size:6pt; font-weight:900; }
    .dbmt-label-body .dl-code-body { flex:1; min-width:0; text-align:center; }
    .dbmt-label-body .dl-code-body img { display:block; width:100%; height:5.2mm; object-fit:fill; }
    .dbmt-label-body .dl-code-number { font-family:Arial,sans-serif; font-size:7pt; line-height:1; padding-top:0.25mm; overflow-wrap:anywhere; }
    .dbmt-label-body .dl-unissued { font-size:6.5pt; }
    .dbmt-label-body .dl-split-body { display:grid; grid-template-columns:minmax(0,1fr) 8mm; flex-shrink:0; }
    .dbmt-label-body .dl-main-fields { min-width:0; }
    .dbmt-label-body .dl-product-row { height:6.4mm; display:flex; align-items:center; gap:1mm; }
    .dbmt-label-body .dl-product-name { min-width:0; font-size:13pt; font-weight:900; line-height:1.05; overflow-wrap:anywhere; }
    .dbmt-label-body .dl-grade-row { height:4.5mm; display:grid; grid-template-columns:1fr 1fr; padding:0; }
    .dbmt-label-body .dl-grade-cell { display:flex; align-items:center; gap:0.7mm; padding:0.4mm 0.5mm; min-width:0; }
    .dbmt-label-body .dl-grade-cell:first-child { border-right:0.3mm solid #000; }
    .dbmt-label-body .dl-grade-value { flex:1; min-width:0; text-align:center; font-size:8pt; }
    .dbmt-label-body .dl-origin-value { flex:1; min-width:0; text-align:center; font-size:10pt; }
    .dbmt-label-body .dl-date-row { height:7.1mm; display:flex; flex-direction:column; justify-content:center; gap:0.45mm; }
    .dbmt-label-body .dl-date-value { font-size:9.2pt; font-weight:900; text-align:center; white-space:nowrap; }
    .dbmt-label-body .dl-weight-row { height:8.3mm; display:grid; grid-template-columns:1fr 1fr; padding:0; }
    .dbmt-label-body .dl-weight-cell { border-right:0.3mm solid #000; display:flex; align-items:center; gap:0.8mm; padding:0.4mm 0.5mm; min-width:0; }
    .dbmt-label-body .dl-weight-value { flex:1; min-width:0; display:flex; align-items:baseline; justify-content:center; gap:0.7mm; white-space:nowrap; }
    .dbmt-label-body .dl-weight-value strong { font-size:17.5pt; font-weight:900; line-height:1; }
    .dbmt-label-body .dl-weight-value span { font-size:8pt; }
    .dbmt-label-body .dl-report-cell { display:flex; flex-direction:column; justify-content:center; gap:0.8mm; min-width:0; padding:0.4mm 0.5mm; }
    .dbmt-label-body .dl-report-value { font-family:Arial,sans-serif; font-size:8.4pt; text-align:center; overflow-wrap:anywhere; }
    .dbmt-label-body .dl-trace-code { height:8.2mm; display:flex; align-items:center; gap:0.6mm; }
    .dbmt-label-body .dl-trace-code .dl-code-body img { height:4.7mm; }
    .dbmt-label-body .dl-ingredients-row { height:4.8mm; display:flex; align-items:center; gap:1.5mm; }
    .dbmt-label-body .dl-ingredients-value { min-width:0; font-size:8pt; }
    .dbmt-label-body .dl-meat { display:inline-block; background:#000; color:#fff; padding:0.2mm 0.5mm; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    .dbmt-label-body .dl-storage-row { height:6.4mm; display:flex; align-items:center; }
    .dbmt-label-body .dl-storage-copy { flex:1; min-width:0; font-size:6pt; line-height:1.18; }
    .dbmt-label-body .dl-storage-note { margin-top:0.4mm; font-size:5.8pt; }
    .dbmt-label-body .dl-temperature { flex-shrink:0; font-size:13pt; font-weight:900; line-height:1; border:0.5mm solid #000; padding:0.35mm 1mm; white-space:nowrap; }
    .dbmt-label-body .dl-side-strip { display:flex; justify-content:center; align-items:center; position:relative; min-width:0; border-left:0.3mm solid #000; border-bottom:0.3mm solid #000; }
    .dbmt-label-body .dl-side-code { width:44mm; flex-shrink:0; transform:rotate(-90deg); }
    .dbmt-label-body .dl-side-code img { display:block; width:100%; height:4.6mm; object-fit:fill; }
    .dbmt-label-body .dl-footer { flex:1; min-height:0; display:flex; flex-direction:column; gap:0.6mm; padding:0.6mm 0.5mm 0; }
    .dbmt-label-body .dl-notices { flex:1; min-height:0; display:flex; flex-direction:column; justify-content:space-between; gap:0.2mm; font-size:6.5pt; line-height:1.15; overflow-wrap:break-word; }
    .dbmt-label-body .dl-notice-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:1mm; }
    .dbmt-label-body .dl-notice-short { flex:1; min-width:0; display:flex; flex-direction:column; gap:0.2mm; }
    .dbmt-label-body .dl-manufacturer { flex-shrink:0; display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; min-height:14mm; gap:0.3mm; }
    .dbmt-label-body .dl-company { min-width:0; display:flex; flex-direction:column; gap:0.35mm; }
    .dbmt-label-body .dl-company-role { font-size:6.5pt; line-height:1.1; }
    .dbmt-label-body .dl-company-name { font-size:11pt; font-weight:900; line-height:1.08; white-space:nowrap; }
    .dbmt-label-body .dl-company-phone { font-size:7pt; line-height:1.1; }
    .dbmt-label-body .dl-company-address { grid-column:1 / -1; font-size:6.2pt; line-height:1.17; white-space:nowrap; }
    .dbmt-label-body .dl-marks { display:flex; align-items:center; gap:0.6mm; }
    .dbmt-label-body .dl-mark { display:block; width:10.4mm; height:11.6mm; object-fit:contain; }
    .dbmt-label-body .dl-haccp { width:11.6mm; filter:grayscale(1) brightness(0.6) contrast(20); }
    #lbl-preview,#wo-preview { display:flex; flex-direction:column; box-sizing:border-box; padding:0.55mm 0.7mm 0.8mm; border:2px solid #000; font-family:"Malgun Gothic","맑은 고딕",Arial,sans-serif; background:#fff; color:#000; }
  `;
  const escape = value => String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  // Reversible numeric encoding keeps existing identities while reducing Code 128 modules.
  function encodePrintCode(value){
    const code=String(value||''),match=/^DB(\d{10})-([0-9A-Z]{1,6})$/.exec(code);
    if(!match) return code;
    const number=parseInt(match[2],36);
    if(number.toString(36).toUpperCase()!==match[2]) return code;
    return '98'+match[1]+number.toString().padStart(10,'0');
  }
  function decodePrintCode(value){
    const code=String(value||''),match=/^98(\d{10})(\d{10})$/.exec(code);
    if(!match||Number(match[2])>=36**6) return code;
    return 'DB'+match[1]+'-'+Number(match[2]).toString(36).toUpperCase();
  }
  const images = new Map();
  function barcodeImage(value){
    value=String(value||'');
    if(!value) return '';
    if(!/^[\x20-\x7e]+$/.test(value)) return '';
    if(images.has(value)) return images.get(value);
    if(typeof global.JsBarcode!=='function') throw new Error('바코드 생성 도구를 불러오지 못했습니다. 화면을 새로고침해주세요.');
    const svg=global.document.createElementNS('http://www.w3.org/2000/svg','svg');
    global.JsBarcode(svg,value,{format:'CODE128',width:1,height:20,displayValue:false,margin:0,marginLeft:10,marginRight:10});
    svg.setAttribute('viewBox',`0 0 ${parseFloat(svg.getAttribute('width'))} ${parseFloat(svg.getAttribute('height'))}`);
    svg.setAttribute('preserveAspectRatio','none');
    svg.setAttribute('shape-rendering','crispEdges');
    const src='data:image/svg+xml;base64,'+global.btoa(new global.XMLSerializer().serializeToString(svg));
    if(images.size>=1000) images.clear();
    images.set(value,src);
    return src;
  }
  function codeImage(src,value,kind,alt){
    return src?`<img src="${src}" data-barcode-kind="${kind}" data-barcode-value="${escape(value)}" alt="${alt}">`:'';
  }
  function buildBody(d={}){
    // An issued print-log code is the identity. Never derive one from product/LOT or mockup samples.
    const code=String(d.productBarcode||'');
    const lot=String(d.lot??d.lotText??'');
    const productImage=barcodeImage(code),traceImage=barcodeImage(lot);
    if(code&&!productImage) throw new Error('출력이력의 고유번호를 바코드로 변환할 수 없습니다. 고유번호를 확인해주세요.');
    const product=String(d.product||'');
    const productUnits=Array.from(product).reduce((sum,ch)=>sum+(ch.charCodeAt(0)>255?1:0.55),0);
    const productFont=Math.max(6,Math.min(13,13*9/Math.max(9,productUnits)));
    const weight=String(d.weight||'0.00'),weightFont=Math.min(17.5,17.5*5/Math.max(5,weight.length));
    const temperature=d.temptype||'냉동',chilled=temperature==='냉장';
    const name=String(d.manufacturer||'주식회사 동부엠티').replace(/주식회사\s*동부엠티/g,'주식회사 동부엠티');
    const ingredients=escape(d.ingredients||'').replace(/(돼지고기|소고기)\s*/g,'<span class="dl-meat">$1</span> ');
    const notice=d.crossNotice||d.crossFacilityNotice||'';
    const asset=file=>escape(new URL(file,global.document.baseURI).href);
    return `<div class="dbmt-label-body">
      <div class="dl-row dl-top-code"><span class="dl-code-caption">제품<br>고유번호</span><div class="dl-code-body">${codeImage(productImage,code,'product','상단 제품 고유바코드')}<div class="dl-code-number${code?'':' dl-unissued'}">${escape(code)||'미발급'}</div></div></div>
      <div class="dl-split-body"><div class="dl-main-fields">
        <div class="dl-row dl-product-row"><span class="dl-key">제품명:</span><strong class="dl-product-name" style="font-size:${productFont}pt;">${escape(product)}</strong></div>
        <div class="dl-row dl-grade-row"><div class="dl-grade-cell"><span class="dl-key">성별및등급:</span><span class="dl-grade-value">${escape(d.grade)}</span></div><div class="dl-grade-cell"><span class="dl-key">원산지:</span><strong class="dl-origin-value">${escape(d.origin)}</strong></div></div>
        <div class="dl-row dl-date-row"><span class="dl-key">제조 및 소비기한:</span><strong class="dl-date-value">${escape(d.mfgdate)} ~ ${escape(d.expdate)}</strong></div>
        <div class="dl-row dl-weight-row"><div class="dl-weight-cell"><span class="dl-key">중량:</span><div class="dl-weight-value">${d.weightOmitted?'':`<strong style="font-size:${weightFont}pt;">${escape(weight)}</strong><span>Kg</span>`}</div></div><div class="dl-report-cell"><span class="dl-key">품목보고번호</span><strong class="dl-report-value">${escape(d.itemno)}</strong></div></div>
        <div class="dl-row dl-trace-code"><span class="dl-code-caption">이력번호</span><div class="dl-code-body">${codeImage(traceImage,lot,'trace','이력번호 바코드')}<div class="dl-code-number">${escape(lot)}</div></div></div>
        <div class="dl-row dl-ingredients-row"><span class="dl-key">원료 및 함량</span><strong class="dl-ingredients-value">${ingredients}</strong></div>
        <div class="dl-row dl-storage-row"><div class="dl-storage-copy"><div><strong>보관방법:</strong> ${chilled?'-2℃ ~ 5℃이하 냉장보관':'-18℃이하 냉동보관'}</div>${chilled?'':'<div class="dl-storage-note">이미 냉동된바 있으니 해동후 재냉동 시키지 마십시오</div>'}</div></div>
      </div><div class="dl-side-strip"><div class="dl-side-code">${codeImage(productImage,code,'product','우측 세로 제품 고유바코드')}</div></div></div>
      <div class="dl-footer"><div class="dl-notices"><div class="dl-notice-heading"><div class="dl-notice-short"><div>· 허가번호: ${escape(d.licenseno)}</div><div>· 식품의유형: ${escape(d.prodtype)}</div><div>· 포장재질: ${escape(d.packaging)}</div></div><strong class="dl-temperature">${escape(temperature)}</strong></div>
        <div>· 반품및교환: 제조원및판매원 하단 표시</div><div>· 부정,불량 축산물 신고는 국번없이 1399</div><div>· 이 제품은 공정거래위원회 고시 소비자 분쟁해결기준에 의거 교환 또는 보상받을 수 있습니다</div><div>· 동봉되는 흡습제는 먹어서는 아니됩니다</div><div class="dl-cross-notice">· ${escape(notice)}</div>
      </div><div class="dl-manufacturer"><div class="dl-company"><div class="dl-company-role">제조판매원</div><div class="dl-company-name">${escape(name)}</div><div class="dl-company-phone">${escape(d.phone)}</div></div><div class="dl-marks"><img class="dl-mark" src="${asset('assets/other-recycle.svg')}" alt="OTHER 재활용 표시"><img class="dl-mark dl-haccp" src="${asset('HACCP2.png')}" alt="HACCP"></div><div class="dl-company-address">${escape(d.address)}</div></div></div>
    </div>`;
  }
  const style=global.document.createElement('style');
  style.id='dbmt-label-layout-style';
  style.textContent=styles;
  global.document.head.appendChild(style);
  global.DBMTLabelLayout={styles,buildBody,encodePrintCode,decodePrintCode};
})(window);
