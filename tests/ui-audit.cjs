// UI audit: opens every screen of every game (home, one-phone game, online lobby, online game; ?backend=fake) at
// 320 and 390 px wide in light and dark mode, and checks them against the design principles:
//   touch    buttons, inputs and other tap targets at least 44×44 px (inline text links excepted)
//   legible  text at least 12 px, with contrast at least 4.5:1 (3:1 for large text: 24 px, or 18.7 px bold)
//   fits     no sideways scroll, no text cut off inside its box
//   labelled buttons with no text (only an icon or emoji) have an aria-label
//   works    no JavaScript errors
//   consistent  the standard wording (.claude/skills/new-game/DESIGN.md): the title is the same in <title>, <h1> and
//            the games page card; the home screen's sections are online first (Play friends online, Join a room), then
//            Same phone, then Solo; Create room, Join, Share link, Copy code, Start game, Play here / Play solo, Leave
//            and Play again are worded the same in every game
// Run after the build: node tests/ui-audit.cjs [game…]   Prints every problem; exits 1 if there are any.
const { chromium } = (() => {
  for (const m of ['playwright', 'playwright-core']) { try { return require(m); } catch {} }
  return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
})();
const http = require('http'), fs = require('fs'), path = require('path');
const SITE = path.join(__dirname, '..', '_site');
const PORT = 8023;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(SITE, p);
  if (!f.startsWith(SITE) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
const ALL = fs.readdirSync(SITE).filter((d) => fs.existsSync(path.join(SITE, d, 'index.html')) && !['shared'].includes(d));
const ONLY = process.argv.slice(2);

// The games page's card titles, by folder.
const CARDS = {};
for (const m of fs.readFileSync(path.join(SITE, 'games', 'index.html'), 'utf8').matchAll(/href="\.\.\/([^/"]+)\/"[\s\S]*?<h2>([^<]+)<\/h2>/g)) CARDS[m[1]] = m[2];

// Runs in the page: the problems on the screen as it is now.
function audit({ card }) {
  const out = [];
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const label = (el) => (el.id ? `#${el.id}` : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : '')) + (el.textContent.trim() ? ` "${el.textContent.trim().slice(0, 24)}"` : '');
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) out.push(`fits: page scrolls sideways (${doc.scrollWidth}px wide)`);
  // Colours: the first opaque background up the tree.
  const rgb = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => {
    let layers = [];
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage !== 'none') return null; // a gradient or picture: can't tell
      const c = rgb(s.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 0.99) break; }
    }
    let base = { r: 255, g: 255, b: 255 };
    if (!layers.length || layers[layers.length - 1].a < 0.99) base = matchMedia('(prefers-color-scheme: dark)').matches ? { r: 0, g: 0, b: 0 } : base;
    for (const c of layers.reverse()) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) };
    return base;
  };
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el) || el.closest('svg, canvas, [aria-hidden="true"], dialog:not([open])')) continue;
    const s = getComputedStyle(el);
    const tag = el.tagName;
    const r = el.getBoundingClientRect();
    // Tap targets
    const tappable = tag === 'BUTTON' || tag === 'SELECT' || (tag === 'INPUT' && el.type !== 'hidden') || el.getAttribute('role') === 'button' || (tag === 'A' && s.display !== 'inline');
    if (tappable && !el.disabled && (r.width < 44 - 0.5 || r.height < 44 - 0.5) && !el.closest('[data-small-ok]')) out.push(`touch: ${label(el)} is ${Math.round(r.width)}×${Math.round(r.height)}`);
    if (tag === 'BUTTON' && !el.textContent.trim().match(/[A-Za-z0-9]/) && !el.getAttribute('aria-label') && !el.getAttribute('title')) out.push(`labelled: ${label(el)} has no name`);
    // Text: own text nodes only
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const size = parseFloat(s.fontSize), bold = Number(s.fontWeight) >= 700;
    if (size < 12 && !el.closest('[data-small-ok]')) out.push(`legible: ${label(el)} text is ${size}px`);
    if (el.scrollWidth > el.clientWidth + 2 && s.overflow !== 'visible' && s.textOverflow !== 'ellipsis') out.push(`fits: ${label(el)} text is cut off`);
    const fg = rgb(s.color), bg = bgOf(el);
    const words = /[A-Za-z0-9]/.test(el.textContent); // emoji draw in their own colours
    if (words && fg && bg && !(el.disabled || el.closest('button:disabled, [aria-disabled="true"]'))) {
      const f = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
      const L1 = lum(f), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const large = size >= 24 || (bold && size >= 18.66);
      const need = large ? 3 : 4.5;
      const key = `${label(el)}${ratio.toFixed(1)}`;
      if (ratio < need - 0.05 && !seen.has(key)) { seen.add(key); out.push(`legible: ${label(el)} contrast ${ratio.toFixed(2)} (needs ${need})`); }
    }
  }
  // Consistent: titles and the standard wording.
  const shown = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const h1 = document.querySelector('h1');
  if (h1) {
    const c = h1.cloneNode(true); c.querySelectorAll('svg, [aria-hidden="true"], button').forEach((e) => e.remove());
    const t = c.textContent.trim();
    if (t !== document.title.trim()) out.push(`consistent: <h1> "${t}" isn't the page <title> "${document.title}"`);
    if (card && t !== card) out.push(`consistent: <h1> "${t}" isn't the games page title "${card}"`);
  }
  const link = document.querySelector('.home-link');
  if (shown(link) && link.textContent.trim() !== '‹ All games') out.push(`consistent: the home link says "${link.textContent.trim()}", not "‹ All games"`);
  const WORDS = {
    create: /^Create room$/, join: /^Join$/, share: /^Share link$/, copy: /^(Copy code|Copied!?)$/, leave: /^Leave$/,
    'lobby-leave': /^Leave$/, rematch: /^Play again( \(.+\))?$/, local: /^(Play (here|solo)|Continue game)$/, 'local-many': /^Play here$/,
    solo: /^(Play solo|Continue game)$/, 'start-btn': /^(Start game|Start with \d+ players|Waiting for (friends|a friend)…)$/,
    start: /^(Start game|Start with \d+ players|Waiting for (friends|a friend)…)$/,
  };
  for (const [id, re] of Object.entries(WORDS)) {
    const el = document.getElementById(id);
    if (el && el.tagName === 'BUTTON' && shown(el) && !re.test(el.textContent.trim())) out.push(`consistent: #${id} says "${el.textContent.trim()}" (standard: ${re.source.replace(/[\^$\\]/g, '')})`);
  }
  const code = document.getElementById('join-code');
  if (shown(code) && code.placeholder !== 'CODE') out.push(`consistent: #join-code placeholder is "${code.placeholder}", not "CODE"`);
  const name = document.getElementById('my-name');
  if (shown(name) && name.placeholder !== "So friends know it's you") out.push(`consistent: #my-name placeholder is "${name.placeholder}"`);
  const home = document.getElementById('home');
  if (shown(home)) {
    const ORDER = ['Play friends online', 'Play a friend online', 'Join a room', 'Same phone', 'Solo'];
    const rank = (t) => (t === 'Play a friend online' ? 0 : ORDER.indexOf(t));
    let last = -1;
    for (const h of home.querySelectorAll('h2')) {
      if (!shown(h) || h.closest('dialog, [role="dialog"]')) continue;
      const t = h.textContent.trim(), r = rank(t);
      if (r < 0) out.push(`consistent: home section "${t}" isn't a standard one (${ORDER.join(', ')})`);
      else if (r < last) out.push(`consistent: home section "${t}" is out of order (online, Join a room, Same phone, Solo)`);
      else last = r;
    }
  }
  return out;
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const problems = {};
  const note = (game, screen, list) => { for (const p of list) { const k = `${game} · ${p}`; (problems[k] ||= new Set()).add(screen); } };
  for (const game of (ONLY.length ? ONLY : ALL)) {
    for (const scheme of ['light', 'dark']) for (const width of [320, 390]) {
      const ctx = await b.newContext({ viewport: { width, height: 760 }, colorScheme: scheme, hasTouch: true });
      await ctx.route('**/*', (r) => (new URL(r.request().url()).hostname === 'localhost' ? r.continue() : r.abort()));
      const errs = [];
      const open = async () => { const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); await p.goto(`http://localhost:${PORT}/${game}/?backend=fake`); await p.waitForTimeout(400); return p; };
      const tag = `${scheme} ${width}`;
      const p = await open();
      note(game, `home ${tag}`, await p.evaluate(audit, { card: CARDS[game] }));
      if (await p.isVisible('#local').catch(() => false)) {
        await p.click('#local'); await p.waitForTimeout(500);
        note(game, `one phone ${tag}`, await p.evaluate(audit, { card: CARDS[game] }));
        // A hand-over screen (one phone, hidden hands) hides the game; tap through it once.
        for (const sel of ['#reveal', '#show-hand', '#ready', '.cover button']) if (await p.isVisible(sel).catch(() => false)) { await p.click(sel).catch(() => {}); await p.waitForTimeout(300); note(game, `one phone (revealed) ${tag}`, await p.evaluate(audit, { card: CARDS[game] })); break; }
      }
      if (game !== 'tanks') {
        const h = await open();
        if (await h.isVisible('#create').catch(() => false)) {
          if (await h.isVisible('#my-name').catch(() => false)) await h.fill('#my-name', 'Jun');
          await h.click('#create'); await h.waitForTimeout(700);
          note(game, `lobby ${tag}`, await h.evaluate(audit, { card: CARDS[game] }));
          const code = ((await h.textContent('#waiting-code').catch(() => '')) || '').trim();
          if (code) {
            const q = await open();
            if (await q.isVisible('#my-name').catch(() => false)) await q.fill('#my-name', 'Bo');
            await q.fill('#join-code', code).catch(() => {}); await q.click('#join').catch(() => {}); await q.waitForTimeout(700);
            if (await h.isVisible('#start-btn').catch(() => false)) await h.click('#start-btn').catch(() => {});
            await h.waitForTimeout(900);
            note(game, `online ${tag}`, await h.evaluate(audit, { card: CARDS[game] }));
          }
        }
      }
      if (errs.length) note(game, tag, errs.map((e) => `works: ${e.slice(0, 120)}`));
      await ctx.close();
    }
  }
  await b.close(); server.close();
  const keys = Object.keys(problems).sort();
  for (const k of keys) console.log(`${k}   [${[...problems[k]].join(', ')}]`);
  console.log(`\n${keys.length} problem(s).`);
  process.exit(keys.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
