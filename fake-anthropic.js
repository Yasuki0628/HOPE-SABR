// テスト用の模擬 Anthropic API（実際のAIではありません）
const http = require('http');
let last = null;
http.createServer((req, res) => {
  if (req.url === '/__last') { res.end(JSON.stringify(last)); return; }
  let d = ''; req.on('data', c => d += c); req.on('end', () => {
    const b = JSON.parse(d || '{}');
    last = { headers: { key: req.headers['x-api-key'], ver: req.headers['anthropic-version'] }, body: b };
    if (req.headers['x-api-key'] !== 'sk-test') { res.writeHead(401); return res.end('{}'); }
    const sys = b.system || '', content = b.messages[0].content, hasImg = content.some(c => c.type === 'image');
    let text = '【模擬応答】' + (sys.includes('JSONだけ') ? '' : 'データに基づく参考コメントです。選手Aは安定しています。');
    if (sys.includes('JSONだけ')) text = '読み取り結果は次のとおりです\n{"rows":[{"inning":1,"batter":"山田","result":"単打","rbi":1},{"inning":2,"batter":"さとう","result":"三振","rbi":0},{"inning":3,"batter":"不明な人","result":"ホームラン?","rbi":9}]}';
    if (hasImg && !sys.includes('JSONだけ')) text += '（画像を受け取りました）';
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
  });
}).listen(+process.env.PORT || 8161);
