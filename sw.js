// HOPE Data Analysis service worker — アプリ本体をキャッシュしてオフラインで起動できるようにします。
// アプリを更新したら VERSION を変えてください。利用者の端末では「更新できます」と表示され、
// 利用者が「更新する」を押すと（更新前バックアップを作成した後で）新しい版に切り替わります。
const VERSION = 'v67';
const CACHE = 'diamondlens-' + VERSION;
const CORE = ['./index.html'];
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

// 取得に失敗した資源があっても、本体（index.html）さえ保存できればインストールを成功とする。
// 本体が保存できなかったときは失敗させ、古い版がそのまま使われ続ける（壊れた版には切り替わらない）。
async function precache(cache, bust) {
  const failed = [];
  await Promise.all(ASSETS.map(async (u) => {
    try {
      const res = await fetch(new Request(u, { cache: bust ? 'reload' : 'default' }));
      if (!res || !res.ok) throw new Error('status ' + (res && res.status));
      await cache.put(u, res);
    } catch (err) { failed.push(u); }
  }));
  if (CORE.some((u) => failed.includes(u))) throw new Error('core asset failed: ' + failed.join(','));
  return failed;
}

// 自動では切り替えない（skipWaiting しない）。画面側が「更新する」で SKIP_WAITING を送ったときだけ切り替える。
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => precache(c, true)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('diamondlens-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  const d = e.data || {};
  const reply = (m) => { try { (e.ports && e.ports[0] ? e.ports[0] : e.source).postMessage(m); } catch (_) {} };
  if (d.type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (d.type === 'STATUS') {
    e.waitUntil((async () => {
      const o = { type: 'STATUS', version: VERSION, cache: CACHE, assets: [], keys: [] };
      try {
        o.keys = await caches.keys();
        const c = await caches.open(CACHE);
        for (const u of ASSETS) o.assets.push([u, !!(await c.match(u))]);
      } catch (err) { o.err = String(err && err.message || err); }
      reply(o);
    })());
    return;
  }
  if (d.type === 'REFRESH_CACHE') {
    // 現在の版のキャッシュを作り直す（キャッシュが壊れたときの復旧用）。データには触れない。
    e.waitUntil((async () => {
      try {
        const tmp = CACHE + '-new';
        await caches.delete(tmp);
        const c = await caches.open(tmp);
        const failed = await precache(c, true);
        // 作成に成功したときだけ入れ替える
        await caches.delete(CACHE);
        const n = await caches.open(CACHE);
        for (const r of await c.keys()) { await n.put(r, await c.match(r)); }
        await caches.delete(tmp);
        reply({ type: 'REFRESH_DONE', ok: true, failed });
      } catch (err) {
        reply({ type: 'REFRESH_DONE', ok: false, err: String(err && err.message || err) });
      }
    })());
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部サイトには介入しない

  // ページの移動：保存済みの index.html を返す（オフラインでも起動）。
  // 版の入れ替えは Service Worker の更新（VERSION）だけで行い、ここでは上書きしない（途中で版が混ざらない）。
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cached = (await caches.match('./index.html', { ignoreSearch: true })) || (await caches.match('./', { ignoreSearch: true }));
      if (cached) return cached;
      try { return await fetch(req); } catch (err) {
        return new Response('<meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:20px"><h3>オフラインで開けません</h3><p>この端末にはまだアプリが保存されていません。インターネットに接続して一度開いてください。記録したデータは端末に残っています。</p>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  // それ以外（アイコンなど）はキャッシュ優先、なければネットから取得して保存。
  e.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    } catch (err) { return new Response('', { status: 504 }); }
  })());
});
