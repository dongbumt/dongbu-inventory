/* Read-only reports. Production quantities come from their existing stock postings. */
(function(root){
'use strict';
const text=v=>String(v??'').trim();
const key=v=>text(v).replace(/\s+/g,' ').toLocaleLowerCase('ko-KR');
const number=v=>Number(String(v??'').replace(/,/g,''))||0;
const round=v=>Math.round((v+Number.EPSILON)*100)/100;
function date(v){const s=text(v).split(/[T ]/)[0].replace(/\//g,'-'),m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);if(!m)return '';const d=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`,parsed=new Date(d+'T00:00:00Z');return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===d?d:'';}
function boxes(v){if(v==null||text(v)==='')return null;const n=Number(v);return Number.isSafeInteger(n)&&n>=0?n:null;}
function amount(t){return t.amount!=null&&text(t.amount)!==''?number(t.amount):Math.round(number(t.price)*number(t.weight??t.qty));}
function origin(v){return key(v).replace(/^(미국|호주|국내|한국|국산)$/g,x=>({미국:'미국산',호주:'호주산',국내:'국내산',한국:'국내산',국산:'국내산'}[x]));}
function prepare(snapshot){
  const products=(Array.isArray(snapshot.products)?snapshot.products:[]).filter(p=>p&&p.id&&p.name);
  const partners=(Array.isArray(snapshot.partners)?snapshot.partners:[]).filter(p=>p&&p.id&&p.name);
  const ids=new Map(products.map(p=>[String(p.id),p])),names=new Map(),partnerNames=new Map(),sourceIds=new Map(),seen=new Set();
  products.forEach(p=>{const n=key(p.name);names.set(n,[...(names.get(n)||[]),p]);});
  partners.forEach(p=>[p.name,...(Array.isArray(p.aliases)?p.aliases:[])].forEach(n=>{const k=key(n);partnerNames.set(k,new Set([...(partnerNames.get(k)||[]),String(p.id)]));}));
  const transactions=(Array.isArray(snapshot.transactions)?snapshot.transactions:[]).filter(t=>{
    if(!t||t.deletedAt||t._deletedAt)return false;
    if(t.id){const id=String(t.id);if(seen.has(id))return false;seen.add(id);}return true;
  }).map((t,i)=>({...t,id:text(t.id)||'legacy-'+i,date:date(t.date),_order:i}));
  transactions.filter(t=>['입고','생산입고'].includes(t.type)&&t.stockRowId).forEach(t=>{
    const id=text(t.labelProductId||t.productId);if(id)sourceIds.set(text(t.stockRowId),new Set([...(sourceIds.get(text(t.stockRowId))||[]),id]));
  });
  return {products,partners,ids,names,partnerNames,sourceIds,transactions,
    production:new Map((snapshot.production||[]).map(p=>[String(p.id),p])),accounts:snapshot.accounts||[],entries:snapshot.entries||[]};
}
function productFor(row,ctx){
  let id=text(row.labelProductId||row.productId);
  if(id)return ctx.ids.get(id)||null;
  const source=ctx.sourceIds.get(text(row.stockRowId));
  if(source?.size===1)return ctx.ids.get([...source][0])||null;
  let candidates=ctx.names.get(key(row.product||row.name))||[];
  if(row.productCode){const byCode=candidates.filter(p=>text(p.productCode)===text(row.productCode));if(byCode.length===1)return byCode[0];}
  // Brand/origin identify the meat; a historical packing specification may have
  // changed on the one registered item. Use packing/grade to disambiguate IDs,
  // never to discard old 5KG postings merely because today's packing is blank.
  for(const field of ['brand','origin'])if(text(row[field])){
    const norm=field==='origin'?origin:key,exact=candidates.filter(p=>norm(p[field])===norm(row[field]));
    candidates=exact.length?exact:candidates.filter(p=>!text(p[field]));
  }
  for(const field of ['packunit','grade'])if(candidates.length>1&&text(row[field])){
    const exact=candidates.filter(p=>key(p[field])===key(row[field]));
    candidates=exact.length?exact:candidates.filter(p=>!text(p[field]));
  }
  return candidates.length===1?candidates[0]:null;
}
function partnerFor(row,ctx){const id=text(row.businessPartnerId);if(id)return ctx.partners.find(p=>String(p.id)===id)||null;const ids=ctx.partnerNames.get(key(row.trader));return ids?.size===1?ctx.partners.find(p=>String(p.id)===[...ids][0]):null;}
function chronological(a,b){return a.date.localeCompare(b.date)||(a.order??0)-(b.order??0)||String(a.id).localeCompare(String(b.id));}
function totals(rows){return rows.reduce((s,r)=>({weight:round(s.weight+r.weight),boxes:s.boxes==null||r.boxes==null?null:s.boxes+r.boxes,amount:s.amount+r.amount}),{weight:0,boxes:0,amount:0});}
function customer(ctx,{partnerId,from,to,mode='전체',ascending=true}){
  const party=ctx.partners.find(p=>String(p.id)===String(partnerId));
  if(!party)throw Error('등록된 거래처를 선택해주세요.');
  from=date(from);to=date(to);if(!from||!to||from>to)throw Error('조회기간을 확인해주세요.');
  const account=ctx.accounts.find(a=>String(a.partner_id)===String(partnerId));
  const configured=!!account&&date(account.opening_date)<=to;
  const start=configured?date(account.opening_date):'';
  const allowed=t=>mode==='전체'||(mode==='매입'&&['입고','지급'].includes(t))||(mode==='매출'&&['출고','수금'].includes(t));
  const business=ctx.transactions.filter(t=>t.date&&['입고','출고'].includes(t.type)&&!t._isProdUse&&!t._isProdOut&&!t._prodId&&partnerFor(t,ctx)?.id===party.id)
    .map(t=>({...t,raw:t,order:0,weight:number(t.weight),boxes:boxes(t.boxCount),amount:amount(t),price:number(t.price),name:t.product,
      brand:t.brand??productFor(t,ctx)?.brand??'',kind:t.type}));
  const settlements=ctx.entries.filter(e=>String(e.partner_id)===String(partnerId)&&!e.deleted_at).map(e=>({
    ...e,raw:e,date:date(e.date),order:1,kind:e.kind==='receipt'?'수금':'지급',name:e.kind==='receipt'?'매출대금 수금':'매입대금 지급',
    amount:number(e.amount),weight:null,boxes:null,price:null,financial:true
  }));
  const all=[...business,...settlements].filter(r=>r.date&&r.date<=to&&(!start||r.date>=start)&&allowed(r.kind)).sort(chronological);
  let balance=configured?(mode==='매입'?-number(account.opening_ap):mode==='매출'?number(account.opening_ar):number(account.opening_ar)-number(account.opening_ap)):0;
  const delta=r=>['출고','지급'].includes(r.kind)?r.amount:-r.amount;
  all.filter(r=>r.date<from).forEach(r=>{balance+=delta(r);});
  const opening=balance,rows=all.filter(r=>r.date>=from).map(r=>{balance+=delta(r);return {...r,balance};});
  const sums={입고:0,출고:0,수금:0,지급:0};rows.forEach(r=>{sums[r.kind]+=r.amount;});
  return {party,account,configured,opening,closing:balance,rows:ascending?rows:[...rows].reverse(),sums,qty:totals(rows.filter(r=>r.weight!=null)),
    notice:!configured?'기초잔액 미등록: 잔액은 등록된 거래 차액이며 실제 미수·미지급액과 다를 수 있습니다.':from<start?`기초일자 ${start} 이후 내역으로 계산합니다.`:''};
}
function movements(ctx){
  const rows=[];
  ctx.transactions.forEach(t=>{
    if(!t.date||t._pdaProvisional===true)return;
    const p=productFor(t,ctx),prod=ctx.production.get(text(t._prodId));
    const base={...t,raw:t,productId:p?.id||'',brand:t.brand??p?.brand??'',boxes:boxes(t.boxCount),weight:Math.abs(number(t.weight)),
      price:number(t.price),amount:Math.abs(amount(t)),location:text(t.stockLocation)||'가공장',order:t._order,
      name:prod?`${prod.job_type||'생산'} 작업 ${prod.job_no||''}`.trim():(t.trader||''),
      note:[t.stockNote,t.note,prod?.note].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(' / ')};
    if(t.type==='재고이동'){
      rows.push({...base,id:t.id+':from',kind:'이동출',direction:-1,location:t.fromLocation||base.location,name:t.toLocation?`${t.toLocation}로 이동`:'재고 이동'});
      rows.push({...base,id:t.id+':to',kind:'이동입',direction:1,location:t.toLocation||'가공장',name:`${t.fromLocation||base.location}에서 이동`});
    }else if(t.type==='박스기준')rows.push({...base,kind:'박스기준',direction:0,weight:0,boxes:null,amount:0,note:[base.note,`실사 ${t.boxCountAfter??'—'} BOX`].filter(Boolean).join(' / ')});
    else if(t.type==='재고조정')rows.push({...base,kind:number(t.weight)<0?'조정출':'조정입',direction:number(t.weight)<0?-1:1});
    else if(t.type==='사용'||t._isProdUse)rows.push({...base,kind:'생출',direction:-1});
    else if(t.type==='생산입고'||t._isProdOut)rows.push({...base,kind:'생입',direction:1});
    else if(['입고','출고'].includes(t.type))rows.push({...base,kind:t.type,direction:t.type==='입고'?1:-1,weight:number(t.weight),amount:amount(t)});
  });
  return rows.sort(chronological);
}
function stockBalance(ctx,p,cutoff,lot,events){
  const relevant=events.filter(r=>r.productId===p.id&&(!lot||text(r.lot)===lot)&&r.date<=cutoff);
  const weight=round(relevant.reduce((s,r)=>s+r.direction*r.weight,0));
  const calc=root.DBMTStockLedger;
  if(!calc)return {weight,boxes:null};
  const map=calc.calculate(ctx.transactions.filter(t=>t.date&&t.date<=cutoff),{products:ctx.products,openingStock:[]});
  const buckets=calc.rows(map).filter(r=>productFor(r,ctx)?.id===p.id&&(!lot||text(r.lot)===lot));
  const count=buckets.reduce((s,r)=>s==null||r.stockBoxes==null?null:s+r.stockBoxes,0);
  return {weight,boxes:count};
}
function product(ctx,{productId,from,to,lot='',ascending=true}){
  const p=ctx.ids.get(String(productId));if(!p)throw Error('등록된 상품을 선택해주세요.');
  from=date(from);to=date(to);if(!from||!to||from>to)throw Error('조회기간을 확인해주세요.');
  lot=text(lot);const all=movements(ctx),d=new Date(from+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-1);
  const opening=stockBalance(ctx,p,d.toISOString().slice(0,10),lot,all),closing=stockBalance(ctx,p,to,lot,all);
  const rows=all.filter(r=>r.productId===p.id&&(!lot||text(r.lot)===lot)&&r.date>=from&&r.date<=to);
  const lots=[...new Set(all.filter(r=>r.productId===p.id).map(r=>text(r.lot)).filter(Boolean))].sort();
  const ambiguous=ctx.transactions.filter(t=>t.date&&t.date<=to&&key(t.product)===key(p.name)&&!productFor(t,ctx)).length;
  return {product:p,opening,closing,lots,rows:ascending?rows:[...rows].reverse(),incoming:totals(rows.filter(r=>r.direction>0)),outgoing:totals(rows.filter(r=>r.direction<0)),
    notice:ambiguous?`품목 연결을 확정할 수 없는 과거 거래 ${ambiguous}건은 합산하지 않았습니다. 브랜드·원산지·포장단위를 확인해주세요.`:''};
}
const api=Object.freeze({prepare,productFor,partnerFor,customer,product,movements,date,boxes,amount});
root.DBMTLedgerModel=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
