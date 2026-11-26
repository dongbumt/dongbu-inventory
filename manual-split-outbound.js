(function(global){
  'use strict';
  const locationOf = value => String(value || '').trim() || '가공장';
  const keyOf = (stockRowId, location) => JSON.stringify([stockRowId, locationOf(location)]);
  const cents = value => Math.round(Number(value) * 100);
  const kg = value => (value / 100).toFixed(2) + 'kg';
  let reviewing = false;

  function makeSelection(dialog, reviews){
    const list = dialog.querySelector('[data-split-outbound-list]');
    const status = dialog.querySelector('[data-split-outbound-status]');
    const submit = dialog.querySelector('[data-split-outbound-submit]');
    list.replaceChildren();
    const selectedBySource = new Map();
    for(const review of reviews){
      if(!selectedBySource.has(review.key)) selectedBySource.set(review.key, []);
      selectedBySource.get(review.key).push(review);
      const section = document.createElement('fieldset');
      section.style.cssText = 'min-width:0;margin:0 0 10px;padding:10px;border:1px solid var(--border);border-radius:6px';
      const legend = document.createElement('legend');
      legend.style.cssText = 'font-weight:700;padding:0 4px;overflow-wrap:anywhere';
      legend.textContent = `${review.row.product} · ${review.row.lot || '-'} · ${review.source.location}`;
      const info = document.createElement('p');
      const available = Math.max(0,cents(review.source.quantity)-cents(review.source.heldWeight));
      info.textContent = `${review.row.trader ? review.row.trader + ' · ' : ''}출고 ${kg(cents(review.row.weight))} · 바코드 미연결 ${kg(available)}`;
      info.style.cssText = 'margin:0 0 6px;font-size:12px;color:#555';
      section.append(legend, info);
      review.boxes = review.source.packages.map(pack => {
        const label = document.createElement('label');
        label.style.cssText = 'display:flex;gap:8px;align-items:center;min-height:32px;font-size:13px;overflow-wrap:anywhere';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.style.cssText = 'margin:0;width:16px;height:16px;flex:0 0 16px';
        const description = document.createElement('span');
        description.textContent = `${pack.barcode} · ${kg(cents(pack.weight))}`;
        label.append(input, description);
        section.append(label);
        return {input, pack};
      });
      list.append(section);
    }

    for(const group of selectedBySource.values()){
      if(group.length !== 1) continue;
      const [review] = group;
      const splitWeight = review.boxes.reduce((sum, box) => sum + cents(box.pack.weight), 0);
      if(cents(review.row.weight) === cents(review.source.quantity) && splitWeight === cents(review.source.heldWeight)
        && (review.row.boxCount == null || Number(review.row.boxCount) >= review.boxes.length)){
        for(const box of review.boxes) box.input.checked = true;
      }
    }

    function check(){
      let issue = '';
      const selections = [];
      for(const group of selectedBySource.values()){
        const usedBarcodes = new Set();
        let manualWeight = 0;
        for(const review of group){
          const chosen = review.boxes.filter(box => box.input.checked).map(box => box.pack);
          const rest = cents(review.row.weight) - chosen.reduce((sum, pack) => sum + cents(pack.weight), 0);
          if(rest < 0) issue ||= `${review.row.product}의 선택 박스 중량이 출고중량을 넘습니다.`;
          if(review.row.boxCount != null){
            const boxes = Number(review.row.boxCount);
            if(chosen.length > boxes || (chosen.length && rest === 0 && boxes !== chosen.length)){
              issue ||= `${review.row.product}의 입력 박스수와 선택한 박스수를 확인해주세요.`;
            }
          }
          for(const pack of chosen){
            if(usedBarcodes.has(pack.barcode)) issue ||= '같은 바코드는 한 출고 행에서만 선택할 수 있습니다.';
            usedBarcodes.add(pack.barcode);
          }
          manualWeight += rest;
          if(chosen.length) selections.push({row:review.row, labels:chosen.map(({barcode,revision}) => ({barcode,revision}))});
        }
        for(const review of group){
          for(const box of review.boxes) box.input.disabled = !box.input.checked && usedBarcodes.has(box.pack.barcode);
        }
        const {source,row} = group[0];
        const available = Math.max(0,cents(source.quantity)-cents(source.heldWeight));
        if(manualWeight > available) issue ||= `${row.product}의 바코드 미연결 재고는 ${kg(available)}입니다. 출고할 분할 박스를 선택해주세요.`;
      }
      status.textContent = issue;
      submit.disabled = Boolean(issue);
      return issue ? null : selections;
    }

    return new Promise((resolve,reject) => {
      const finish = selections => {
        dialog.removeEventListener('cancel', cancel);
        dialog.removeEventListener('close', closed);
        dialog.removeEventListener('click', click);
        list.removeEventListener('change', check);
        if(dialog.open) dialog.close();
        list.replaceChildren();
        resolve(selections);
      };
      const cancel = event => { event.preventDefault(); finish(null); };
      const closed = () => { if(!dialog.open) finish(null); };
      const click = event => {
        if(event.target.closest('[data-split-outbound-cancel]')) finish(null);
        if(event.target.closest('[data-split-outbound-submit]')){
          const selections = check();
          if(selections) finish(selections);
        }
      };
      try{ dialog.showModal(); }catch(error){ reject(error); return; }
      dialog.addEventListener('cancel',cancel);
      dialog.addEventListener('close',closed);
      dialog.addEventListener('click',click);
      list.addEventListener('change',check);
      check();
    });
  }

  async function prepare(rows, fetchStock){
    const outbound = rows.filter(row => row.type === '출고' && String(row.stockRowId || '').trim());
    if(!outbound.length) return true;
    if(reviewing) throw new Error('출고할 분할 박스를 확인 중입니다.');
    const sources = new Map(outbound.map(row => {
      const stockRowId = String(row.stockRowId).trim(), location = locationOf(row.stockLocation);
      return [keyOf(stockRowId,location), {stockRowId,location}];
    }));
    reviewing = true;
    try{
      const stock = await fetchStock([...sources.values()]);
      const bySource = new Map(stock.filter(source => source.packages?.length).map(source => [keyOf(source.stockRowId,source.location),source]));
      const reviews = outbound.flatMap(row => {
        const key = keyOf(String(row.stockRowId).trim(),row.stockLocation);
        const source = bySource.get(key);
        return source ? [{row,key,source}] : [];
      });
      if(!reviews.length) return true;
      const selections = await makeSelection(document.getElementById('manual-split-outbound-dialog'),reviews);
      if(!selections) return false;
      for(const {row,labels} of selections) row._manualSplitLabels = labels;
      return true;
    }finally{ reviewing = false; }
  }

  function applySavedRows(current, shipments, corrections){
    const replacements = new Map(shipments.map(({sourceId,rows}) => [String(sourceId),rows]));
    const componentIds = new Set(shipments.flatMap(({rows}) => rows.map(row => String(row.id))));
    const corrected = new Map(corrections.map(row => [String(row.id),row]));
    const result = current.flatMap(row => {
      const id = String(row.id);
      if(replacements.has(id)){
        const replacement = replacements.get(id);
        replacements.delete(id);
        return replacement;
      }
      return componentIds.has(id) ? [] : [corrected.get(id) || row];
    });
    return result.concat([...replacements.values()].flat());
  }

  global.DBMTManualSplitOutbound = {prepare,applySavedRows};
})(window);
