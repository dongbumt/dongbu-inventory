/* 생산일보에 저장된 부자재 사용내역의 A4 인쇄 전용 화면. */
(function(root){
  'use strict';

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[char]);
  const number = value => {
    const result = Number(String(value ?? '').replace(/,/g, '').trim());
    return Number.isFinite(result) ? result : 0;
  };
  const formatQty = value => number(value).toLocaleString('ko-KR', {maximumFractionDigits:6});
  const cell = value => escapeHtml(String(value ?? '').trim() || '-');

  function hasUnsavedChanges(drafts, saved){
    const normalize = rows => rows
      .filter(row => row.itemId || row.lotId || String(row.qty ?? '').trim() || String(row.note || '').trim())
      .map(row => JSON.stringify([
        String(row.id || ''), String(row.itemId || ''), String(row.lotId || ''),
        number(row.qty), String(row.note || '').trim()
      ]))
      .sort();
    return JSON.stringify(normalize(drafts)) !== JSON.stringify(normalize(saved));
  }

  function buildDocument({companyName='주식회사 동부엠티', production={}, usages=[]}={}){
    const outputs = (Array.isArray(production.outputs) ? production.outputs : []).filter(row => row?.product);
    const unitTotals = new Map();
    usages.forEach(row => {
      const unit = String(row.unit || '').trim() || '단위 미입력';
      unitTotals.set(unit, (unitTotals.get(unit) || 0) + number(row.qty));
    });
    const outputRows = outputs.map((row, index) => `<tr>
      <td class="center">${index + 1}</td><td>${cell(row.product)}</td><td>${cell(row.packunit)}</td>
      <td class="lot">${cell(row.lot)}</td><td class="number">${formatQty(row.qty)}</td>
    </tr>`).join('');
    // 명칭·규격·LOT·단위는 현재 품목 마스터가 아닌 사용이력의 저장값을 인쇄한다.
    const usageRows = usages.map((row, index) => `<tr>
      <td class="center">${index + 1}</td>
      <td><strong>${cell(row.itemName)}</strong>${row.itemCode ? `<span class="subtext">${escapeHtml(row.itemCode)}</span>` : ''}</td>
      <td>${cell(row.itemSpec)}</td><td class="lot">${cell(row.lot)}</td>
      <td class="number">${formatQty(row.qty)}</td><td class="center">${cell(row.unit)}</td><td class="note">${cell(row.note)}</td>
    </tr>`).join('');
    const totalText = [...unitTotals].map(([unit, qty]) => `${formatQty(qty)} ${escapeHtml(unit)}`).join(' / ');

    return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>생산 부자재 사용내역서 · ${escapeHtml(production.date)} · 작업 ${escapeHtml(production.jobNo)}</title>
<style>
  @page { size:A4 portrait; margin:10mm; }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; }
  body { background:#e5e7eb; color:#111; font-family:"Malgun Gothic","맑은 고딕",Arial,sans-serif; }
  .toolbar { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:12px; padding:14px; font-size:14px; }
  .toolbar button { min-height:42px; padding:8px 20px; border:1px solid #777; border-radius:5px; background:#fff; color:#111; font:inherit; cursor:pointer; }
  .sheet { width:190mm; height:276mm; margin:0 auto 20px; background:#fff; }
  .report { width:100%; padding:1mm; font-size:10pt; line-height:1.4; transform-origin:top left; }
  header { border-bottom:2px solid #222; padding:2mm 0 4mm; text-align:center; }
  h1 { font-size:21pt; letter-spacing:1px; margin:0 0 2mm; }
  .company { font-size:11pt; }
  h2 { margin:5mm 0 2mm; font-size:12pt; }
  table { width:100%; border-collapse:collapse; table-layout:fixed; }
  th,td { border:1px solid #888; padding:2.1mm 1.6mm; vertical-align:middle; overflow-wrap:anywhere; }
  th { font-weight:700; text-align:center; background:#f2f2f2; }
  .metadata { margin-top:4mm; }
  .metadata th { width:17%; }
  .metadata td { width:33%; }
  .center { text-align:center; }
  .number { text-align:right; font-variant-numeric:tabular-nums; }
  .lot { font-variant-numeric:tabular-nums; }
  .note { white-space:pre-wrap; }
  .subtext { display:block; margin-top:1mm; font-size:.85em; color:#444; }
  .total { padding:2mm 0; text-align:right; font-weight:700; overflow-wrap:anywhere; }
  footer { margin-top:5mm; padding-top:2mm; border-top:1px solid #999; font-size:9pt; color:#444; }
  .report.compact { line-height:1.2; }
  .compact th,.compact td { padding:1mm 1.3mm; }
  .compact .subtext { display:inline; margin:0 0 0 1mm; }
  .compact h2 { margin:3mm 0 1.5mm; }
  @media print {
    html,body { width:190mm; background:#fff; }
    .toolbar { display:none; }
    .sheet { margin:0; }
    th { print-color-adjust:exact; -webkit-print-color-adjust:exact; }
    tr { break-inside:avoid; }
  }
</style></head><body>
<div class="toolbar"><span>A4 세로 · 1장 맞춤 (인쇄 설정의 머리글/바닥글은 꺼주세요)</span><button type="button" onclick="printReport()">🖨 출력</button><button type="button" onclick="window.close()">닫기</button></div>
<main class="sheet"><article class="report">
  <header><h1>생산 부자재 사용내역서</h1><div class="company">${escapeHtml(companyName)}</div></header>
  <table class="metadata" aria-label="생산 작업 정보"><tbody>
    <tr><th>생산일자</th><td>${cell(production.date)}</td><th>작업번호</th><td>${cell(production.jobNo)}</td></tr>
    <tr><th>작업구분</th><td>${cell(production.jobType || '생산')}</td><th>총 생산중량</th><td>${formatQty(outputs.reduce((sum, row) => sum + number(row.qty), 0))} KG</td></tr>
    ${production.note ? `<tr><th>생산 비고</th><td colspan="3" class="note">${escapeHtml(production.note)}</td></tr>` : ''}
  </tbody></table>
  <h2>1. 생산 내역</h2>
  <table aria-label="생산품 내역"><colgroup><col style="width:6%"><col style="width:34%"><col style="width:18%"><col style="width:26%"><col style="width:16%"></colgroup>
    <thead><tr><th>No.</th><th>생산품명</th><th>포장규격</th><th>생산 LOT / 이력번호</th><th>생산중량 (KG)</th></tr></thead>
    <tbody>${outputRows || '<tr><td colspan="5" class="center">등록된 생산품이 없습니다.</td></tr>'}</tbody>
  </table>
  <h2>2. 부자재 사용 내역</h2>
  <table aria-label="부자재 LOT별 사용 내역"><colgroup><col style="width:5%"><col style="width:23%"><col style="width:14%"><col style="width:22%"><col style="width:12%"><col style="width:7%"><col style="width:17%"></colgroup>
    <thead><tr><th>No.</th><th>부자재명 / 코드</th><th>규격</th><th>입고 LOT</th><th>사용수량</th><th>단위</th><th>비고</th></tr></thead>
    <tbody>${usageRows || '<tr><td colspan="7" class="center">저장된 부자재 사용내역이 없습니다.</td></tr>'}</tbody>
  </table>
  <div class="total">사용항목 ${usages.length}건${totalText ? ` · 단위별 합계: ${totalText}` : ''}</div>
  <footer>해당 생산일보에 저장된 부자재 사용내역입니다. 부자재별 입고 LOT와 사용수량을 확인해주세요.</footer>
</article></main>
<script>
  function fitOnePage(){
    const sheet = document.querySelector('.sheet');
    const report = document.querySelector('.report');
    function apply(scale){ report.style.zoom = scale; }
    report.classList.remove('compact');
    apply(1);
    const maxHeight = sheet.getBoundingClientRect().height - 2;
    // 먼저 행 간격을 줄여 글자를 최대한 크게 유지한 뒤, 필요한 경우만 축소한다.
    if(report.getBoundingClientRect().height > maxHeight) report.classList.add('compact');
    if(report.getBoundingClientRect().height > maxHeight){
      let low = 0.001, high = 1;
      for(let i = 0; i < 20; i++){
        const scale = (low + high) / 2;
        apply(scale);
        if(report.getBoundingClientRect().height <= maxHeight) low = scale;
        else high = scale;
      }
      apply(low);
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
    const popup = root.open('', '_blank', 'width=900,height=900');
    if(!popup) return false;
    popup.opener = null;
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    return true;
  }

  root.DBMTSubMaterialUsagePrint = {buildDocument, hasUnsavedChanges, open};
})(window);
