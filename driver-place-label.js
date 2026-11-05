/* Optional, read-only place names for the office attendance table. */
(function(){
  'use strict';
  let generation=0,lastToken='',controller=null;
  const cache=new Map();
  const clean=value=>String(value??'').trim();
  function combined(address,place){
    address=clean(address);place=clean(place);
    if(!place||address===place||address.endsWith('('+place+')')||address.endsWith('（'+place+'）'))return address;
    return address+' ('+place+')';
  }
  function identity(row,prefix){return JSON.stringify([row.id,row.updated_at,row[prefix+'_latitude'],row[prefix+'_longitude'],row[prefix+'_accuracy_m']]);}
  function valid(row,prefix){return row[prefix+'_latitude']!=null&&row[prefix+'_longitude']!=null&&Number.isFinite(Number(row[prefix+'_latitude']))&&Number.isFinite(Number(row[prefix+'_longitude']));}
  function setHint(message){const el=document.getElementById('da-place-status');if(el)el.textContent=message;}
  function current(token,id){return id===generation&&typeof DBMTAuth==='object'&&DBMTAuth.getSessionToken()===token&&DBMTAuth.can('driver_attendance','view');}
  function decorate(rows,token,id){
    if(!current(token,id))return;
    const table=document.getElementById('da-attendance-body');
    for(const row of rows)for(const prefix of ['start','end']){
      const name=cache.get(identity(row,prefix));
      if(name===undefined)continue;
      for(const el of table?.querySelectorAll('[data-driver-place]')||[]){
        if(el.dataset.recordId===row.id&&el.dataset.driverPlace===prefix)el.textContent=combined(el.dataset.address,name);
      }
    }
    const attribution=document.getElementById('da-place-attribution');
    if(attribution)attribution.hidden=!rows.some(row=>['start','end'].some(prefix=>cache.get(identity(row,prefix))));
  }
  async function enrich(rows,week){
    const id=++generation;
    controller?.abort();controller=null;
    const token=typeof DBMTAuth==='object'?DBMTAuth.getSessionToken():'';
    if(token!==lastToken){cache.clear();lastToken=token;}
    if(!token||!DBMTAuth.can('driver_attendance','view')){setHint('');return;}
    decorate(rows,token,id);
    const pending=rows.filter(row=>['start',...(row.end_at?['end']:[])].some(prefix=>valid(row,prefix)&&!cache.has(identity(row,prefix))));
    if(!pending.length){setHint('');return;}
    controller=new AbortController();const requestController=controller,signal=requestController.signal;
    const timer=setTimeout(()=>requestController.abort(),30000);
    setHint('상호명 확인 중…');
    try{
      for(let offset=0;offset<pending.length;offset+=50){
        const batch=pending.slice(offset,offset+50);
        const response=await fetch(SUPABASE_URL+'/functions/v1/driver-place-lookup',{
          method:'POST',signal,headers:{apikey:SUPABASE_PUBLISHABLE_KEY,Authorization:'Bearer '+SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},
          body:JSON.stringify({sessionToken:token,weekStart:week,attendanceIds:batch.map(row=>row.id)})
        });
        const data=await response.json();
        if(!response.ok||data?.ok!==true||!Array.isArray(data.items))throw Error('lookup_failed');
        if(!current(token,id))return;
        const byId=new Map(batch.map(row=>[row.id,row]));
        for(const item of data.items){
          const row=byId.get(item.id);if(!row)continue;
          for(const prefix of ['start','end'])if(item[prefix]&&typeof item[prefix].placeName==='string'){
            const place=clean(item[prefix].placeName);
            if(place.length<=120)cache.set(identity(row,prefix),place);
          }
        }
        decorate(rows,token,id);
        setHint(data.partial?'일부 상호명을 확인하지 못했습니다. 주소는 기존대로 표시합니다.':'');
      }
    }catch(error){if(current(token,id))setHint('상호명을 확인하지 못했습니다. 주소는 기존대로 표시합니다.');}
    finally{clearTimeout(timer);if(id===generation)controller=null;}
  }
  window.DBMTDriverPlaces={enrich,combined};
})();
