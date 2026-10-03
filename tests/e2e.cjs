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
  ok(await A.waitForFunction(() => document.getElementById('rematch').textContent.includes('friend is ready'), null, { timeout: 8000 }).then(() => true).catch(() => false) && await B.$eval('#rematch', (b) => b.disabled), 'play again waits for both: Red sees Yellow is ready, Yellow waits');
  await A.click('#rematch');
  ok(await statusIs(B, 'Your turn') && await statusIs(A, "Friend's turn…"), 'play again: Yellow starts round 2 once both tapped');
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
  // Red leaves mid-game (confirming the dialog): Yellow is told and wins the round
  A.once('dialog', (d) => d.accept());
  await A.click('#leave'); await A.waitForSelector('#home:not([hidden])', { timeout: 8000 });
  ok(await statusIs(B, 'Your friend left. You win 🎉'), 'leaving mid-game forfeits; the friend sees it');
  ok(await B.waitForFunction(() => document.getElementById('rematch').hidden, null, { timeout: 8000 }).then(() => true).catch(() => false), 'play again waits until the friend is back');
  // A waiting room is deleted when its host leaves it
  const Z = await page(C4);
  await Z.click('#create'); await Z.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const zcode = (await Z.textContent('#waiting-code')).trim();
  await Z.click('#leave'); await Z.waitForSelector('#home:not([hidden])', { timeout: 8000 });
  await C.fill('#join-code', zcode); await C.click('#join');
  await C.waitForFunction(() => document.getElementById('home-error').textContent.length > 0, null, { timeout: 8000 });
  ok((await C.textContent('#home-error')).includes('No room called'), 'a waiting room is deleted when its host leaves');

  // ---- Five Line on real Firebase: lobby, deal, a whole game played by a simple bot, hands stay private ----
  const FL = BASE + 'five-line/?backend=emulator';
  const F1 = await page(FL); await F1.click('.seg button[data-mode="3"]');
  await F1.click('#create'); await F1.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const fcode = (await F1.textContent('#waiting-code')).trim();
  const F2 = await page(FL + '&room=' + fcode); await F2.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  ok(await F2.$eval('#start-btn', (b) => b.hidden), `five line: room ${fcode}, only the host gets a Start button`);
  await F1.waitForFunction(() => !document.getElementById('start-btn').disabled, null, { timeout: 8000 });
  await F1.click('#start-btn'); await F1.waitForSelector('#board:not([hidden])', { timeout: 15000 });
  await F2.waitForSelector('#board:not([hidden])', { timeout: 15000 });
  await F1.waitForFunction(() => window.__fl.hand && window.__fl.hand.length === 6, null, { timeout: 8000 });
  await F2.waitForFunction(() => window.__fl.hand && window.__fl.hand.length === 6, null, { timeout: 8000 });
  const fh = [await F1.evaluate(() => window.__fl.hand), await F2.evaluate(() => window.__fl.hand)];
  ok(new Set(fh.flat()).size === 12, 'host starts a 3-seat room with 2 players; both deal themselves 6 different cards');
  const fpeek = await F2.evaluate(async (c) => { const b = await window.__fl.rooms.__test.backend(); return new Promise((r) => b.watchPrivate(c, 0, (v, e) => r(e ? 'denied' : 'read ' + v))); }, fcode);
  ok(fpeek === 'denied', "a player can't read the other's hand");
  const flBot = async () => {
    const r = window.__fl.room, hand = window.__fl.hand, me = window.__fl.seat.seat;
    if (!r || r.status !== 'playing' || r.turn !== me || !hand) return 'skip';
    const L = window.__fl.LAYOUT, kind = (c) => (c[0] === 'W' || c[0] === 'X' ? c[0] : c.slice(0, -1));
    for (const c of hand) {
      const k = kind(c); if (k === 'X') continue;
      const t = k === 'W' ? [...r.board].flatMap((v, i) => (v === '-' ? [i] : [])) : L.flatMap((x, i) => (x === k && r.board[i] === '-' ? [i] : []));
      if (!t.length) { if (k !== 'W') { await window.__fl.swapDead(c); return 'swap'; } continue; }
      await window.__fl.play(c, t[0]); return 'play';
    }
    return 'nothing';
  };
  let fturns = 0, swaps = 0;
  for (; fturns < 300; fturns++) {
    const r = await F1.evaluate(() => window.__fl.room);
    if (r.status !== 'playing') break;
    const res = await [F1, F2][r.turn].evaluate(flBot);
    if (res === 'swap') swaps++;
    if (res === 'nothing') break;
    await F1.waitForTimeout(80);
  }
  const fr = await F1.evaluate(() => window.__fl.room);
  const flLines = fr.line.split(',').map(Number), flWon = []; for (let i = 0; i < flLines.length; i += 5) flWon.push(flLines.slice(i, i + 5));
  const winnerLines = flWon.filter((g) => fr.board[g.find((x) => ![0, 9, 90, 99].includes(x))] === String(fr.winner)).length;
  ok(fr.status === 'done' && typeof fr.winner === 'number' && winnerLines === 2, `the rules accept every move; 2 players need two lines to win (${fturns} turns, ${swaps} dead-card swaps, winner seat ${fr.winner} with ${winnerLines} lines)`);
  ok(await statusIs([F1, F2][fr.winner], 'You win! 🎉'), 'the winner is told');
  await F1.screenshot({ path: `${out}/e2e-fl.png` });
  await F2.click('#rematch'); await F1.waitForFunction(() => document.getElementById('hint').textContent.includes('wants to play again'), null, { timeout: 8000 });
  await F1.click('#rematch'); await F2.waitForFunction(() => window.__fl.room.round === 1 && window.__fl.hand && window.__fl.hand.length === 6, null, { timeout: 8000 });
  ok(true, 'play again deals a new round once both tapped');
  // Leaving when it isn't your turn forfeits under the real rules (the room is rewritten whole, state included)
  const fr1 = await F1.evaluate(() => window.__fl.room);
  const leaver = [F1, F2][1 - fr1.turn], stayer = [F1, F2][fr1.turn];
  leaver.once('dialog', (d) => d.accept()); await leaver.click('#leave'); await leaver.waitForSelector('#home:not([hidden])', { timeout: 8000 });
  ok(await statusIs(stayer, `P${2 - fr1.turn} left. You win 🎉`), 'leaving off-turn forfeits a game with state; the other player wins');

  // ---- Names and the turn timer on real Firebase (a 3-seat Five Line room with a 30 s timer) ----
  const T1 = await page(FL); await T1.fill('#my-name', 'Jun'); await T1.click('#mode button[data-mode="3"]'); await T1.click('#timer button[data-secs="30"]');
  await T1.click('#create'); await T1.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const tmcode = (await T1.textContent('#waiting-code')).trim();
  const T2 = await page(FL); await T2.fill('#my-name', 'Bo'); await T2.fill('#join-code', tmcode); await T2.click('#join'); await T2.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  await T1.waitForFunction(() => document.getElementById('seated').textContent.includes('Bo'), null, { timeout: 8000 });
  ok((await T2.textContent('#seated')).includes('Jun'), 'names reach the other players through the real rules');
  await T1.waitForFunction(() => !document.getElementById('start-btn').disabled, null, { timeout: 8000 });
  await T1.click('#start-btn'); await T1.waitForTimeout(3000);
  console.log('DEBUG note:', await T1.textContent('#waiting-note'), JSON.stringify(await T1.evaluate(() => { const r = window.__fl.room; return { status: r.status, turnSecs: r.turnSecs, turnAt: r.turnAt, names: r.names, keys: Object.keys(r) }; })));
  await T2.waitForFunction(() => window.__fl.room?.status === 'playing' && window.__fl.room.turnAt, null, { timeout: 15000 });
  ok(await T2.waitForFunction(() => document.getElementById('status').textContent.startsWith("Jun's turn"), null, { timeout: 8000 }).then(() => true).catch(() => false), 'turns are shown by name');
  const tooSoon = await T2.evaluate(() => window.__fl.rooms.skipTurn(window.__fl.seat, { ...window.__fl.room, turnAt: Date.now() - 60000 }));
  await T1.waitForTimeout(500);
  ok((await T1.evaluate(() => window.__fl.room.turn)) === 0, `skipping before the 30 seconds are up is refused by the rules (the page asked: ${tooSoon})`);
  // The player on turn backdates their own turn start, standing in for 30 seconds of waiting
  await T1.evaluate(() => { const s = window.__fl.seat; return s.backend.update(s.code, { turnAt: Date.now() - 31000 }); });
  await T2.waitForFunction(() => !document.getElementById('skip').hidden, null, { timeout: 8000 });
  await T2.click('#skip'); await T1.waitForFunction(() => window.__fl.room.turn === 1, null, { timeout: 8000 });
  ok(await T2.waitForFunction(() => document.getElementById('status').textContent.startsWith('Your turn'), null, { timeout: 8000 }).then(() => true).catch(() => false), 'once time is up, Skip passes the turn on through the real rules');

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

  // ---- Murder Weapon on real Firebase: 4-player lobby, a whole game to round 10 with a vote on the way ----
  const MW = BASE + 'murder-weapon/?backend=emulator';
  const M1 = await page(MW); await M1.click('#create'); await M1.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const mcode = (await M1.textContent('#waiting-code')).trim();
  const MP = [M1];
  for (let i = 0; i < 3; i++) { const p = await page(MW + '&room=' + mcode); await p.waitForSelector('#waiting:not([hidden])', { timeout: 15000 }); MP.push(p); }
  await M1.waitForFunction(() => !document.getElementById('start-btn').disabled, null, { timeout: 8000 });
  await M1.click('#start-btn');
  for (const p of MP) await p.waitForSelector('#table:not([hidden])', { timeout: 15000 });
  ok(true, `murder weapon: room ${mcode}, host starts with 4 players`);
  // One step for whoever's turn it is: move, search and take or drop, vote once in round 3, answer every task.
  const mwBot = async () => {
    const w = window.__mw, r = w.room, me = w.seat.seat;
    if (!r || r.status !== 'playing' || r.turn !== me) return 'skip';
    const st = w.parse(r), t = st.q.length ? st.q[0].k : null, h = st.hands[me];
    if (t === 'drop') return w.dropCard(h[0]), t;
    if (t === 'sweep') return w.sweep(h[0]), t;
    if (t === 'blackout') return w.blackout(st.piles[1].length ? 1 : null), t;
    if (t === 'vote') return w.vote(true), t;
    if (t === 'final') return w.finalVote(st.dead.findIndex((d, s) => !d && s !== me && w.rooms.seatList(r)[s])), t;
    if (st.dead[me]) return w.ghostMove(null, null), 'ghost';
    if (st.mv === 0) return w.move(st.lock === st.pos[me] ? st.pos[me] : [0, 1, 2].find((k) => k !== st.lock && k !== st.pos[me])), 'move';
    if (st.mv === 1 && st.r === 3 && !window.__voted) { window.__voted = true; return w.callVote(st.dead.findIndex((d, s) => !d && s !== me && s !== st.killer)), 'accuse'; }
    if (st.mv === 1) return w.openPile(), 'open';
    const pile = st.piles[st.pos[me]];
    return w.swap(h.length < 2 && pile.length ? pile[0] : null, h.length === 2 ? h[0] : null), 'swap';
  };
  let msteps = 0; const mseen = new Set();
  for (; msteps < 400; msteps++) {
    const r = await M1.evaluate(() => window.__mw.room);
    if (r.status !== 'playing') break;
    const res = await MP[r.turn].evaluate(mwBot);
    mseen.add(res);
    await M1.waitForFunction((t) => { const r = window.__mw.room; return r.status !== 'playing' || JSON.stringify(r.state) !== t; }, JSON.stringify(r.state), { timeout: 8000 }).catch(() => {});
  }
  const mr = await M1.evaluate(() => ({ room: window.__mw.room, st: window.__mw.parse(window.__mw.room) }));
  const mcards = [...mr.st.piles.flat(), ...mr.st.hands.flat()];
  ok(mr.room.status === 'done' && mr.st.out !== '-' && mseen.has('accuse') && mseen.has('vote'),
    `the rules accept every write: a vote and a full game (${msteps} steps, ${mr.st.out} wins, saw ${[...mseen].join(' ')})`);
  ok(mcards.length === 43 && new Set(mcards).size === 43, 'no card is lost or doubled');
  await M1.screenshot({ path: `${out}/e2e-mw.png` });
  for (const p of MP) await p.close();

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
  ok(await P.evaluate(async () => (await window.__2048.leaderboard()).top === null) && await P.evaluate(() => window.__2048.rooms()) === null,
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
  ok(low.includes('already higher'), `saving a lower score is refused with a clear message (${low.slice(0, 50)}…)`);
  await P.waitForTimeout(5200);
  await P.click('button[data-action="new"]');
  await lose(P, 2500);
  ok((await saveAs(P, 'Jun')).startsWith('Saved 2,500'), 'a higher score replaces your entry');
  await P.click('button[data-action="new"]');
  await lose(P, 2600);
  const quick = await saveAs(P, 'Jun');
  ok(quick.includes('a few seconds ago'), 'saving again within 5 seconds is refused, with a clear message');
  ok(await P.evaluate(() => [99999998, 1001, -2, 0].every((n) => !window.__2048.validScore(n)) && window.__2048.validScore(2600)), '2048 itself refuses impossible scores (over the maximum, odd, negative, zero)');
  await lose(P, 1001);
  ok((await saveAs(P, 'Jun')).includes("isn't a possible 2048 score"), "an impossible score on the board isn't saved, with a clear message");
  // A Reload tapped just after a fetch must not be cut off by that fetch's delayed disconnect (1.5 s later):
  // slow the next fetch down so it is still running when the disconnect would fire.
  await openTop(P); await P.waitForTimeout(1200);
  await P.evaluate(async () => { const b = await (await window.__2048.rooms()).__test.backend(); const real = b.topScores.bind(b); b.topScores = async (...a) => { await new Promise((r) => setTimeout(r, 600)); return real(...a); }; });
  await P.click('#leaders-reload');
  ok(await P.waitForFunction(() => !document.getElementById('leaders-reload').disabled, null, { timeout: 6000 }).then(() => true).catch(() => false)
    && (await names(P)).length === 2, 'a Reload right after a fetch still loads (not cut off by the earlier disconnect)');
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
