// DiamondLens service worker — アプリ本体をキャッシュしてオフラインで起動できるようにします。
// アプリを更新したら VERSION を変えると、利用者の端末のキャッシュが入れ替わります。
const VERSION = 'v22';
const CACHE = 'diamondlens-' + VERSION;
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './apple-touch-icon.png',
  './favicon.ico'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('diamondlens-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部サイトには介入しない

  // ページの移動は、まずキャッシュした index.html を返す（オフラインでも起動）。裏で最新版に更新する。
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then((cached) => {
        const net = fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put('./index.html', res.clone()));
          return res;
        }).catch(() => cached);
        return cached || net;
      })
    );
    return;
  }

  // それ以外（アイコンなど）はキャッシュ優先、なければネットから取得して保存。
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
      return res;
    }))
  );
});
