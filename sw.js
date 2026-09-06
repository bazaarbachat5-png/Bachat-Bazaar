/* Bachat Bazaar Service Worker
   - App shell (index.html, manifest, icon) cache karta hai taaki dobara visit
     par jaldi khule aur internet na hone par bhi site khul jaaye.
   - Product/order data Firebase se live aata hai, isliye wo yahan cache nahi
     hota - sirf offline hone par ek simple "aap offline hain" screen dikhti hai
     agar cached page bhi na mile. */
const CACHE_NAME = 'bachat-bazaar-v1';
const APP_SHELL = ['./index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

const OFFLINE_HTML = `<!DOCTYPE html><html lang="hi"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Offline - Bachat Bazaar</title>
<style>
  body{font-family:Arial,sans-serif;background:#FAF6F0;color:#1B1F2A;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px;}
  .box{max-width:340px;}
  h2{color:#1F2A44;margin-bottom:8px;}
  p{color:#6B6F7A;font-size:14.5px;line-height:1.5;}
  button{margin-top:16px;background:#F2994A;color:#1B1F2A;border:none;padding:10px 20px;border-radius:9px;font-weight:600;font-size:14px;cursor:pointer;}
</style></head><body>
  <div class="box">
    <h2>Aap Abhi Offline Hain</h2>
    <p>Internet connection check karein aur dobara try karein. Pehle dekhe gaye pages phir bhi kaam kar sakte hain.</p>
    <button onclick="location.reload()">Dobara Try Karein</button>
  </div>
</body></html>`;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if(req.method !== 'GET') return;
  // Firebase/Firestore aur external CDN requests ko service worker touch nahi karta -
  // wo hamesha live network se hi jaayen taaki data hamesha taaza rahe.
  if(!req.url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(req).then((res) => {
      const resClone = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone)).catch(()=>{});
      return res;
    }).catch(() =>
      caches.match(req).then((cached) => {
        if(cached) return cached;
        if(req.mode === 'navigate') {
          return caches.match('./index.html').then(shell => shell || new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html' } }));
        }
        return new Response('', { status: 504 });
      })
    )
  );
});
