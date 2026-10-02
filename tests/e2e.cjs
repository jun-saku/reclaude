// End-to-end check of the online games on the real Firebase SDK, the Firebase emulator and the real rules.
// Each browser context is a separate anonymous player. Firebase's CDN files are served from the npm
// package (same files, same version), so no internet access is needed.
// Run: node scripts/build.mjs && cd tests && npm install && npm run e2e   (needs Java and Playwright with Chromium)
const { chromium } = (() => {
  try { return require('playwright'); } catch { return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright'); }
})();
const http = require('http');
const fs = require('fs'), path = require('path');
const FB = __dirname;
const SITE = path.join(__dirname, '..', '_site');
const PORT = 8019;
const BASE = `http://localhost:${PORT}/reclaude/`;
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log((c ? 'ok   ' : 'FAIL ') + m); };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/reclaude/, '');
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(SITE, p);
  if (!f.startsWith(SITE) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
(async () => {
  await new Promise((r) => server.listen(PORT, r));
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

  // ---- Four in a Row on real Firebase ----
  const C4 = BASE + 'four-in-a-row/?backend=emulator';
  const A = await page(C4);
  await A.click('#create'); await A.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const code = (await A.textContent('#waiting-code')).trim();
  ok(/^[A-HJ-NP-Z2-9]{4}$/.test(code), `four-in-a-row: room ${code} created through the real rules`);
  const B = await page(`${C4}&room=${code}`);
  await B.waitForSelector('#board:not([hidden])', { timeout: 15000 });
  ok(await statusIs(A, 'Your turn') && await statusIs(B, "Friend's turn…"), 'joined by link; Red to move on both phones');
  const drop = async (p, c) => { await p.click(`.slot[data-i="${c}"]`); };
  for (const [p, c, waitP, t] of [[A,0,B,'Your turn'],[B,1,A,'Your turn'],[A,0,B,'Your turn'],[B,1,A,'Your turn'],[A,0,B,'Your turn'],[B,1,A,'Your turn']]) {
    await drop(p, c); await statusIs(waitP, t);
  }
  await drop(A, 0);
  ok(await statusIs(A, 'You win! 🎉') && await statusIs(B, 'Friend wins'), 'moves sync both ways and the win shows on both phones');
  await B.click('#rematch');
  ok(await statusIs(B, 'Your turn') && await statusIs(A, "Friend's turn…"), 'play again: Yellow starts round 2');
  const C = await page(C4);
  await C.fill('#join-code', code); await C.click('#join');
  await C.waitForFunction(() => document.getElementById('home-error').textContent.length > 0, null, { timeout: 8000 });
  ok((await C.textContent('#home-error')).includes('That room is full'), 'a third player is turned away');
  // A non-player tries to write to the room directly: the rules must refuse
  const sneak = await C.evaluate(async (code) => {
    const b = await window.__c4.rooms.__test.backend();
    try { const r = await b.transact(code, (cur) => cur ? { ...cur, board: 'x'.repeat(42) } : null); return r.committed ? 'written' : 'aborted'; }
    catch (e) { return 'denied: ' + e.message; }
  }, code);
  ok(sneak.startsWith('denied'), `a non-player can't change the board (${sneak.slice(0, 40)})`);
  await A.reload(); await A.waitForSelector('#board:not([hidden])', { timeout: 15000 });
  ok(await statusIs(A, "Friend's turn…"), 'reload: Red rejoins the same seat');
  await A.screenshot({ path: `${out}/e2e-c4.png` });

  // ---- Tic-tac-toe on real Firebase ----
  const TT = BASE + 'tic-tac-toe/?backend=emulator';
  const X = await page(TT);
  await X.click('#create'); await X.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const tcode = (await X.textContent('#waiting-code')).trim();
  const O = await page(TT);
  await O.fill('#join-code', tcode.toLowerCase()); await O.click('#join');
  await O.waitForSelector('#board:not([hidden])', { timeout: 15000 });
  ok(await statusIs(X, 'Your turn'), `tic-tac-toe: room ${tcode}, friend joined by typing the code`);
  for (const [p, i, w] of [[X,4,O],[O,0,X],[X,2,O],[O,1,X]]) { await p.click(`.cell[data-i="${i}"]`); await statusIs(w, 'Your turn'); }
  await X.click('.cell[data-i="6"]');
  ok(await statusIs(X, 'You win! 🎉') && await statusIs(O, 'Friend wins'), 'X wins the diagonal on both phones');

  // ---- New: 3-seat lobby, start, turn order, private hands (room API on real Firebase) ----
  const H = await page(BASE + 'four-in-a-row/?backend=emulator');
  const lobby = await H.evaluate(async () => {
    const r = window.__c4.rooms;
    const s = await r.createRoom('lobby-test', { seats: 3, min: 2, auto: false, makeRoom: () => ({ board: '' }) });
    window.__seat = s;
    return s.code;
  });
  const P2 = await page(BASE + 'four-in-a-row/?backend=emulator');
  const P3 = await page(BASE + 'four-in-a-row/?backend=emulator');
  const j2 = await P2.evaluate(async (c) => { const s = await window.__c4.rooms.joinRoom('lobby-test', c); window.__seat = s; return s.seat; }, lobby);
  const j3 = await P3.evaluate(async (c) => { const s = await window.__c4.rooms.joinRoom('lobby-test', c); window.__seat = s; return s.seat; }, lobby);
  ok(j2 === 1 && j3 === 2, `3-seat lobby: joiners get seats 1 and 2 (${j2}, ${j3})`);
  const notHost = await P2.evaluate(async () => { try { await window.__c4.rooms.startGame(window.__seat); return 'started'; } catch (e) { return 'refused'; } });
  ok(notHost === 'refused', 'only the host can start the game');
  const started = await H.evaluate(async () => {
    const room = await window.__c4.rooms.startGame(window.__seat, (room) => ({ ...room, teams: 0, state: { deck: 'AS,KH' } }));
    return { status: room.status, next: window.__c4.rooms.nextSeat(room, 2) };
  });
  ok(started.status === 'playing' && started.next === 0, 'host starts the game; turn order wraps from seat 2 back to seat 0');
  const P4 = await page(BASE + 'four-in-a-row/?backend=emulator');
  const late = await P4.evaluate(async (c) => { try { await window.__c4.rooms.joinRoom('lobby-test', c); return 'joined'; } catch (e) { return e.message; } }, lobby);
  ok(late.includes('full') || late.includes('already started'), `latecomer refused (${late})`);
  await P2.evaluate(async () => { const s = window.__seat; await s.backend.setPrivate(s.code, s.seat, 'QH,2S,7D'); });
  const own = await P2.evaluate(() => new Promise((res) => { const s = window.__seat; s.backend.watchPrivate(s.code, s.seat, (v, e) => res(e ? 'error' : v)); }));
  const peek = await P3.evaluate(() => new Promise((res) => { const s = window.__seat; s.backend.watchPrivate(s.code, 1, (v, e) => res(e ? 'denied' : 'saw: ' + v)); setTimeout(() => res('timeout'), 6000); }));
  ok(own === 'QH,2S,7D', 'a player can read their own private hand');
  ok(peek === 'denied', `another player can't read it (${peek})`);

  // ---- 2048 leaderboard on real Firebase ----
  const G = BASE + '2048/?backend=emulator';
  const loaded = (p) => p.waitForFunction(() => window.__2048 && window.__2048.leaderboard().uid !== null, null, { timeout: 15000 });
  const names = (p) => p.$$eval('#leader-list li', (lis) => lis.map((li) => li.children.length ? [...li.children].map((c) => c.textContent).join(' ') : li.textContent.trim()));
  const settled = (p) => p.waitForFunction(() => document.getElementById('leaders-note').textContent !== 'Loading…' && !document.getElementById('save-btn').disabled, null, { timeout: 8000 });
  // Checks what's on screen (an element can have hidden set and still be shown by CSS).
  const formHidden = (p) => p.waitForFunction(() => getComputedStyle(document.getElementById('save-form')).display === 'none', null, { timeout: 5000 }).then(() => true).catch(() => false);
  const P = await page(G);
  await loaded(P);
  ok((await names(P)).join() === 'No scores yet. Be the first!', 'leaderboard starts empty');
  await P.evaluate(() => { window.__2048.setSpawn(false); window.__2048.setGrid([[2,4,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,8]], 1840); });
  await P.waitForSelector('button[data-action="save"]', { timeout: 5000 });
  ok((await P.textContent('#message-text')).includes('personal best'), 'game over offers "Save score" for a new personal best');
  await P.click('button[data-action="save"]');
  ok(await P.evaluate(() => document.activeElement.id === 'save-name'), 'Save score jumps to the name field');
  const before = await P.evaluate(() => JSON.stringify(window.__2048.grid()));
  await P.keyboard.type('Jun wasd');
  ok(await P.evaluate(() => JSON.stringify(window.__2048.grid())) === before, 'typing a name (incl. w/a/s/d) does not move tiles');
  await P.fill('#save-name', '<b>Jun</b>!!');
  await P.click('#save-btn');
  await P.waitForFunction(() => /Saved/.test(document.getElementById('save-msg').textContent), null, { timeout: 8000 });
  await P.waitForFunction(() => document.querySelector('#leader-list li.me'), null, { timeout: 8000 });
  const n1 = await names(P);
  ok(n1.length === 1 && n1[0] === '1. bJunb 1,840', `saved through the real rules; name cleaned of symbols (${n1[0]})`);
  ok(await P.$eval('#leader-list li', (li) => li.classList.contains('me')) && (await P.textContent('#leaders-note')) === 'Your best: 1,840', 'your own entry is highlighted, with "Your best"');
  ok(await formHidden(P), 'no save offered once your best is saved');

  const Q = await page(G);
  await loaded(Q); await settled(Q);
  ok((await names(Q))[0] === '1. bJunb 1,840', 'another player sees the score');
  await Q.evaluate(() => { window.__2048.setSpawn(false); window.__2048.setGrid([[2,4,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,8]], 3000); });
  await Q.waitForSelector('#save-form:not([hidden])');
  await Q.fill('#save-name', 'Bo'); await Q.click('#save-btn');
  await Q.waitForFunction(() => /Saved/.test(document.getElementById('save-msg').textContent), null, { timeout: 8000 });
  await P.evaluate(() => window.__2048.reloadLeaderboard());
  ok(JSON.stringify(await names(P)) === JSON.stringify(['1. Bo 3,000', '2. bJunb 1,840']), 'ranked best first');

  await P.evaluate(() => window.__2048.setGrid([[2,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]], 500));
  ok(await formHidden(P), 'a lower score is not offered for saving');
  await P.evaluate(() => window.__2048.setGrid([[2,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]], 2500));
  await P.waitForSelector('#save-form:not([hidden])');
  await P.click('#save-btn');
  await P.waitForFunction(() => /just yet|Saved/.test(document.getElementById('save-msg').textContent), null, { timeout: 8000 });
  ok((await P.textContent('#save-msg')).includes('just yet'), 'saving again within 5 seconds is refused by the rules, with a friendly message');
  await P.waitForTimeout(5200);
  await P.click('#save-btn');
  await P.waitForFunction(() => /Saved 2,500/.test(document.getElementById('save-msg').textContent), null, { timeout: 8000 });
  await P.waitForFunction(() => /2,500/.test(document.getElementById('leaders-note').textContent), null, { timeout: 8000 });
  ok(JSON.stringify(await names(P)) === JSON.stringify(['1. Bo 3,000', '2. bJunb 2,500']), 'a higher score after the wait replaces your entry');
  ok(await formHidden(P), 'the save form disappears from the screen after saving');
  const forged = await P.evaluate(async () => {
    const b = await (await import('../shared/rooms.js')).__test.backend();
    try { await b.saveScore('2048', 'Hax', 99999998); return 'saved'; } catch (e) { return 'denied'; }
  });
  ok(forged === 'denied', 'a forged impossible score is rejected by the rules');
  await P.screenshot({ path: `${out}/e2e-2048.png`, fullPage: true });

  ok(errs.length === 0, 'no JavaScript errors ' + errs.join(' | '));
  console.log('\nFAILS:', fails);
  await b.close();
  server.close();
  process.exit(fails ? 1 : 0);
})();
