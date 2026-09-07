/* 재고현황의 조회 결과를 그대로 출력하는 A4 가로 1장 보고서. */
(function(root){
  'use strict';
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[char]);
  const number = value => {
    const result = Number(String(value ?? '').replace(/,/g, '').trim());
    return Number.isFinite(result) ? result : 0;
  };
  const qty = value => number(value).toLocaleString('ko-KR', {minimumFractionDigits:2, maximumFractionDigits:2});
  const money = value => Math.round(number(value)).toLocaleString('ko-KR');
  const cell = value => escapeHtml(String(value ?? '').trim() || '-');
  const status = stock => stock < -0.01 ? '마이너스' : stock > 0.01 ? '정상' : '소진';

  function buildDocument({companyName='주식회사 동부엠티', filters={}, rows=[], warning='', queriedAt=''}={}){
    const basis = filters.asOfDate ? `${filters.asOfDate} 마감` : '현재 (전체 저장 거래)';
    const totalStock = rows.reduce((sum, row) => sum + number(row.stock), 0);
    const totalAmount = rows.reduce((sum, row) => sum + Math.round(number(row.stock) * number(row.price)), 0);
    const stockRows = rows.map((row, i) => `<tr>
      <td class="center">${i + 1}</td><td>${cell(row.stockLocation)}</td>
      <td><strong>${cell(row.product)}</strong>${row.packunit ? `<span class="detail">${escapeHtml(row.packunit)}</span>` : ''}</td>
      <td>${cell(row.brand)}<span class="detail">${cell(row.grade)}</span></td>
      <td>${cell(row.lot)}<span class="detail">${cell(row.proddate)}</span></td><td>${cell(row.origin)}</td>
      <td class="number">${qty(row.total_in)}</td><td class="number">${qty(row.total_use)}</td>
      <td class="number">${qty(row.total_out)}</td><td class="number">${qty(row.total_adjust)}</td>
      <td class="number"><strong>${qty(row.stock)}</strong></td><td class="number">${money(row.price)}</td>
      <td class="number"><strong>${money(number(row.stock) * number(row.price))}</strong></td>
      <td class="center">${status(number(row.stock))}</td>
    </tr>`).join('');
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>재고현황 · ${escapeHtml(basis)}</title>
<style>
  @page { size:A4 landscape; margin:10mm; }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; }
  body { background:#e5e7eb; color:#111; font-family:"Malgun Gothic","맑은 고딕",Arial,sans-serif; }
  .toolbar { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:12px; padding:14px; font-size:14px; }
  button { min-height:42px; padding:8px 20px; border:1px solid #777; border-radius:5px; background:#fff; color:#111; font:inherit; cursor:pointer; }
  .sheet { width:277mm; height:189mm; margin:0 auto 20px; background:#fff; }
  .report { width:100%; padding:1mm; font-size:8.5pt; line-height:1.3; }
  header { display:flex; justify-content:space-between; align-items:flex-end; gap:4mm; border-bottom:2px solid #222; padding:2mm 0 3mm; }
  h1 { font-size:21pt; margin:0; letter-spacing:2px; }
  .company { font-size:11pt; overflow-wrap:anywhere; }
  .summary { display:flex; flex-wrap:wrap; justify-content:space-between; gap:2mm 5mm; margin:3mm 0 2mm; font-size:10pt; }
  .conditions { margin:0 0 3mm; overflow-wrap:anywhere; }
  table { width:100%; border-collapse:collapse; table-layout:fixed; }
  th,td { border:1px solid #888; padding:1.4mm 1mm; vertical-align:middle; overflow-wrap:anywhere; }
  th { background:#f2f2f2; text-align:center; font-weight:700; }
  .number { text-align:right; font-variant-numeric:tabular-nums; }
  .center { text-align:center; }
  .detail { display:block; margin-top:.6mm; font-size:.9em; color:#444; }
  .warning { margin:2mm 0; font-weight:700; overflow-wrap:anywhere; }
  footer { margin-top:3mm; padding-top:2mm; border-top:1px solid #999; color:#444; overflow-wrap:anywhere; }
  .compact { line-height:1.15; }
  .compact th,.compact td { padding:.7mm 1mm; }
  .compact .detail { margin-top:0; }
  @media print {
    html,body { width:277mm; background:#fff; }
    .toolbar { display:none; }
    .sheet { margin:0; }
    th { print-color-adjust:exact; -webkit-print-color-adjust:exact; }
    tr { break-inside:avoid; }
  }
</style></head><body>
<div class="toolbar"><span>A4 가로 · 1장 맞춤 (인쇄 설정의 머리글/바닥글은 꺼주세요)</span><button type="button" onclick="printReport()">🖨 출력</button><button type="button" onclick="window.close()">닫기</button></div>
<main class="sheet"><article class="report">
  <header><h1>재고현황</h1><div class="company">${escapeHtml(companyName)}</div></header>
  <div class="summary"><strong>기준일: ${escapeHtml(basis)}</strong><span>조회 ${rows.length}건 · 재고량 <strong>${qty(totalStock)} KG</strong> · 재고금액 <strong>${money(totalAmount)}원</strong></span></div>
  <div class="conditions">지점: ${escapeHtml(filters.location || '전체 지점')} / 상태: ${escapeHtml(filters.status || '전체(소진포함)')} / 검색: ${escapeHtml(filters.query || '전체')} · 중량: KG / 금액: 원</div>
  <table aria-label="기준일 재고현황">
    <colgroup><col style="width:3%"><col style="width:6%"><col style="width:17%"><col style="width:8%"><col style="width:14%"><col style="width:5%"><col style="width:6%"><col style="width:6%"><col style="width:6%"><col style="width:6%"><col style="width:6%"><col style="width:6%"><col style="width:8%"><col style="width:3%"></colgroup>
    <thead><tr><th>No.</th><th>지점</th><th>품목명 / 포장규격</th><th>브랜드 / 등급</th><th>이력번호 / 생산일</th><th>원산지</th><th>총입고</th><th>총사용</th><th>총출고</th><th>조정</th><th>재고</th><th>단가</th><th>재고금액</th><th>상태</th></tr></thead>
    <tbody>${stockRows || '<tr><td colspan="14" class="center">선택한 기준일과 조회조건에 해당하는 재고가 없습니다.</td></tr>'}</tbody>
  </table>
  ${warning ? `<div class="warning">${escapeHtml(warning)}</div>` : ''}
  <footer>현재 저장된 거래의 거래일 기준으로 계산한 재고입니다. 기준일 이후 거래는 날짜별 조회에서 제외됩니다.${queriedAt ? `<br>조회 시각: ${escapeHtml(queriedAt)}` : ''}</footer>
</article></main>
<script>
  function fitOnePage(){
    const sheet = document.querySelector('.sheet');
    const report = document.querySelector('.report');
    report.style.zoom = 1;
    report.classList.remove('compact');
    const maxHeight = sheet.getBoundingClientRect().height - 2;
    if(report.getBoundingClientRect().height > maxHeight) report.classList.add('compact');
    if(report.getBoundingClientRect().height > maxHeight){
      let low = 0.001, high = 1;
      for(let i = 0; i < 20; i++){
        const scale = (low + high) / 2;
        report.style.zoom = scale;
        if(report.getBoundingClientRect().height <= maxHeight) low = scale;
        else high = scale;
      }
      report.style.zoom = low;
    }
    document.documentElement.dataset.printReady = 'true';
  }
  async function printReport(){
    if(document.fonts) await document.fonts.ready;
    fitOnePage();
    window.focus();
    window.print();
  }
  window.addEventListener('beforeprint', fitOnePage);
  window.addEventListener('load', printReport, {once:true});
</script></body></html>`;
  }

  function open(options){
    const html = buildDocument(options);
    const popup = root.open('', '_blank', 'width=1150,height=850');
    if(!popup) return false;
    popup.opener = null;
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    return true;
  }
  root.DBMTStockReport = {buildDocument, open};
})(window);
