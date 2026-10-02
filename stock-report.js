/* 재고현황의 조회 결과를 A4 가로 여러 장에 읽기 쉬운 크기로 출력하는 보고서. */
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

  function buildDocument({companyName='주식회사 동부엠티', filters={}, rows=[], warning='', queriedAt='', kind='stock'}={}){
    const countSheet = kind === 'count';
    const reportTitle = countSheet ? '재고 실사조사표' : '재고현황';
    const basis = filters.asOfDate ? `${filters.asOfDate} 마감` : '현재 (전체 저장 거래)';
    const totalStock = rows.reduce((sum, row) => sum + number(row.stock), 0);
    const totalAmount = rows.reduce((sum, row) => sum + Math.round(number(row.stock) * number(row.price)), 0);
    const stockRows = rows.map((row, i) => `<tr>
      <td class="center">${i + 1}</td><td>${cell(row.stockLocation)}</td>
      <td><strong>${cell(row.product)}</strong>${row.packunit ? `<span class="detail">${escapeHtml(row.packunit)}</span>` : ''}${row.stockNote ? `<span class="detail">비고: ${escapeHtml(row.stockNote)}</span>` : ''}</td>
      <td>${cell(row.brand)}<span class="detail">${cell(row.grade)}</span></td>
      <td>${cell(row.lot)}<span class="detail">${cell(row.proddate)}</span></td><td>${cell(row.origin)}</td>
      ${countSheet ? `<td class="number">${qty(row.total_adjust)}</td>
      <td class="number"><strong>${qty(row.stock)}</strong></td>
      <td class="write-cell" aria-label="실재고 기입란"></td><td class="write-cell" aria-label="차이 기입란"></td>` : `
      <td class="number">${qty(row.total_in)}</td><td class="number">${qty(row.total_use)}</td>
      <td class="number">${qty(row.total_out)}</td><td class="number">${qty(row.total_adjust)}</td>
      <td class="number"><strong>${qty(row.stock)}</strong></td><td class="number">${money(row.price)}</td>
      <td class="number"><strong>${money(number(row.stock) * number(row.price))}</strong></td>
      <td class="center">${status(number(row.stock))}</td>`}
    </tr>`).join('');
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${reportTitle} · ${escapeHtml(basis)}</title>
<style>
  @page { size:A4 landscape; margin:10mm; }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; }
  body { background:#e5e7eb; color:#111; font-family:"Malgun Gothic","맑은 고딕",Arial,sans-serif; }
  .toolbar { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:12px; padding:14px; font-size:14px; }
  button { min-height:42px; padding:8px 20px; border:1px solid #777; border-radius:5px; background:#fff; color:#111; font:inherit; cursor:pointer; }
  .sheet { width:277mm; min-height:190mm; margin:0 auto 20px; background:#fff; }
  .report { width:100%; padding:1mm; font-size:9.5pt; line-height:1.15; }
  header { display:flex; justify-content:space-between; align-items:flex-end; gap:4mm; border-bottom:2px solid #222; padding:2mm 0 3mm; }
  h1 { font-size:21pt; margin:0; letter-spacing:2px; }
  .company { font-size:11pt; overflow-wrap:anywhere; }
  .summary { display:flex; flex-wrap:wrap; justify-content:space-between; gap:2mm 5mm; margin:3mm 0 2mm; font-size:10pt; }
  .conditions { margin:0 0 3mm; overflow-wrap:anywhere; }
  table { width:100%; border-collapse:collapse; table-layout:fixed; }
  th,td { border:1px solid #888; padding:.6mm .7mm; vertical-align:middle; overflow-wrap:anywhere; }
  th { background:#f2f2f2; text-align:center; font-weight:700; }
  thead { display:table-header-group; }
  .number { text-align:right; font-variant-numeric:tabular-nums; }
  .center { text-align:center; }
  .detail { display:inline; margin-left:1mm; font-size:.85em; color:#444; }
  .count-sheet .write-cell { height:10mm; }
  .warning { margin:2mm 0; font-weight:700; overflow-wrap:anywhere; }
  footer { margin-top:3mm; padding-top:2mm; border-top:1px solid #999; color:#444; overflow-wrap:anywhere; }
  .continued-heading { display:flex; justify-content:space-between; gap:4mm; margin:0 0 3mm; padding-bottom:2mm; border-bottom:1px solid #999; font-size:11pt; font-weight:700; }
  @media print {
    html,body { background:#fff; }
    .toolbar { display:none; }
    .sheet { width:auto; min-height:0; margin:0; break-after:page; page-break-after:always; }
    .sheet.last-page { break-after:auto; page-break-after:auto; }
    th { print-color-adjust:exact; -webkit-print-color-adjust:exact; }
    tr { break-inside:avoid; page-break-inside:avoid; }
  }
</style></head><body>
<div class="toolbar"><span>A4 가로 · 여러 장 자동 분할 (인쇄 설정의 머리글/바닥글은 꺼주세요)</span><button type="button" onclick="printReport()">🖨 출력</button><button type="button" onclick="window.close()">닫기</button></div>
<main class="sheet"><article class="report${countSheet ? ' count-sheet' : ''}">
  <header><h1>${reportTitle}</h1><div class="company">${escapeHtml(companyName)}</div></header>
  <div class="summary"><strong>기준일: ${escapeHtml(basis)}</strong><span>조회 ${rows.length}건 · ${countSheet ? '현재고' : '재고량'} <strong>${qty(totalStock)} KG</strong>${countSheet ? '' : ` · 재고금액 <strong>${money(totalAmount)}원</strong>`}</span></div>
  <div class="conditions">지점: ${escapeHtml(filters.location || '전체 지점')} / 상태: ${escapeHtml(filters.status || '전체(소진포함)')} / 검색: ${escapeHtml(filters.query || '전체')} · 중량: KG${countSheet ? ' · 실재고·차이: 현장 기입' : ' / 금액: 원'}</div>
  <table aria-label="${countSheet ? '재고 실사조사표' : '기준일 재고현황'}">
    ${countSheet ? `<colgroup><col style="width:3%"><col style="width:7%"><col style="width:24%"><col style="width:9%"><col style="width:17%"><col style="width:6%"><col style="width:7%"><col style="width:9%"><col style="width:9%"><col style="width:9%"></colgroup>
    <thead><tr><th>No.</th><th>지점</th><th>품목 / 포장 / 비고</th><th>브랜드 / 등급</th><th>이력번호 / 생산일</th><th>원산지</th><th>조정</th><th>현재고</th><th>실재고</th><th>차이</th></tr></thead>` : `<colgroup><col style="width:3%"><col style="width:6%"><col style="width:19%"><col style="width:7%"><col style="width:12%"><col style="width:5%"><col style="width:6%"><col style="width:6%"><col style="width:6%"><col style="width:6%"><col style="width:6%"><col style="width:6%"><col style="width:8%"><col style="width:4%"></colgroup>
    <thead><tr><th>No.</th><th>지점</th><th>품목 / 포장 / 비고</th><th>브랜드 / 등급</th><th>이력번호 / 생산일</th><th>원산지</th><th>총입고</th><th>총사용</th><th>총출고</th><th>조정</th><th>재고</th><th>단가</th><th>재고금액</th><th>상태</th></tr></thead>`}
    <tbody>${stockRows || `<tr><td colspan="${countSheet ? 10 : 14}" class="center">선택한 기준일과 조회조건에 해당하는 재고가 없습니다.</td></tr>`}</tbody>
  </table>
  ${warning ? `<div class="warning">${escapeHtml(warning)}</div>` : ''}
  <footer>${countSheet ? '현재고는 조회 기준일의 장부 재고입니다. 실재고와 차이는 현장 실사 후 기입하세요.' : '현재 저장된 거래의 거래일 기준으로 계산한 재고입니다. 기준일 이후 거래는 날짜별 조회에서 제외됩니다.'}${queriedAt ? `<br>조회 시각: ${escapeHtml(queriedAt)}` : ''}</footer>
</article></main>
<script>
  var paginated = false;
  function paginateReport(){
    if(paginated) return;
    paginated = true;
    const firstSheet = document.querySelector('.sheet');
    const firstReport = firstSheet.querySelector('.report');
    const firstTable = firstReport.querySelector('table');
    const rows = [...firstTable.tBodies[0].rows];
    const warning = firstReport.querySelector('.warning');
    const footer = firstReport.querySelector('footer');
    const basis = firstReport.querySelector('.summary strong')?.textContent || '';
    warning?.remove();
    footer?.remove();
    firstTable.tBodies[0].replaceChildren();
    const maxHeight = 188 * 96 / 25.4;
    let sheet = firstSheet, report = firstReport, tbody = firstTable.tBodies[0];
    function nextPage(){
      sheet = document.createElement('main');
      sheet.className = 'sheet';
      report = document.createElement('article');
      report.className = firstReport.className;
      const heading = document.createElement('div');
      heading.className = 'continued-heading';
      const title = document.createElement('span');
      title.textContent = firstReport.querySelector('h1')?.textContent + ' (계속)';
      const date = document.createElement('span');
      date.textContent = basis;
      heading.append(title, date);
      const table = firstTable.cloneNode(false);
      table.append(firstTable.querySelector('colgroup').cloneNode(true), firstTable.tHead.cloneNode(true));
      tbody = document.createElement('tbody');
      table.append(tbody);
      report.append(heading, table);
      sheet.append(report);
      document.body.append(sheet);
    }
    for(const row of rows){
      tbody.append(row);
      if(report.getBoundingClientRect().height > maxHeight){
        row.remove();
        nextPage();
        tbody.append(row);
      }
    }
    if(warning) report.append(warning);
    if(footer) report.append(footer);
    if(report.getBoundingClientRect().height > maxHeight && tbody.lastElementChild){
      const lastRow = tbody.lastElementChild;
      lastRow.remove();
      warning?.remove();
      footer?.remove();
      nextPage();
      tbody.append(lastRow);
      if(warning) report.append(warning);
      if(footer) report.append(footer);
    }
    sheet.classList.add('last-page');
  }
  async function printReport(){
    if(document.fonts) await document.fonts.ready;
    paginateReport();
    document.documentElement.dataset.printReady = 'true';
    window.focus();
    window.print();
  }
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
