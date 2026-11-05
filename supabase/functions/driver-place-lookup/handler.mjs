// Read-only enrichment of already-authorized attendance records. No arbitrary GPS proxy.
const ALLOWED_ORIGIN='https://dongbumt.github.io';
const MAX_DISTANCE=70;
const CACHE_LIMIT=500;
// Office-confirmed names. Each radius includes the site's recorded GPS positions.
const PLACE_OVERRIDES=[
  {name:'동부축산유통',latitude:37.4809862,longitude:126.6862894,radius:50},
  {name:'삼진1냉장',latitude:37.40162,longitude:127.2389188,radius:50},
  {name:'삼성웰스토리 평택센터',latitude:37.11853765,longitude:127.0242801,radius:100}
];
const clean=value=>String(value??'').trim();
const coord=value=>value===null||value===undefined||value===''?NaN:Number(value);
const provinces={'서울특별시':'서울','부산광역시':'부산','대구광역시':'대구','인천광역시':'인천','광주광역시':'광주','대전광역시':'대전','울산광역시':'울산','세종특별자치시':'세종','경기도':'경기','강원특별자치도':'강원','강원도':'강원','충청북도':'충북','충청남도':'충남','전북특별자치도':'전북','전라북도':'전북','전라남도':'전남','경상북도':'경북','경상남도':'경남','제주특별자치도':'제주'};
export function normalizeAddress(value){
  let address=clean(value);
  for(const [full,short] of Object.entries(provinces))if(address.startsWith(full+' ')){address=short+address.slice(full.length);break;}
  return address.replace(/\s+/g,'');
}
export function distanceMetres(lat1,lon1,lat2,lon2){
  const r=Math.PI/180,dlat=(lat2-lat1)*r,dlon=(lon2-lon1)*r;
  return 6371000*2*Math.asin(Math.sqrt(Math.min(1,Math.sin(dlat/2)**2+Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dlon/2)**2)));
}
export function fixedPlaceName(latitude,longitude){
  return PLACE_OVERRIDES.find(place=>distanceMetres(latitude,longitude,place.latitude,place.longitude)<=place.radius)?.name||'';
}
export function choosePlace(documents,address,latitude,longitude,random=Math.random){
  const addresses=new Set([address?.road_address?.address_name,address?.address?.address_name].map(normalizeAddress).filter(Boolean));
  const names=new Map();
  for(const item of documents||[]){
    const name=clean(item.place_name),lat=coord(item.y),lon=coord(item.x);
    if(!name||name.length>120||!Number.isFinite(lat)||!Number.isFinite(lon))continue;
    if(![item.road_address_name,item.address_name].some(a=>addresses.has(normalizeAddress(a))))continue;
    const distance=distanceMetres(latitude,longitude,lat,lon);
    if(distance>MAX_DISTANCE)continue;
    const before=names.get(name);
    if(!before||before.distance>distance)names.set(name,{name,distance});
  }
  const matches=[...names.values()].sort((a,b)=>a.distance-b.distance);
  if(!matches.length)return '';
  if(matches.length===1)return matches[0].name;
  // The office requested any one business when the same address has multiple matches.
  // The lookup cache keeps this choice for subsequent requests at this location.
  return matches[Math.floor(random()*matches.length)].name;
}

