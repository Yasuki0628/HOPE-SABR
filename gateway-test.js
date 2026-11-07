// 中継サーバーの単体テスト（模擬Anthropicを上流にして起動した状態で実行）
// 使い方: PORT=8161 node fake-anthropic.js & ANTHROPIC_API_KEY=sk-test ACCESS_TOKEN=tok123 ALLOW_ORIGIN=https://app.example UPSTREAM=http://localhost:8161 PORT=8787 RATE_PER_MIN=40 node ../gateway.js & node gateway-test.js
const G = 'http://localhost:8787', H = { 'Content-Type': 'application/json', Authorization: 'Bearer tok123' }; let f = 0;
const T = (n, ok, x) => { if (!ok) f++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + x)); };
const post = (b, h) => fetch(G + '/ai', { method: 'POST', headers: h || H, body: typeof b === 'string' ? b : JSON.stringify(b) });
(async () => {
  T('トークンなしは401', (await post({ task: 'practice' }, { 'Content-Type': 'application/json' })).status === 401);
  T('誤トークンは401', (await post({ task: 'practice' }, { ...H, Authorization: 'Bearer nope' })).status === 401);
  T('health', (await (await fetch(G + '/health', { headers: H })).json()).ok === true);
  T('未知のタスクは400', (await post({ task: 'hack' })).status === 400);
  T('不正JSONは400', (await post('{bad')).status === 400);
  T('画像の形式違いは400', (await post({ task: 'video', data: {}, images: [{ media_type: 'text/html', data: 'AAA' }] })).status === 400);
  T('画像5枚は400', (await post({ task: 'video', data: {}, images: Array(5).fill({ media_type: 'image/jpeg', data: 'AAA' }) })).status === 400);
  T('scorebookは画像必須', (await post({ task: 'scorebook', data: {} })).status === 400);
  T('大きすぎる本文は413', await post('{"task":"practice","data":"' + 'a'.repeat(7e6) + '"}').then(r => r.status === 413, () => true));
  const r = await post({ task: 'analysis_game', data: { facts: ['x'] } }); const j = await r.json();
  T('分析→text', r.status === 200 && /模擬/.test(j.text), JSON.stringify(j));
  const s = await post({ task: 'scorebook', data: {}, images: [{ media_type: 'image/png', data: 'AAAA' }] }); const sj = await s.json();
  T('scorebook→rows(JSON抽出)', s.status === 200 && Array.isArray(sj.rows) && sj.rows.length === 3, JSON.stringify(sj));
  const o = await fetch(G + '/health', { headers: { ...H, Origin: 'https://app.example' } }); T('CORS: 許可したオリジンのみ', o.headers.get('access-control-allow-origin') === 'https://app.example');
  const o2 = await fetch(G + '/health', { headers: { ...H, Origin: 'https://evil.example' } }); T('CORS: 他のオリジンには許可ヘッダなし', !o2.headers.get('access-control-allow-origin'));
  let c429 = 0; for (let i = 0; i < 50; i++) { const x = await post({ task: 'practice', data: {} }); if (x.status === 429) c429++; } T('回数制限(429)', c429 > 0);
  console.log('FAIL: ' + f); process.exit(f ? 1 : 0);
})();
