// Smoke test for every page in _site, run in CI as part of the required build check. It needs no per-game code:
// it opens each project and the games page on a phone-sized screen and fails on JavaScript errors, blocked scripts
// (Content-Security-Policy), sideways scroll, a game missing from the games page or missing its "All games" link,
// or a same-device game that won't start. The network outside this machine is blocked, so it never touches Firebase.
// Run: node scripts/build.mjs && node tests/smoke.cjs   (needs Playwright, or playwright-core plus CHROMIUM_PATH)
const { chromium } = (() => {
  for (const m of ['playwright', 'playwright-core']) { try { return require(m); } catch {} }
  return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
})();
const http = require('http');
const fs = require('fs'), path = require('path');

const SITE = path.join(__dirname, '..', '_site');
const PORT = 8018;
const BASE = `http://localhost:${PORT}/`;
const NOT_GAMES = new Set(['calculator']); // projects that aren't listed on the games page and have no "All games" link
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'ok   ' : 'FAIL ') + m); };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(SITE, p);
  if (!f.startsWith(SITE) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  if (!fs.existsSync(SITE)) { console.error('Run node scripts/build.mjs first.'); process.exit(1); }
  const projects = fs.readdirSync(SITE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !['shared', 'games'].includes(e.name) && fs.existsSync(path.join(SITE, e.name, 'index.html')))
    .map((e) => e.name).sort();
  const games = projects.filter((n) => !NOT_GAMES.has(n));
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  async function open(name) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    // Only this machine: no Firebase, no CDNs. Blocked requests are expected and not counted as errors.
    await ctx.route('**/*', (r) => (new URL(r.request().url()).hostname === 'localhost' ? r.continue() : r.abort('blockedbyclient')));
    const page = await ctx.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(`error: ${e.message}`));
    page.on('console', (m) => {
      const t = m.text();
      if (/Content Security Policy/i.test(t)) problems.push(`blocked by the security policy: ${t.slice(0, 160)}`);
      else if (m.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT|Failed to load resource/.test(t)) problems.push(`console error: ${t.slice(0, 160)}`);
    });
    await page.goto(BASE + name + '/');
    await page.waitForTimeout(400);
    return { ctx, page, problems };
  }
  const wide = (page) => page.evaluate(() => document.documentElement.scrollWidth);

  // The games page: a card for every game, and every card leads to a real project.
  {
    const { ctx, page, problems } = await open('games');
    const links = await page.$$eval('a.game', (as) => as.map((a) => a.getAttribute('href')));
    const targets = links.map((h) => (h.match(/^\.\.\/([a-z0-9-]+)\/$/) || [])[1]);
    ok(targets.every((t) => t && projects.includes(t)), `games page: every card links to a project (${links.join(' ')})`);
    const missing = games.filter((g) => !targets.includes(g));
    ok(!missing.length, `games page: lists every game${missing.length ? ` (missing: ${missing.join(', ')}; add a card to site/games/index.html)` : ''}`);
    ok(!problems.length && (await wide(page)) <= 390, `games page: loads cleanly, no sideways scroll ${problems.join(' | ')}`);
    await ctx.close();
  }

  for (const name of projects) {
    const { ctx, page, problems } = await open(name);
    const policy = await page.evaluate(() => !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'));
    ok(policy && !problems.length, `${name}: loads with the security policy and no errors ${problems.join(' | ')}`);
    ok((await wide(page)) <= 390, `${name}: no sideways scroll at 390px (${await wide(page)}px)`);
    if (!NOT_GAMES.has(name)) {
      const home = await page.$eval('.home-link', (a) => a.getAttribute('href')).catch(() => null);
      ok(home === '../games/', `${name}: has the "‹ All games" link to ../games/`);
    }
    // Same-device play, where the game has it: it must start without errors.
    if (await page.isVisible('#local').catch(() => false)) {
      await page.click('#local');
      await page.waitForTimeout(400);
      ok(!problems.length && (await page.isHidden('#home').catch(() => true)), `${name}: a same-device game starts ${problems.join(' | ')}`);
    }
    await ctx.close();
  }

  console.log(`\n${projects.length} projects and the games page checked. FAILS: ${fails}`);
  await browser.close();
  server.close();
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
