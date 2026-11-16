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
  // Phase 24-F：戦術の助言用の依頼の種類
  const hj = await (await fetch(G + '/health', { headers: H })).json();
  T('health：対応する依頼の種類に tactics が入る', Array.isArray(hj.tasks) && hj.tasks.includes('tactics') && hj.tasks.includes('analysis_game'), JSON.stringify(hj));
  const tc = await post({ task: 'tactics', data: { 知りたいこと: '攻撃戦術', 戦術別: [{ 戦術: '盗塁', 実行: 12, 成功: 9, 成功率: '75%' }] } }); const tj = await tc.json();
  T('tactics→text', tc.status === 200 && typeof tj.text === 'string' && tj.text.length > 0, JSON.stringify(tj));
  const lastReq = await (await fetch('http://localhost:8161/__last')).json();
  T('tactics：2つの見出し・数字を作らない指示・選手を比べない指示が上流に渡る', lastReq && lastReq.body && lastReq.body.max_tokens === 1200 && /【記録から言えること】/.test(lastReq.body.system) && /【推測・一般論】/.test(lastReq.body.system) && /自分で計算・推定した数字は書かないでください/.test(lastReq.body.system) && /選手どうしの比較はしない/.test(lastReq.body.system), JSON.stringify(lastReq && lastReq.body && lastReq.body.system).slice(0, 120));
  T('tactics：データはそのまま【データ】として渡る', lastReq && /【データ】/.test(JSON.stringify(lastReq.body.messages)) && /75%/.test(JSON.stringify(lastReq.body.messages)));
  T('tactics も画像は付けられない（4枚超は400）', (await post({ task: 'tactics', data: {}, images: Array(5).fill({ media_type: 'image/jpeg', data: 'AAA' }) })).status === 400);
  const o = await fetch(G + '/health', { headers: { ...H, Origin: 'https://app.example' } }); T('CORS: 許可したオリジンのみ', o.headers.get('access-control-allow-origin') === 'https://app.example');
  const o2 = await fetch(G + '/health', { headers: { ...H, Origin: 'https://evil.example' } }); T('CORS: 他のオリジンには許可ヘッダなし', !o2.headers.get('access-control-allow-origin'));
  let c429 = 0; for (let i = 0; i < 50; i++) { const x = await post({ task: 'practice', data: {} }); if (x.status === 429) c429++; } T('回数制限(429)', c429 > 0);
  console.log('FAIL: ' + f); process.exit(f ? 1 : 0);
})();
