// Real-time lag check: two Tanks players on the emulator through a proxy that delays every byte to and from the
// database by DELAY ms each way (default 150, a slow phone connection). Measures how far the second player's view
// of the host's tank and the enemies trails where they really are, and how many updates a second get through.
// Fails if updates drop below 5 a second or the typical error grows past a quarter of a tile (2 units).
// Run: node scripts/build.mjs && cd tests && npm run lag   (DELAY=60 npm run lag for another delay; not run in CI)
const path = require('path'), fs = require('fs'), http = require('http'), net = require('net');
const TESTS = __dirname, SITE = path.join(__dirname, '..', '_site');
const { chromium } = (() => {
  for (const m of ['playwright', 'playwright-core']) { try { return require(m); } catch {} }
  return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
})();
const DELAY = Number(process.env.DELAY ?? 150);
const proxy = net.createServer((c) => {
  const s = net.connect(9002, '127.0.0.1');
  const pipe = (a, b) => a.on('data', (d) => setTimeout(() => b.write(d), DELAY));
  pipe(c, s); pipe(s, c);
  c.on('error', () => {}); s.on('error', () => {}); c.on('close', () => s.destroy()); s.on('close', () => c.destroy());
}).listen(9000, '127.0.0.1');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(SITE, p); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(8021);
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = async () => {
    const ctx = await b.newContext({ viewport: { width: 390, height: 820 } });
    await ctx.route('https://www.gstatic.com/firebasejs/10.14.1/*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(TESTS, 'node_modules/firebase', path.basename(new URL(r.request().url()).pathname))) }));
    const p = await ctx.newPage(); p.on('pageerror', (e) => console.log('ERR', e.message)); await p.goto('http://localhost:8021/tanks/?backend=emulator'); return p;
  };
  const H = await page(); await H.click('#create'); await H.waitForSelector('#waiting:not([hidden])', { timeout: 20000 });
  const code = (await H.textContent('#waiting-code')).trim();
  const P = await page(); await P.fill('#join-code', code); await P.click('#join'); await P.waitForSelector('#waiting:not([hidden])', { timeout: 20000 });
  await H.waitForFunction(() => !document.getElementById('start-btn').disabled); await H.click('#start-btn');
  await P.waitForFunction(() => window.__tanks.room?.status === 'playing', null, { timeout: 20000 });
  await H.waitForFunction(() => window.__tanks.lead, null, { timeout: 20000 });
  await P.waitForTimeout(4000);
  // Both pages record positions every frame against the same wall clock, plus when the host's slot arrives on P.
  const rec = () => {
    window.__rec = []; let lastT = null; window.__arr = [];
    const loop = () => {
      const t = window.__tanks; if (!t.me) return;
      const o = t.others[0];
      if (o && o.t !== lastT) { lastT = o.t; window.__arr.push(Date.now()); }
      window.__rec.push({ at: Date.now(), me: { x: t.me.x, y: t.me.y }, host: o ? { x: o.x, y: o.y } : null, en: t.enemies.map((e) => ({ id: e.id, x: e.x, y: e.y })) });
      requestAnimationFrame(loop);
    };
    loop();
  };
  await H.evaluate(rec); await P.evaluate(rec);
  // The host drives: right, left, up, down, 1 s each, twice.
  for (const d of [1, 3, 0, 2, 1, 3, 0, 2]) { await H.evaluate((d) => window.__tanks.hold(d), d); await H.waitForTimeout(1000); }
  await H.evaluate(() => window.__tanks.hold(null)); await H.waitForTimeout(500);
  const hr = await H.evaluate(() => window.__rec), pr = await P.evaluate(() => window.__rec), arr = await P.evaluate(() => window.__arr);
  // Error: for each P frame, the host's true position at that wall time (nearest H frame).
  let hi = 0; const errs = [], eErrs = [];
  for (const f of pr) {
    while (hi < hr.length - 1 && hr[hi + 1].at <= f.at) hi++;
    const h = hr[hi];
    if (f.host) errs.push(Math.hypot(f.host.x - h.me.x, f.host.y - h.me.y));
    for (const e of f.en) { const he = h.en.find((x) => x.id === e.id); if (he) eErrs.push(Math.hypot(e.x - he.x, e.y - he.y)); }
  }
  const st = (a) => { a = a.slice().sort((x, y) => x - y); return `mean ${(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2)} p50 ${a[a.length >> 1]?.toFixed(2)} p90 ${a[Math.floor(a.length * 0.9)]?.toFixed(2)} max ${a[a.length - 1]?.toFixed(2)} units (n=${a.length})`; };
  const gaps = arr.slice(1).map((v, i) => v - arr[i]);
  console.log(`DELAY ${DELAY} ms each way`);
  console.log('host tank error on P:', st(errs));
  console.log('enemy error on P:   ', st(eErrs));
  console.log('host updates reaching P: ', (arr.length / ((arr[arr.length - 1] - arr[0]) / 1000)).toFixed(1), '/s, gaps', st(gaps).replace(/units/, 'ms'));
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const rate = arr.length / ((arr[arr.length - 1] - arr[0]) / 1000);
  const bad = [rate < 5 && `only ${rate.toFixed(1)} updates a second`, med(errs) > 2 && 'the host tank trails', med(eErrs) > 2 && 'enemies trail'].filter(Boolean);
  console.log(bad.length ? `FAIL ${bad.join(', ')}` : 'ok   other tanks keep up');
  await b.close(); server.close(); proxy.close(); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
