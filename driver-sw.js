const CACHE_NAME='dbmt-driver-attendance-v6-temperature';
const APP_FILES=['./driver-attendance.html','./driver-manifest.webmanifest','./driver-icon-192.png','./driver-icon-512.png','./temperature-record.js?v=20260908temp1','./driver-temperature.js?v=20260908temp1','./driver-temperature.css?v=20260908temp1'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_FILES)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('dbmt-driver-attendance-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith(fetch(event.request).then(response=>{
    const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(event.request,copy));return response;
  }).catch(()=>caches.match(event.request).then(cached=>cached||caches.match('./driver-attendance.html'))));
});
