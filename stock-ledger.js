/* Shared read-only stock ledger used by the ERP and mobile admin.
 * Keep allocation, valuation, row identities and optional box counts here.
 * Inputs are snapshots; calculations never modify transactions or products.
 */
(function(root){
'use strict';
const STOCK_LOCATION_DEFAULT = '가공장';
function normProdDate(v){
  if(!v) return '';
  const s = String(v).trim().replace(/\//g,'-');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if(!m) return s;
  return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
}

function priceKey(value){
  return String(value ?? '').trim().replace(/\s+/g, '').toLowerCase();
}

function priceProductKey(value){
  let text = String(value ?? '').trim();
  text = text.replace(/\s+\d+(?:\.\d+)?\s*(?:kg|KG|㎏)\s*$/i, '');
  text = text.replace(/\s*\[[^\]]*\]\s*$/, '');
  text = text.replace(/\s*\(작업\)\s*$/i, '');
  return priceKey(text);
}

function samePriceText(a, b){
  return priceKey(a) === priceKey(b);
}

function samePriceProductText(a, b){
  return priceProductKey(a) === priceProductKey(b);
}

function normalizeOriginName(value){
  const compact = String(value ?? '').trim().replace(/\s+/g, '');
  const table = {
    '미국':'미국산', '미국산':'미국산', 'usa':'미국산', 'us':'미국산',
    '호주':'호주산', '호주산':'호주산',
    '국내':'국내산', '국산':'국내산', '한국':'국내산', '국내산':'국내산',
    '덴마크산':'덴마크', '독일산':'독일', '스페인산':'스페인',
    '오스트리아산':'오스트리아', '칠레산':'칠레'
  };
  return table[compact.toLowerCase()] || table[compact] || compact;
}

function originKey(value){
  return priceKey(normalizeOriginName(value));
}

function sameOriginText(a, b){
  return originKey(a) === originKey(b);
}

function normalizeStockLocation(value){
  return String(value || '').trim() || STOCK_LOCATION_DEFAULT;
}

function stockLocationKey(value){
  return priceKey(normalizeStockLocation(value));
}

function getTxnStockLocation(t){
  return normalizeStockLocation(t?.stockLocation || t?.location || '');
}

function parseAppNumber(value){
  if(typeof value === 'number') return Number.isFinite(value) ? value : 0;
  return Number(String(value ?? '').replace(/,/g, '').trim()) || 0;
}

function stockPriceKey(value){
  const n = parseAppNumber(value);
  return n ? String(Math.round(n)) : '0';
}

function stockDateKey(value){
  const s = normProdDate(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : String(value || '').trim();
}

function stockMapKey(product, lot, price, origin='', packunit='', proddate='', stockLocation='', stockRowId=''){
  if(stockRowId) return ['row', encodeURIComponent(String(stockRowId)), stockLocationKey(stockLocation)].join('|');
  return [
    String(product||'').trim(),
    String(packunit||'').trim(),
    String(lot||'').trim(),
    originKey(origin||''),
    stockPriceKey(price),
    stockDateKey(proddate || ''),
    stockLocationKey(stockLocation)
  ].join('|');
}

function sameStockIdentity(row, product, lot, origin='', packunit='', stockPrice='', proddate='', stockLocation=''){
  const packText = String(packunit || '').trim();
  const priceText = parseAppNumber(stockPrice);
  const prodDateText = stockDateKey(proddate || '');
  const locationText = stockLocation ? stockLocationKey(stockLocation) : '';
  return (samePriceText(row.product, product) || samePriceProductText(row.product, product)) &&
    (!packText || samePriceText(row.packunit || '', packText)) &&
    String(row.lot||'').trim() === String(lot||'').trim() &&
    (!origin || sameOriginText(row.origin, origin)) &&
    (!priceText || stockPriceKey(row.price) === stockPriceKey(priceText)) &&
    (!prodDateText || stockDateKey(row.proddate || '') === prodDateText) &&
    (!locationText || stockLocationKey(row.stockLocation || '') === locationText);
}

function getTxnUnitPrice(t){
  const price = parseAppNumber(t?.price);
  if(price > 0) return price;
  const notePrice = String(t?.note||'').match(/(?:단가|입고단가)\s*[:：]?\s*([\d,]+)/);
  if(notePrice) return parseAppNumber(notePrice[1]);
  const weight = parseAppNumber(t?.weight);
  const amount = parseAppNumber(t?.amount);
  return weight > 0 && amount > 0 ? Math.round(amount / weight) : 0;
}

function getStockTxnProddate(t){
  const explicit = t?.stockProddate || t?.sourceProddate || t?.proddate || '';
  if(explicit) return stockDateKey(explicit);
  return String(t?.type || '') === '생산입고' ? stockDateKey(t?.date || '') : '';
}

function stockLedgerDateKey(value){
  const date = normProdDate(String(value || '').trim().split(/[T ]/)[0]);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const parsed = new Date(date + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : '';
}

function parseOptionalBoxCount(value){
  if(value === null || value === undefined || String(value).trim() === '') return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : NaN;
}

function productionStockNote(row){
  let note = String(row?.note || row?.stockNote || '').trim();
  const legacy = productionLegacySamsung(row);
  [legacy?.vendorName, legacy?.spec].map(value=>String(value || '').trim()).filter(Boolean).forEach(value=>{
    if(!note.includes(value)) note = [note, value].filter(Boolean).join(' / ');
  });
  return note;
}

function productionLegacySamsung(row){
  if(row?.samsung && typeof row.samsung === 'object') return {...row.samsung};
  if(!row?.samsungVendorId && !row?.samsungProductRowId && !row?.samsungVendorName && !row?.samsungSpec) return null;
  return {
    vendorId:row.samsungVendorId || '', vendorName:row.samsungVendorName || '',
    productRowId:row.samsungProductRowId || '', productId:row.samsungProductId || '',
    productName:row.samsungProductName || '', spec:row.samsungSpec || ''
  };
}

function normalizeLabelProductTaxType(value){
  return String(value || '').trim() === '과세' ? '과세' : '면세';
}

function calculate(transactions, options={}){
  const userTransactions = transactions;
  const EXCEL_STOCK = options.openingStock || [];
  const labelProducts = options.products || [];
  const asOfDate = options.asOfDate || '';
  const cutoff = asOfDate ? stockLedgerDateKey(asOfDate) : '';
  if(asOfDate && !cutoff) throw new Error('올바른 재고 기준일을 선택해주세요.');
  if(cutoff && EXCEL_STOCK.length) throw new Error('기초재고의 기준일 정보가 없어 날짜별 재고를 계산할 수 없습니다.');
  const map={};
  // 박스수는 중량과 독립적인 장부다. 과거 미기록분을 0박스로 추정하지 않는다.
  const applyStockBoxes = (bucket, value, sign=1) => {
    const boxes = parseOptionalBoxCount(value);
    if(bucket.stockBoxes === null || boxes === null || Number.isNaN(boxes)){
      bucket.stockBoxes = null;
      return;
    }
    const next = bucket.stockBoxes + sign * boxes;
    bucket.stockBoxes = next >= 0 ? next : null;
  };

  // EXCEL_STOCK 기준값 (빈 배열이면 건너뜀)
  EXCEL_STOCK.forEach(s=>{
    const price = parseAppNumber(s.price);
    const proddate = stockDateKey(s.proddate || s.producedDate || '');
    const stockLocation = normalizeStockLocation(s.stockLocation || s.location || '');
    const key=stockMapKey(s.product, s.lot, price, s.origin, s.packunit || '', proddate, stockLocation, s.stockRowId || '');
    map[key]={
      product:s.product, packunit:s.packunit || '', lot:String(s.lot||''), origin:s.origin, proddate, stockLocation,
      stockRowId:s.stockRowId || '', stockNote:s.stockNote || '',
      total_in:Number(s.total_in)||0, total_use:Number(s.total_use)||0, total_out:Number(s.total_out)||0,
      total_adjust:Number(s.total_adjust)||0,
      stock:Number(s.stock)||0, stockBoxes:parseOptionalBoxCount(s.boxCount),
      total_in_amount:0, price,
      inbound_weight:0, inbound_amount:0, produced_weight:0, produced_amount:0, source:''
    };
  });

  const ensureBucket = (product, lot, origin, price, packunit='', proddate='', stockLocation='', stockRowId='') => {
    const stockProddate = stockDateKey(proddate || '');
    const loc = normalizeStockLocation(stockLocation);
    const key = stockMapKey(product, lot, price, origin, packunit, stockProddate, loc, stockRowId);
    if(!map[key]) map[key]={
      product, packunit:String(packunit||'').trim(), lot:String(lot||''), origin:normalizeOriginName(origin||''), stockLocation:loc,
      stockRowId:String(stockRowId || ''), stockNote:'',
      total_in:0, total_use:0, total_out:0, stock:0, stockBoxes:0, proddate:stockProddate,
      total_adjust:0,
      total_in_amount:0, price:parseAppNumber(price),
      inbound_weight:0, inbound_amount:0, produced_weight:0, produced_amount:0, source:''
    };
    if(map[key].total_adjust === undefined) map[key].total_adjust = 0;
    if(map[key].total_in_amount === undefined) map[key].total_in_amount = 0;
    if(map[key].price === undefined) map[key].price = parseAppNumber(price);
    if(map[key].inbound_weight === undefined) map[key].inbound_weight = 0;
    if(map[key].inbound_amount === undefined) map[key].inbound_amount = 0;
    if(map[key].produced_weight === undefined) map[key].produced_weight = 0;
    if(map[key].produced_amount === undefined) map[key].produced_amount = 0;
    if(map[key].source === undefined) map[key].source = '';
    if(!map[key].origin && origin) map[key].origin = normalizeOriginName(origin);
    if(!map[key].proddate && stockProddate) map[key].proddate = stockProddate;
    if(!map[key].stockLocation) map[key].stockLocation = loc;
    return map[key];
  };

  const applyBucketProductMeta = (bucket, row) => {
    if(!bucket || !row) return bucket;
    const note = typeof productionStockNote === 'function' ? productionStockNote({stockNote:row.stockNote, samsung:row.samsung, samsungVendorName:row.samsungVendorName, samsungSpec:row.samsungSpec}) : String(row.stockNote || '');
    if(row.type === '생산입고' && row.stockRowId) bucket.stockNote = note;
    else if(note && !bucket.stockNote.split(' / ').includes(note)) bucket.stockNote = [...new Set([bucket.stockNote, note].filter(Boolean))].join(' / ');
    const labelProductId = row.labelProductId || row.productId || '';
    if(labelProductId && !bucket.labelProductId) bucket.labelProductId = labelProductId;
    if(row.productCode && !bucket.productCode) bucket.productCode = row.productCode;
    if(row.brand && !bucket.brand) bucket.brand = row.brand;
    if(row.factoryNo && !bucket.factoryNo) bucket.factoryNo = row.factoryNo;
    if(row.nationalPartCode && !bucket.nationalPartCode) bucket.nationalPartCode = row.nationalPartCode;
    if(row.nationalPartName && !bucket.nationalPartName) bucket.nationalPartName = row.nationalPartName;
    if(row.taxType && !bucket.taxType) bucket.taxType = normalizeLabelProductTaxType(row.taxType);
    if(row.grade && !bucket.grade) bucket.grade = row.grade;
    return bucket;
  };

  const stockTxns = userTransactions
    .map((t, idx)=>({t, idx, date:cutoff ? stockLedgerDateKey(t.date) : ''}))
    .filter(x=>['입고','생산입고','출고','사용','재고조정','재고이동','박스기준'].includes(x.t.type))
    .filter(x=>!cutoff || (x.date && x.date <= cutoff))
    .sort((a,b)=>{
      const ad = cutoff ? a.date : String(a.t.date||'').replace(/\//g,'-');
      const bd = cutoff ? b.date : String(b.t.date||'').replace(/\//g,'-');
      const d = ad.localeCompare(bd);
      return d || (a.idx - b.idx);
    });

  stockTxns.forEach(({t})=>{
    const lot = String(t.lot||'');
    const product = String(t.product||'').trim();
    if(!product) return;
    const weight = parseAppNumber(t.weight);
    const unitPrice = getTxnUnitPrice(t);
    let packunit = String(t.packunit || '').trim();
    const stockProddate = getStockTxnProddate(t);
    const selectedStockPrice = parseAppNumber(t.stockUnitPrice || t.sourceStockPrice || t.stockPrice || 0);
    const stockLocation = getTxnStockLocation(t);
    // Untagged history stays in its original aggregate; never allocate it to new production rows.
    const stockRowId = String(t.stockRowId || '');
    const matchesRow = s => String(s.stockRowId || '') === stockRowId;

    if(t.type==='박스기준'){
      const baselineKey = stockMapKey(product, lot, unitPrice, t.origin, packunit, stockProddate, stockLocation, stockRowId);
      const bucket = map[baselineKey];
      if(bucket){
        const baseline = parseOptionalBoxCount(t.boxCountAfter);
        if(baseline !== null && !Number.isNaN(baseline)) bucket.stockBoxes = baseline;
      }
    } else if(t.type==='재고조정'){
      if(!packunit){
        const inferredPackunits = [...new Set(Object.values(map)
          .filter(s => sameStockIdentity(s, product, lot, t.origin, '', unitPrice, stockProddate, stockLocation))
          .map(s => String(s.packunit || '').trim())
          .filter(Boolean))];
        if(inferredPackunits.length === 1) packunit = inferredPackunits[0];
      }
      const bucket = ensureBucket(product, lot, t.origin, unitPrice, packunit, stockProddate, stockLocation, stockRowId);
      applyBucketProductMeta(bucket, t);
      bucket.total_adjust += weight;
      bucket.stock += weight;
      applyStockBoxes(bucket, t.boxCount, weight >= 0 ? 1 : -1);
      if(!bucket.source) bucket.source = '재고조정';
    } else if(t.type==='입고' || t.type==='생산입고'){
      const bucket = ensureBucket(product, lot, t.origin, unitPrice, packunit, stockProddate, stockLocation, stockRowId);
      applyBucketProductMeta(bucket, t);
      bucket.total_in += weight;
      bucket.stock += weight;
      applyStockBoxes(bucket, t.boxCount);
      if(unitPrice > 0 && weight > 0){
        bucket.total_in_amount += unitPrice * weight;
        bucket.price = Math.round(bucket.total_in_amount / bucket.total_in);
        if(t.type==='입고'){
          bucket.inbound_weight += weight;
          bucket.inbound_amount += unitPrice * weight;
        } else {
          bucket.produced_weight += weight;
          bucket.produced_amount += unitPrice * weight;
        }
      }
      if(t.type==='생산입고'){
        bucket.source = '생산입고';
        if(!bucket.proddate) bucket.proddate = stockProddate || t.proddate || t.date || '';
      } else if(!bucket.source) {
        bucket.source = '입고';
      }
    } else if(t.type==='재고이동'){
      const origin = normalizeOriginName(t.origin||'');
      const fromLocation = normalizeStockLocation(t.fromLocation || stockLocation);
      const toLocation = normalizeStockLocation(t.toLocation || '');
      const movePrice = selectedStockPrice || unitPrice;
      let remaining = weight;
      const movedBuckets = [];
      let candidates = Object.values(map)
        .filter(s=>matchesRow(s) && (stockRowId ? stockLocationKey(s.stockLocation) === stockLocationKey(fromLocation) : sameStockIdentity(s, product, lot, origin, packunit, movePrice, stockProddate, fromLocation)))
        .filter(s=>s.stock>0.01)
        .sort((a,b)=>String(a.proddate||'').localeCompare(String(b.proddate||'')) || (a.price||0)-(b.price||0));
      candidates.forEach(s=>{
        if(remaining <= 0) return;
        const moved = Math.min(remaining, Math.max(0, s.stock));
        s.total_adjust -= moved;
        s.stock -= moved;
        movedBuckets.push(s);
        remaining -= moved;
      });
      if(remaining > 0.01){
        const fallback = ensureBucket(product, lot, origin, movePrice, packunit, stockProddate, fromLocation, stockRowId);
        applyBucketProductMeta(fallback, t);
        fallback.total_adjust -= remaining;
        fallback.stock -= remaining;
        movedBuckets.push(fallback);
      }
      const moveBoxesKnown = movedBuckets.length === 1 && remaining <= 0.01 && movedBuckets[0].stockBoxes !== null && parseOptionalBoxCount(t.boxCount) !== null;
      movedBuckets.forEach(s=>{ if(moveBoxesKnown) applyStockBoxes(s, t.boxCount, -1); else s.stockBoxes = null; });
      const dest = ensureBucket(product, lot, origin, movePrice, packunit, stockProddate, toLocation, stockRowId);
      applyBucketProductMeta(dest, t);
      dest.total_adjust += weight;
      dest.stock += weight;
      if(moveBoxesKnown && movedBuckets[0].stockBoxes !== null) applyStockBoxes(dest, t.boxCount);
      else dest.stockBoxes = null;
      if(!dest.source) dest.source = '재고이동';
    } else {
      let remaining = weight;
      const usedBuckets = [];
      const origin = normalizeOriginName(t.origin||'');
      let candidates = Object.values(map).filter(s=>matchesRow(s) && (stockRowId ? stockLocationKey(s.stockLocation) === stockLocationKey(stockLocation) : sameStockIdentity(s, product, lot, origin, packunit, '', '', stockLocation)));
      candidates = candidates.filter(s=>s.stock>0.01);
      const preferredStockPrice = selectedStockPrice || (t.type==='사용' ? unitPrice : 0);
      if(stockProddate){
        const exactDate = candidates.filter(s=>stockDateKey(s.proddate || '') === stockProddate);
        if(exactDate.length) candidates = exactDate;
      }
      if(preferredStockPrice){
        const exact = candidates.filter(s=>stockPriceKey(s.price) === stockPriceKey(preferredStockPrice));
        if(exact.length) {
          const rest = candidates.filter(s=>stockPriceKey(s.price) !== stockPriceKey(preferredStockPrice))
            .sort((a,b)=>String(a.source||'').localeCompare(String(b.source||'')) || (a.price||0)-(b.price||0));
          candidates = [...exact, ...rest];
        } else {
          candidates = candidates.sort((a,b)=>String(a.source||'').localeCompare(String(b.source||'')) || (a.price||0)-(b.price||0));
        }
      } else {
        candidates = candidates.sort((a,b)=>String(a.source||'').localeCompare(String(b.source||'')) || (a.price||0)-(b.price||0));
      }
      candidates.forEach(s=>{
        if(remaining <= 0) return;
        const used = Math.min(remaining, Math.max(0, s.stock));
        if(t.type==='출고') s.total_out += used;
        else s.total_use += used;
        s.stock -= used;
        usedBuckets.push(s);
        remaining -= used;
      });
      if(remaining > 0.01){
        const fallback = ensureBucket(product, lot, origin, t.type==='사용' ? unitPrice : (selectedStockPrice || 0), packunit, stockProddate, stockLocation, stockRowId);
        applyBucketProductMeta(fallback, t);
        if(t.type==='출고') fallback.total_out += remaining;
        else fallback.total_use += remaining;
        fallback.stock -= remaining;
        usedBuckets.push(fallback);
      }
      if(usedBuckets.length === 1 && remaining <= 0.01) applyStockBoxes(usedBuckets[0], t.boxCount, -1);
      else usedBuckets.forEach(s=>{ s.stockBoxes = null; });
    }
  });
  const productionNotes = new Map();
  const inboundPrices = new Map();
  stockTxns.forEach(({t})=>{
    if(t.type === '생산입고' && t.stockRowId) productionNotes.set(String(t.stockRowId), String(t.stockNote || ''));
    if(t.type === '입고' && t.stockRowId) inboundPrices.set(String(t.stockRowId), getTxnUnitPrice(t));
  });
  Object.values(map).forEach(bucket=>{
    if(bucket.stockRowId && productionNotes.has(bucket.stockRowId)) bucket.stockNote = productionNotes.get(bucket.stockRowId);
    // 이동 당시 단가가 남아 있어도 현재 재고 평가는 정정한 입고원본 단가를 따른다.
    if(bucket.stockRowId && inboundPrices.has(bucket.stockRowId)) bucket.price = inboundPrices.get(bucket.stockRowId);
  });
  // 과거 재고행은 품목 스냅샷이 없을 수 있다. 영구 ID/제품코드 또는 유일하게
  // 식별되는 품목만 마스터와 연결해 브랜드·등급을 보완한다.
  Object.values(map).forEach(bucket=>{
    let managed = null;
    const managedId = bucket.labelProductId || bucket.productId || '';
    if(managedId) managed = labelProducts.find(p=>String(p.id||'')===String(managedId));
    if(!managed && bucket.productCode) managed = labelProducts.find(p=>String(p.productCode||'')===String(bucket.productCode));
    if(!managed){
      let candidates = labelProducts.filter(p=>samePriceText(p.name,bucket.product));
      if(bucket.origin) candidates = candidates.filter(p=>sameOriginText(p.origin,bucket.origin));
      if(bucket.packunit) candidates = candidates.filter(p=>samePriceText(p.packunit,bucket.packunit));
      if(bucket.brand) candidates = candidates.filter(p=>samePriceText(p.brand,bucket.brand));
      if(candidates.length===1) managed=candidates[0];
    }
    if(managed) applyBucketProductMeta(bucket,managed);
    if(bucket.brand===undefined) bucket.brand='';
    if(bucket.grade===undefined) bucket.grade='';
  });
  return map;
}

function rows(map){
  return Object.values(map).map(row=>({...row, stock:Math.abs(row.stock)<0.01 ? 0 : row.stock}));
}
function filterRows(items, {status='재고', query='', location=''}={}){
  const q = String(query).trim().toLowerCase();
  return items.filter(row=>{
    if(status==='재고' && !(row.stock>0.01 || row.stock<-0.01)) return false;
    if(status==='소진' && !(row.stock>=-0.01 && row.stock<=0.01)) return false;
    if(location && stockLocationKey(row.stockLocation)!==stockLocationKey(location)) return false;
    return !q || (row.stockLocation+row.product+(row.brand||'')+(row.grade||'')+(row.packunit||'')+row.lot+(row.proddate||'')+row.origin+String(row.price||'')+(row.stockNote||'')+(row.stockRowId||'')).toLowerCase().includes(q);
  });
}
function summarize(items){
  return {
    count:items.length,
    totalWeight:items.reduce((sum,row)=>sum+(Number(row.stock)||0),0),
    totalAmount:items.reduce((sum,row)=>sum+Math.round((Number(row.stock)||0)*(Number(row.price)||0)),0)
  };
}
root.DBMTStockLedger = Object.freeze({calculate, rows, filterRows, summarize});
})(globalThis);
