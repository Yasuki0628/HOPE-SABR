// HOPE Data Analysis AI中継サーバー（参考実装・依存なしの Node.js 18以上）
// APIキーはここ（環境変数）にだけ置きます。アプリやソースには入れません。
// 起動例: ANTHROPIC_API_KEY=sk-... ACCESS_TOKEN=長い合言葉 ALLOW_ORIGIN=https://あなたのアプリのURL node gateway.js
// 本番では必ず HTTPS（リバースプロキシ／クラウドの機能）の背後に置いてください。
const http = require('http'), crypto = require('crypto');
const PORT = +process.env.PORT || 8787;
const KEY = process.env.ANTHROPIC_API_KEY || '';
const TOKEN = process.env.ACCESS_TOKEN || '';
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const UPSTREAM = (process.env.UPSTREAM || 'https://api.anthropic.com').replace(/\/+$/, '');
const ORIGIN = process.env.ALLOW_ORIGIN || '';          // 空のときは CORS を許可しない
const MAXBODY = 6 * 1024 * 1024, RATE = +process.env.RATE_PER_MIN || 30;
if (!KEY) { console.error('ANTHROPIC_API_KEY が未設定です'); process.exit(1); }
if (!TOKEN) { console.error('ACCESS_TOKEN が未設定です（誰でも使えてしまうため必須）'); process.exit(1); }

const COMMON = 'あなたは学童野球チームの指導者を補助するアシスタントです。必ず日本語で、やさしく簡潔に答えます。' +
  '与えられたデータ（事実）だけを根拠にし、データにないことは推測しません。数値は与えられたものだけを使います。' +
  '選手名は「選手A」など仮名のまま扱い、実名・個人の特定・健康や性格の断定は行いません。子どもの自信を損なう表現は避け、前向きな助言にします。' +
  '最終判断は指導者が行うことを前提にし、断定を避けた参考情報として述べます。';
const TASKS = {
  analysis_game: { max: 700, sys: COMMON + '試合の打撃の事実をもとに、(1)この試合の特徴 (2)良かった点 (3)次の試合への課題 を、各2〜3文で述べてください。' },
  analysis_player: { max: 700, sys: COMMON + '選手の打撃の事実をもとに、(1)強み (2)伸びしろ (3)指導のポイント を、各2〜3文で述べてください。' },
  practice: { max: 800, sys: COMMON + '与えられた練習メニュー案と理由をもとに、練習の進め方（順序・声かけ・注意点）を補足してください。新しい数値は作らないでください。' },
  opponent: { max: 700, sys: COMMON + '対戦相手との成績の事実をもとに、(1)傾向 (2)試合での注意点 を述べてください。' },
  video: { max: 700, sys: COMMON + '添付された静止画（動画のコマ）と端末内の簡易計測値を見て、(1)見えること (2)気づいた点 (3)練習のヒント を述べてください。画像だけでは分からないことは「分からない」と述べ、断定しないでください。人物の特定はしないでください。' },
  scorebook: { max: 2500, json: true, sys: '画像は学童野球のスコアブックです。打席ごとの情報を読み取り、JSONだけを出力してください（説明文なし）。形式: {"rows":[{"inning":数字または0,"batter":"画像に書かれた打者名","result":"単打|二塁打|三塁打|本塁打|四球|死球|打撃妨害|守備妨害|三振|ゴロ|飛球|犠打|犠飛|失策|野選のいずれか。読めなければ空文字","rbi":数字}]}。読めない箇所は推測せず空にしてください。' },
};
const buckets = new Map();
const limited = ip => { const n = Date.now(), b = (buckets.get(ip) || []).filter(t => n - t < 60000); b.push(n); buckets.set(ip, b); return b.length > RATE; };
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const send = (res, code, obj, origin) => { const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }; if (ORIGIN && (origin === ORIGIN || ORIGIN === '*')) { h['Access-Control-Allow-Origin'] = ORIGIN; h['Vary'] = 'Origin'; } res.writeHead(code, h); res.end(JSON.stringify(obj)); };

http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  if (req.method === 'OPTIONS') { const h = { 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600' }; if (ORIGIN && (origin === ORIGIN || ORIGIN === '*')) h['Access-Control-Allow-Origin'] = ORIGIN; res.writeHead(204, h); return res.end(); }
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!eq(auth, TOKEN)) return send(res, 401, { error: 'unauthorized' }, origin);
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, model: MODEL }, origin);
  if (req.method !== 'POST' || req.url !== '/ai') return send(res, 404, { error: 'not found' }, origin);
  if (limited(req.socket.remoteAddress || '?')) return send(res, 429, { error: 'rate limit' }, origin);
  let size = 0; const ch = [];
  req.on('data', d => { size += d.length; if (size > MAXBODY) { send(res, 413, { error: 'too large' }, origin); req.destroy(); } else ch.push(d); });
  req.on('end', async () => {
    let b; try { b = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch (_) { return send(res, 400, { error: 'bad json' }, origin); }
    const T = TASKS[b && b.task]; if (!T) return send(res, 400, { error: 'unknown task' }, origin);
    const imgs = Array.isArray(b.images) ? b.images : [];
    if (imgs.length > 4 || imgs.some(i => !i || !/^image\/(jpeg|png)$/.test(i.media_type) || typeof i.data !== 'string' || i.data.length > 4.5e6)) return send(res, 400, { error: 'bad images' }, origin);
    if (b.task === 'scorebook' && imgs.length !== 1) return send(res, 400, { error: 'image required' }, origin);
    const text = '【データ】\n' + JSON.stringify(b.data || {}).slice(0, 20000);
    const content = imgs.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })).concat([{ type: 'text', text }]);
    try {
      const r = await fetch(UPSTREAM + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: MODEL, max_tokens: T.max, system: T.sys, messages: [{ role: 'user', content }] }), signal: AbortSignal.timeout(55000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return send(res, 502, { error: 'upstream ' + r.status }, origin);   // 上流の詳細は返さない
      const out = ((j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')).trim();
      if (!out) return send(res, 502, { error: 'empty' }, origin);
      if (T.json) { const m = out.match(/\{[\s\S]*\}/); let p = null; try { p = m && JSON.parse(m[0]); } catch (_) {} if (!p || !Array.isArray(p.rows)) return send(res, 502, { error: 'unreadable' }, origin); return send(res, 200, { rows: p.rows.slice(0, 60) }, origin); }
      send(res, 200, { text: out.slice(0, 4000) }, origin);
    } catch (e) { send(res, 504, { error: 'upstream failed' }, origin); }   // 内容（個人情報）はログに残さない
  });
}).listen(PORT, () => console.log('HOPE AI gateway listening on ' + PORT + ' (model ' + MODEL + ')'));
