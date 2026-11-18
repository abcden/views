const CACHE = 'clips-studio-gta-vi-v8';
const ASSETS = ['./index.html', './manifest.webmanifest', './icon.svg?logo=original-v6'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener('fetch', event => {
  if (event.request.method!=='GET') return;
  const url=new URL(event.request.url);
  if (url.origin!==self.location.origin) return;
  // Cada medición es independiente: no llenar la caché con cientos de datos.json?t=...
  if (url.pathname.endsWith('/datos.json')) return;
  const navigation=event.request.mode==='navigate';
  const request=navigation?new Request(event.request,{cache:'no-store'}):event.request;
  event.respondWith(fetch(request).then(response=>{
    if (response.ok) { const copy=response.clone(); caches.open(CACHE).then(cache=>cache.put(event.request,copy)); }
    return response;
  }).catch(async()=>await caches.match(event.request)||(navigation?await caches.match('./index.html'):undefined)));
});
