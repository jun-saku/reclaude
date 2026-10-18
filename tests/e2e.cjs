// End-to-end check of the online games on the real Firebase SDK, the Firebase emulator and the real rules.
// Each browser context is a separate anonymous player. Firebase's CDN files are served from the npm
// package (same files, same version), so no internet access is needed.
// One file per game (or engine feature) in e2e/<name>.cjs; this file serves _site and runs them.
// Run: node scripts/build.mjs && cd tests && npm install && npm run e2e   (needs Java and Playwright with Chromium; the
// game server's tests also need `cd worker && npm ci`, and this file starts that server locally)
// Only some: E2E=wall-race,engine npm run e2e   (names are file names in e2e/; CI picks them from what a PR changed,
// see pick-e2e.mjs)
const { chromium } = (() => {
  for (const m of ['playwright', 'playwright-core']) { try { return require(m); } catch {} }
  return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
})();
const http = require('http');
const fs = require('fs'), path = require('path');
const FB = __dirname;
const SITE = path.join(__dirname, '..', '_site');
const FIXTURES = path.join(__dirname, 'fixtures');
const PORT = 8019;
const ALL = fs.readdirSync(path.join(__dirname, 'e2e')).filter((f) => f.endsWith('.cjs')).map((f) => f.slice(0, -4)).sort();
const ONLY = (process.env.E2E || '').split(',').map((s) => s.trim()).filter(Boolean);
const BASE = `http://localhost:${PORT}/reclaude/`;
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log((c ? 'ok   ' : 'FAIL ') + m); };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/reclaude/, '');
  if (p.endsWith('/')) p += 'index.html';
  // /__fixtures/<name>/ serves test-only pages from tests/fixtures/ (not published), next to the real site.
  const root = p.startsWith('/__fixtures/') ? FIXTURES : SITE;
  if (root === FIXTURES) p = p.slice('/__fixtures'.length);
  const base = root === FIXTURES && p.startsWith('/shared/') ? SITE : root; // fixtures use the built shared code
  const f = path.join(base, p);
  if (!f.startsWith(base) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
// The game server (worker/), run locally against the emulator, for the games that use it. It forgets an empty room's
// game after 4 seconds here (10 minutes when live), so the tests can check that too.
function startGameServer() {
  const dir = path.join(__dirname, '..', 'worker');
  if (!fs.existsSync(path.join(dir, 'node_modules', '.bin', 'wrangler'))) {
    console.log('(no game server: run `cd worker && npm ci` for the tests that need it)');
    return Promise.resolve(null);
  }
  const proc = require('child_process').spawn(path.join(dir, 'node_modules', '.bin', 'wrangler'),
    ['dev', '--var', 'EMULATOR:1', '--var', 'KEEP_MS:4000', '--port', '8787', '--ip', '127.0.0.1', '--log-level', 'warn'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write(`[game server] ${d}`));
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => http.get('http://127.0.0.1:8787/', () => resolve(proc)).on('error', () => {
      if (Date.now() - start > 60000) { console.log('(the game server did not start)'); resolve(proc); } else setTimeout(poll, 300);
    });
    poll();
  });
}
(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const gameServer = await startGameServer();
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined }); const out = process.env.SCREENSHOTS || require('os').tmpdir();
  const errs = [];
  const ctxs = [];
  const page = async (url) => {
    const ctx = await b.newContext({ viewport: { width: 390, height: 820 } }); ctxs.push(ctx); // own context = own anonymous user
    await ctx.route('https://www.gstatic.com/firebasejs/10.14.1/*', (r) => {
      const f = path.join(FB, 'node_modules/firebase', path.basename(new URL(r.request().url()).pathname));
      r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f) });
    });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto(url); return p;
  };
  const statusIs = (p, t) => p.waitForFunction((t) => document.getElementById('status').textContent === t, t, { timeout: 8000 }).then(() => true).catch(() => false);


  const unknown = ONLY.filter((n) => !ALL.includes(n));
  if (unknown.length) { console.error(`No test called ${unknown.join(', ')} in tests/e2e/ (have: ${ALL.join(', ')})`); process.exit(1); }
  for (const name of ONLY.length ? ONLY : ALL) {
    console.log(`\n== ${name}`);
    try { await require(`./e2e/${name}.cjs`)({ page, ok, statusIs, BASE, out }); }
    catch (err) { ok(false, `${name}: stopped with ${String(err && err.stack || err).split('\n').slice(0, 3).join(' ')}`); }
    for (const c of ctxs.splice(0)) await c.close().catch(() => {});
  }

  ok(errs.length === 0, 'no JavaScript errors ' + errs.join(' | '));
  console.log('\nFAILS:', fails);
  await b.close();
  server.close();
  if (gameServer) gameServer.kill();
  process.exit(fails ? 1 : 0);
})();
