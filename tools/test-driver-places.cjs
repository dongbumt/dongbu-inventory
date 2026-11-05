// Isolated API/DOM fixtures. Never reads driver data or contacts a map provider.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'dbmt-driver-places-'));
const index=fs.readFileSync(path.join(root,'index.html'),'utf8');
const source=name=>{const match=index.match(new RegExp('function '+name+'\\([^]*?\\n\\}'));assert(match,name);return match[0];};
for(const script of index.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(script[1]);
const a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002';
const base={id:a,work_date:'2026-11-05',employee_name:'테스트 기사',start_at:'2026-11-04T22:49:00Z',start_latitude:37.5,start_longitude:127.1,start_accuracy_m:10,start_location_text:'경기도 광주시',start_location_name:'경기도 광주시',end_at:'2026-11-05T08:00:00Z',end_latitude:37.6,end_longitude:127.2,end_accuracy_m:10,end_location_text:'경기도 평택시',break_minutes:60,actual_minutes:480,recognized_minutes:480,bonus_minutes:0,status:'completed',updated_at:'2026-11-05T08:00:00Z'};
(async()=>{
 const {createHandler,choosePlace,normalizeAddress,fixedPlaceName}=await import(pathToFileURL(path.join(root,'supabase/functions/driver-place-lookup/handler.mjs')));
 const office={latitude:37.4809862,longitude:126.6862894};
 assert.equal(fixedPlaceName(office.latitude,office.longitude),'동부축산유통');
 assert.equal(fixedPlaceName(office.latitude+40/111195,office.longitude),'동부축산유통','Small GPS drift stays inside the office location');
 assert.equal(fixedPlaceName(office.latitude+70/111195,office.longitude),'','Nearby premises outside the office radius keep normal lookup');
 assert.equal(fixedPlaceName(37.5,127.1),'','Other places are not renamed');
 const address={road_address:{address_name:'경기도 광주시 테스트로 10'},address:{address_name:'경기 광주시 테스트동 100'}};
 const place={place_name:'가상 물류센터',road_address_name:'경기 광주시 테스트로 10',address_name:'',x:'127.1',y:'37.5'};
 assert.equal(normalizeAddress(address.road_address.address_name),normalizeAddress(place.road_address_name));
 assert.equal(choosePlace([place],address,37.5,127.1),'가상 물류센터');
 assert.equal(choosePlace([{...place,road_address_name:'경기 광주시 테스트로 11'}],address,37.5,127.1),'','Adjacent address is not the same business');
 assert.equal(choosePlace([{...place,x:'127.11'}],address,37.5,127.1),'','Distant business is excluded');
 const otherPlace={...place,place_name:'같은 건물의 다른 업체'};
 assert.equal(choosePlace([place,otherPlace],address,37.5,127.1,()=>0),place.place_name);
 assert.equal(choosePlace([place,otherPlace],address,37.5,127.1,()=>0.999999),otherPlace.place_name,'Any business at the same address can be selected');
 assert.equal(choosePlace([place,{...otherPlace,road_address_name:'경기 광주시 테스트로 11'},{...otherPlace,x:'127.11'}],address,37.5,127.1,()=>0.999999),place.place_name,'Random selection never includes an adjacent address or a distant business');
 let calls=[],denied=false,providerStatus=200,coordinates=structuredClone(base),key='qa-map-secret',randomCalls=0,clock=0;
 const env=name=>({SUPABASE_URL:'https://qa.test',SUPABASE_ANON_KEY:'qa-public',KAKAO_REST_API_KEY:key}[name]);
 const fetcher=async(url,options)=>{
  calls.push({url:String(url),options});
  if(String(url).startsWith('https://qa.test')){
   const body=JSON.parse(options.body);assert.equal(body.p_week_start,'2026-11-02');
   return Response.json(denied?{message:'권한 없음'}:{attendance:[coordinates]},{status:denied?400:200});
  }
  const parsed=new URL(url);assert.equal(parsed.searchParams.get('x'),String(coordinates.start_longitude));
  assert.equal(options.headers.Authorization,'KakaoAK qa-map-secret');
  if(providerStatus!==200)return Response.json({message:'secret '+key},{status:providerStatus});
  return Response.json(parsed.pathname.includes('coord2address')?{documents:[address]}:{documents:[place,otherPlace]});
 };
 const handler=createHandler({env,fetcher,now:()=>clock,random:()=>{randomCalls++;return randomCalls===1?0.999999:0;}});
 const request=(body={},headers={})=>new Request('https://edge.test',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({sessionToken:'qa-session',weekStart:'2026-11-02',attendanceIds:[a],...body})});
 coordinates.end_at=null;
 let response=await handler(request({latitude:0,longitude:0})),data=await response.json();
 assert.equal(response.status,200);assert.equal(data.items[0].start.placeName,otherPlace.place_name);
 assert.equal(calls.length,3);assert.equal(response.headers.get('Cache-Control'),'no-store');
 response=await handler(request());assert.equal((await response.json()).items[0].start.placeName,otherPlace.place_name);assert.equal(randomCalls,1,'Cached lookups keep the randomly chosen business');assert.equal(calls.length,4,'Cached names still require current ERP authorization');
 denied=true;response=await handler(request());assert.equal(response.status,403);assert.equal(calls.length,5);denied=false;
 response=await handler(request({attendanceIds:[b]}));assert.deepEqual((await response.json()).items,[]);assert.equal(calls.length,6,'Unknown IDs never become an arbitrary GPS lookup');
 response=await handler(request({}, {Origin:'https://unrelated.test'}));assert.equal(response.status,403);assert.equal(calls.length,6);
 response=await handler(request({sessionToken:''}));assert.equal(response.status,401);
 response=await handler(request({weekStart:'2026-02-30'}));assert.equal(response.status,400);
 response=await handler(request({attendanceIds:Array(51).fill(a)}));assert.equal(response.status,400);
 key='';response=await handler(request());assert.equal(response.status,503);assert.equal((await response.json()).code,'configuration');key='qa-map-secret';
 coordinates={...coordinates,start_accuracy_m:200};let before=calls.length;
 response=await handler(request());assert.equal((await response.json()).items[0].start.placeName,'');assert.equal(calls.length,before+1,'Poor GPS accuracy does not label nearby premises');
 coordinates={...coordinates,start_accuracy_m:10,start_longitude:127.100001};providerStatus=403;
 response=await handler(request());assert.equal(response.status,503);assert.equal((await response.json()).code,'configuration');
 providerStatus=500;response=await handler(request());data=await response.json();assert(data.partial);assert.equal(data.items[0].start.placeName,'');assert(!JSON.stringify(data).includes(key));
 providerStatus=200;coordinates={...coordinates,start_longitude:base.start_longitude};clock=86400001;
 response=await handler(request());assert.equal((await response.json()).items[0].start.placeName,place.place_name);assert.equal(randomCalls,2,'After the location cache expires, a new business may be chosen');
 coordinates={...coordinates,start_latitude:office.latitude,start_longitude:office.longitude,start_accuracy_m:200};providerStatus=403;before=calls.length;
 response=await handler(request());assert.equal(response.status,200);assert.equal((await response.json()).items[0].start.placeName,'동부축산유통');assert.equal(calls.length,before+1,'The fixed office name takes precedence without querying Kakao');
 denied=true;response=await handler(request());assert.equal(response.status,403,'Fixed office locations still require attendance-view permission');denied=false;
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:600}}),page=await context.newPage(),errors=[],requests=[];
  let waitResolve=null,hold=false,fail=false;
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://qa.test/**',async route=>{
   const body=route.request().postDataJSON();requests.push(body);
   if(hold)await new Promise(resolve=>waitResolve=resolve);
   await route.fulfill({status:fail?503:200,contentType:'application/json',body:JSON.stringify(fail?{ok:false}:{ok:true,items:body.attendanceIds.map(id=>({id,start:{placeName:'가상 물류센터'},end:{placeName:'<가상 축산유통>'}}))})});
  });
  const css=fs.readFileSync(path.join(root,'styles/main.css'),'utf8');
  await page.setContent(`<style>${css}</style><div class="card"><div class="card-title">주간 출퇴근 기록</div><input id="da-week-start" type="date" value="2026-11-02"><table><thead><tr>${['근무일','기사명','출근시각','출근위치','퇴근시각','퇴근위치','휴게','실제근로','인천가산','인정근로','상태','관리'].map(s=>'<th>'+s+'</th>').join('')}</tr></thead><tbody id="da-attendance-body"></tbody></table><span id="da-place-status"></span><a id="da-place-attribution" hidden>상호 정보: 카카오맵</a></div>`);
  await page.addScriptTag({content:`
   const SUPABASE_URL='https://qa.test',SUPABASE_PUBLISHABLE_KEY='qa-public';
   let qaToken='qa-session',allowed=true;window.DBMTAuth={getSessionToken:()=>qaToken,can:()=>allowed};
   const driverAdminData={attendance:${JSON.stringify([base])}};
   function htmlEscape(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
   function jsArg(v){return JSON.stringify(v)};function driverMondayValue(){return '2026-11-02'};
   function driverDateTimeLabel(v){return v?'11.05 07:49':'-'};function driverMinutesLabel(v){return v+'분'};
   ${['driverMapLinkHtml','driverAttendanceLocationHtml','renderDriverAttendance'].map(source).join('\n')}
  `});
  await page.addScriptTag({path:path.join(root,'driver-place-label.js')});
  await page.evaluate(()=>renderDriverAttendance());await page.waitForFunction(()=>document.getElementById('da-attendance-body').textContent.includes('물류센터'));
  assert.match(await page.locator('[data-driver-place=start]').textContent(),/^경기도 광주시 \(가상 물류센터\)$/);
  assert.equal(await page.locator('[data-driver-place=end]').textContent(),'경기도 평택시 (<가상 축산유통>)');
  assert.equal(await page.locator('#da-attendance-body img').count(),0,'Map names are untrusted text, never HTML');
  assert.equal(await page.locator('#da-attendance-body a').count(),2,'Existing map links stay available');
  const original=await page.evaluate(()=>JSON.stringify(driverAdminData));
  await page.evaluate(()=>renderDriverAttendance());assert.equal(requests.length,1,'Rerender uses session cache');
  assert.equal(await page.evaluate(()=>JSON.stringify(driverAdminData)),original,'Display enrichment never edits attendance/payroll data');
  await page.screenshot({path:path.join(artifacts,'attendance-place-names.png')});
  hold=true;await page.evaluate(()=>{driverAdminData.attendance[0].updated_at='new';renderDriverAttendance()});
  await page.waitForFunction(()=>document.getElementById('da-place-status').textContent.includes('확인 중'));
  await page.evaluate(()=>{qaToken='another-user';allowed=false});hold=false;waitResolve();
  await page.waitForTimeout(30);assert.equal(await page.locator('[data-driver-place=start]').textContent(),'경기도 광주시','Old-user response cannot decorate a new session');
  fail=true;await page.evaluate(()=>{allowed=true;renderDriverAttendance()});await page.waitForFunction(()=>document.getElementById('da-place-status').textContent.includes('확인하지 못했습니다'));
  assert.equal(await page.locator('[data-driver-place=start]').textContent(),'경기도 광주시');
  await page.evaluate(()=>{driverAdminData.attendance=[];renderDriverAttendance()});assert.match(await page.locator('#da-attendance-body').textContent(),/기록이 없습니다/);
  assert(await page.locator('#da-place-attribution').isHidden());assert.deepEqual(errors,[]);
  console.log('PASS: authorized-record-only lookup, CORS/session/range validation, private key protection, exact address/distance checks, fixed office name within 50 metres, random same-address selection with cache reuse/expiry, per-call auth, poor GPS/provider fallback, actual attendance renderer, safe parentheses/XSS handling, stale-session isolation and unchanged payroll/GPS fields.');
  console.log('Artifacts: '+artifacts);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
