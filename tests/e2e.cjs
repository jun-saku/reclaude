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
  // Red is seated but it's Yellow's turn: the rules must refuse Red's write
  const early = await A.evaluate(async (code) => {
    const b = await window.__c4.rooms.__test.backend();
    try { const r = await b.transact(code, (cur) => cur ? { ...cur, board: 'x'.repeat(42) } : null); return r.committed ? 'written' : 'aborted'; }
    catch (e) { return 'denied: ' + e.message; }
  }, code);
  ok(early.startsWith('denied'), `a player can't change the board on the other player's turn (${early.slice(0, 40)})`);
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
  const names = (p) => p.$$eval('#leader-list li', (lis) => lis.map((li) => [...li.children].map((c) => c.textContent).join(' ')));
  const shown = (p, sel) => p.evaluate((sel) => getComputedStyle(document.querySelector(sel)).display !== 'none', sel);
  const openTop = async (p) => { await p.click('#trophy'); await p.waitForFunction(() => !document.getElementById('leaders-reload').disabled, null, { timeout: 15000 }); };
  const closeTop = (p) => p.click('#leaders-close');
  const lose = (p, s) => p.evaluate((s) => { window.__2048.setSpawn(false); window.__2048.setGrid([[2,4,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,8]], s); }, s);
  const saveAs = async (p, name) => { await p.fill('#save-name', name); await p.click('#save-btn'); await p.waitForFunction(() => !/Saving/.test(document.getElementById('save-msg').textContent) && document.getElementById('save-msg').textContent, null, { timeout: 8000 }); return p.textContent('#save-msg'); };

  const P = await page(G);
  await P.waitForTimeout(1500);
  ok(await P.evaluate(async () => (await window.__2048.leaderboard()).top === null) && await P.evaluate(async () => (await import('../shared/rooms.js')).__test.isOnline()) === null,
    'nothing connects to Firebase until the 🏆 is tapped');
  ok(!(await shown(P, '#save-form')), 'no save form during play');
  await openTop(P);
  ok((await P.textContent('#leaders-status')) === 'No scores yet. Be the first!', 'opening 🏆 fetches the Top 10 (empty)');
  await closeTop(P);

  await lose(P, 1840);
  ok(await shown(P, '#save-form') && (await P.textContent('#save-btn')) === 'Save 1,840', 'losing shows a name box and "Save 1,840" on the game-over screen');
  await P.click('#save-name');
  const before = await P.evaluate(() => JSON.stringify(window.__2048.grid()));
  await P.keyboard.type('Jun wasd');
  ok(await P.evaluate(() => JSON.stringify(window.__2048.grid())) === before, 'typing a name (incl. w/a/s/d) does not move tiles');
  const m1 = await saveAs(P, '<b>Jun</b>!!');
  ok(m1.startsWith('Saved 1,840 as bJunb'), `saved through the real rules; name cleaned of symbols (${m1})`);
  ok(!(await shown(P, '#save-form')), 'the save form goes away once saved');
  await openTop(P);
  const n1 = await names(P);
  ok(n1.length === 1 && n1[0] === '1. bJunb 1,840' && await P.$eval('#leader-list li', (li) => li.classList.contains('me')), 'the 🏆 shows the new entry, highlighted as yours');
  await closeTop(P);

  const Q = await page(G);
  await openTop(Q);
  ok((await names(Q))[0] === '1. bJunb 1,840', 'another player sees it');
  await closeTop(Q);
  await lose(Q, 3000);
  ok((await saveAs(Q, 'Bo')).startsWith('Saved 3,000'), 'another player saves a higher score');
  await openTop(P);
  ok(JSON.stringify(await names(P)) === JSON.stringify(['1. bJunb 1,840']), 'the open sheet keeps what it fetched…');
  await P.click('#leaders-reload');
  await P.waitForFunction(() => document.querySelectorAll('#leader-list li').length === 2, null, { timeout: 8000 });
  ok(JSON.stringify(await names(P)) === JSON.stringify(['1. Bo 3,000', '2. bJunb 1,840']), '…and Reload fetches the new standings, best first');
  await closeTop(P);

  await P.click('button[data-action="new"]');
  await lose(P, 500);
  const low = await saveAs(P, 'Jun');
  ok(low.includes('already higher'), `saving a lower score is refused by the rules with a clear message (${low.slice(0, 50)}…)`);
  await P.waitForTimeout(5200);
  await P.click('button[data-action="new"]');
  await lose(P, 2500);
  ok((await saveAs(P, 'Jun')).startsWith('Saved 2,500'), 'a higher score replaces your entry');
  await P.click('button[data-action="new"]');
  await lose(P, 2600);
  const quick = await saveAs(P, 'Jun');
  ok(quick.includes('a few seconds ago'), 'saving again within 5 seconds is refused, with a clear message');
  const forged = await P.evaluate(async () => {
    const b = await (await import('../shared/rooms.js')).__test.backend();
    try { await b.saveScore('2048', 'Hax', 99999998); return 'saved'; } catch (e) { return 'denied'; }
  });
  ok(forged === 'denied', 'a forged impossible score is rejected by the rules');
  await openTop(P);
  await P.screenshot({ path: `${out}/e2e-2048-sheet.png` });
  await P.mouse.click(195, 30);
  ok(!(await P.evaluate(() => document.getElementById('leaders').open)), 'tapping outside closes the sheet');
  await P.click('#trophy'); await P.click('.leaders-head h2');
  ok(await P.evaluate(() => document.getElementById('leaders').open), 'tapping inside keeps it open');
  await P.keyboard.press('Escape');

  ok(errs.length === 0, 'no JavaScript errors ' + errs.join(' | '));
  console.log('\nFAILS:', fails);
  await b.close();
  server.close();
  process.exit(fails ? 1 : 0);
})();