export function createHandler({env,fetcher=fetch,now=Date.now,random=Math.random}){
  const cache=new Map(),pending=new Map();
  const headers=req=>({
    'Access-Control-Allow-Origin':req.headers.get('origin')||ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods':'POST, OPTIONS',
    'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin'
  });
  const respond=(req,status,value)=>new Response(JSON.stringify(value),{status,headers:headers(req)});
  async function jsonFetch(url,options,timeout=5000){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
    try{
      const response=await fetcher(url,{...options,signal:controller.signal});
      let data;try{data=await response.json();}catch{throw new Error('invalid_response');}
      return {response,data};
    }finally{clearTimeout(timer);}
  }
  async function kakao(path,params,key){
    const url=new URL('https://dapi.kakao.com'+path);
    for(const [name,value] of Object.entries(params))url.searchParams.set(name,String(value));
    const {response,data}=await jsonFetch(url,{headers:{Authorization:'KakaoAK '+key}});
    if(!response.ok)throw new Error(response.status===401||response.status===403?'provider_configuration':'provider_unavailable');
    return data;
  }
  async function lookup(row,prefix,key){
    const latitude=coord(row[prefix+'_latitude']),longitude=coord(row[prefix+'_longitude']),accuracy=coord(row[prefix+'_accuracy_m']);
    if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||latitude<33||latitude>39||longitude<124||longitude>132)return {placeName:''};
    const fixedName=fixedPlaceName(latitude,longitude);
    if(fixedName)return {placeName:fixedName};
    if(Number.isFinite(accuracy)&&accuracy>100)return {placeName:''};
    const locationKey=latitude.toFixed(6)+','+longitude.toFixed(6);
    const cached=cache.get(locationKey);
    if(cached&&cached.expires>now())return cached.value;
    if(pending.has(locationKey))return pending.get(locationKey);
    const task=(async()=>{
      const geocode=await kakao('/v2/local/geo/coord2address.json',{x:longitude,y:latitude},key);
      const address=geocode.documents?.[0];
      const query=clean(address?.road_address?.address_name||address?.address?.address_name);
      let placeName='';
      if(query){
        const places=await kakao('/v2/local/search/keyword.json',{query,x:longitude,y:latitude,radius:100,sort:'distance',size:15},key);
        placeName=choosePlace(places.documents,address,latitude,longitude,random);
      }
      const value={placeName};
      if(cache.size>=CACHE_LIMIT)cache.delete(cache.keys().next().value);
      cache.set(locationKey,{expires:now()+(placeName?86400000:3600000),value});
      return value;
    })();
    pending.set(locationKey,task);
    try{return await task;}finally{pending.delete(locationKey);}
  }
  return async req=>{
    const origin=req.headers.get('origin');
    if(origin&&origin!==ALLOWED_ORIGIN)return new Response('Forbidden',{status:403});
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers:headers(req)});
    if(req.method!=='POST')return respond(req,405,{ok:false,message:'지원하지 않는 요청입니다.'});
    let body;try{if(Number(req.headers.get('content-length'))>16384)throw Error();body=await req.json();}catch{return respond(req,400,{ok:false,message:'요청 형식을 확인해주세요.'});}
    const token=clean(body?.sessionToken),week=clean(body?.weekStart),ids=body?.attendanceIds;
    if(!token)return respond(req,401,{ok:false,message:'ERP 사용자 로그인이 필요합니다.'});
    if(!/^\d{4}-\d{2}-\d{2}$/.test(week)||!Number.isFinite(Date.parse(week+'T00:00:00Z'))||new Date(week+'T00:00:00Z').toISOString().slice(0,10)!==week
      ||!Array.isArray(ids)||ids.length>50||ids.some(id=>typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id)))return respond(req,400,{ok:false,message:'조회할 출퇴근 기록을 확인해주세요.'});
    try{
      const base=clean(env('SUPABASE_URL')),publicKey=clean(env('SUPABASE_ANON_KEY'));
      if(!base||!publicKey)throw Error('server_configuration');
      const {response,data}=await jsonFetch(base+'/rest/v1/rpc/dbmt_erp_driver_admin_data',{
        method:'POST',headers:{apikey:publicKey,Authorization:'Bearer '+publicKey,'Content-Type':'application/json'},
        body:JSON.stringify({p_token:token,p_week_start:week})
      },8000);
      // This existing RPC checks the current session and driver_attendance.view on every call.
      if(!response.ok)return respond(req,403,{ok:false,message:'배송기사 근태 조회 권한 또는 로그인 상태를 확인해주세요.'});
      if(!Array.isArray(data?.attendance))throw Error('invalid_response');
      const key=clean(env('KAKAO_REST_API_KEY'));
      if(!key)return respond(req,503,{ok:false,code:'configuration',message:'상호명 조회 연결 설정을 확인해주세요.'});
      const wanted=new Set(ids),rows=data.attendance.filter(row=>wanted.has(row.id));
      const jobs=rows.flatMap(row=>['start',...(row.end_at?['end']:[])].map(prefix=>({row,prefix})));
      const results=new Map(rows.map(row=>[row.id,{id:row.id}]));
      let next=0,unavailable=false,configuration=false;
      await Promise.all(Array.from({length:Math.min(3,jobs.length)},async()=>{
        while(next<jobs.length){
          const {row,prefix}=jobs[next++];
          try{results.get(row.id)[prefix]=await lookup(row,prefix,key);}
          catch(error){
            if(error?.message==='provider_configuration')configuration=true;
            unavailable=true;results.get(row.id)[prefix]={placeName:''};
          }
        }
      }));
      if(configuration)return respond(req,503,{ok:false,code:'configuration',message:'카카오맵 사용 설정과 API 키를 확인해주세요.'});
      return respond(req,200,{ok:true,items:[...results.values()],partial:unavailable});
    }catch{return respond(req,503,{ok:false,message:'상호명을 불러오지 못했습니다. 주소는 기존대로 표시합니다.'});}
  };
}
