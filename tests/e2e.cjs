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

  // ---- Tile Rummy on real Firebase: deal, a whole game played by a simple bot, hands stay private ----
  const TR = BASE + 'tile-rummy/?backend=emulator';
  const R1 = await page(TR); await R1.click('#mode button[data-mode="3"]');
  await R1.click('#create'); await R1.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const rcode = (await R1.textContent('#waiting-code')).trim();
  const R2 = await page(TR + '&room=' + rcode); await R2.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  await R1.waitForFunction(() => !document.getElementById('start-btn').disabled, null, { timeout: 8000 });
  await R1.click('#start-btn');
  for (const P of [R1, R2]) await P.waitForFunction(() => window.__tr.hand && window.__tr.hand.length === 14, null, { timeout: 15000 });
  const rh = [await R1.evaluate(() => window.__tr.hand), await R2.evaluate(() => window.__tr.hand)];
  ok(new Set(rh.flat()).size === 28, `tile rummy: room ${rcode}, both players deal themselves 14 different tiles`);
  const rpeek = await R2.evaluate(async (c) => { const b = await window.__tr.rooms.__test.backend(); return new Promise((r) => b.watchPrivate(c, 0, (v, e) => r(e ? 'denied' : 'read ' + v))); }, rcode);
  ok(rpeek === 'denied', "a player can't read the other's rack");
  // Bot: add a tile to a set on the table, else put down the best new set of three (30+ points for a first
  // meld), else draw.
  const trBot = async () => {
    const T = window.__tr, r = T.room, me = T.seat.seat;
    if (!r || r.status !== 'playing' || r.turn !== me || !T.work) return 'skip';
    const hand = T.work.hand, A = T.analyze;
    if (r.state.melded.split(',')[me] === '1') {
      for (const t of hand) for (let i = 0; i < T.work.sets.length; i++) {
        if (A([...T.work.sets[i], t]).ok) { T.put([t], i); if (!T.problem()) { await T.done(); return 'play'; } }
      }
    }
    let best = null;
    for (let a = 0; a < hand.length; a++) for (let b = a + 1; b < hand.length; b++) for (let c = b + 1; c < hand.length; c++) {
      const x = A([hand[a], hand[b], hand[c]]);
      if (x.ok && (!best || x.value > best.v)) best = { s: [hand[a], hand[b], hand[c]], v: x.value };
    }
    if (best && (r.state.melded.split(',')[me] === '1' || best.v >= 30)) { T.put(best.s, 'new'); if (T.problem()) return 'bad ' + T.problem(); await T.done(); return 'play'; }
    await T.draw(); return 'draw';
  };
  let rturns = 0, rplays = 0, rbad = '';
  for (; rturns < 400; rturns++) {
    const r = await R1.evaluate(() => window.__tr.room);
    if (r.status !== 'playing') break;
    const P = [R1, R2][r.turn];
    await P.waitForFunction((t) => window.__tr.work && window.__tr.room.turn === t, r.turn, { timeout: 8000 }).catch(() => {});
    const res = await P.evaluate(trBot);
    if (res === 'play') rplays++;
    if (res.startsWith('bad')) { rbad = res; break; }
    await R1.waitForTimeout(60);
  }
  const rr = await R1.evaluate(() => window.__tr.room);
  await R1.waitForTimeout(500);
  const rhands = [await R1.evaluate(() => window.__tr.hand), await R2.evaluate(() => window.__tr.hand)];
  const onTable = rr.state.table === '-' ? 0 : rr.state.table.replace(/\./g, '').length / 2;
  ok(!rbad && rr.status === 'done' && rplays > 0 && rhands[0].length + rhands[1].length + onTable + 106 - rr.state.next === 106,
    `the rules accept every move; no tile is lost (${rturns} turns, ${rplays} plays, winner ${rr.winner}, counts ${rr.state.counts}) ${rbad}`);
  if (typeof rr.winner === 'number') ok(await statusIs([R1, R2][rr.winner], 'You win! 🎉'), 'the winner is told');
  await R1.screenshot({ path: `${out}/e2e-tr.png` });
  await R2.click('#rematch'); await R1.click('#rematch');
  await R2.waitForFunction(() => window.__tr.room.round === 1 && window.__tr.hand && window.__tr.hand.length === 14, null, { timeout: 8000 });
  ok(true, 'play again deals new racks once both tapped');

  // ---- Bridge on real Firebase: 2 friends as partners, computers in the other seats run by the host ----
  const BR = BASE + 'bridge/?backend=emulator';
  const H1 = await page(BR); await H1.click('#create'); await H1.waitForSelector('#lobby:not([hidden])', { timeout: 15000 });
  const bcode = (await H1.textContent('#lobby-code')).trim();
  const H2 = await page(BR + '&room=' + bcode); await H2.waitForSelector('#lobby:not([hidden])', { timeout: 15000 });
  await H1.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 8000 });
  await H1.click('#start');
  for (const P of [H1, H2]) await P.waitForFunction(() => window.__br.G, null, { timeout: 15000 });
  ok(JSON.stringify(await H2.evaluate(() => window.__br.G.owner)) === '[1,-1,0,-1]', `bridge: room ${bcode}, the guest sits North opposite the host`);
  // Whoever must act (a person, or the host for the computers) plays the computer's choice.
  let bmoves = 0, bstuck = 0;
  for (; bmoves < 400 && bstuck < 60; ) {
    const st = await Promise.all([H1, H2].map((P) => P.evaluate(() => ({ s: window.__br.room.status, mine: window.__br.myTurn(), k: window.__br.G.played.length + window.__br.G.auction.length }))));
    if (st[0].s === 'done' && st[1].s === 'done') break;
    const i = st.findIndex((x) => x.mine);
    if (i < 0) { bstuck++; await H1.waitForTimeout(250); continue; }
    bstuck = 0;
    await [H1, H2][i].evaluate(async () => { const B = window.__br, G = B.G; await B.act(G.phase === 'bidding' ? 'call' : 'play', G.phase === 'bidding' ? B.botCall(G, G.turn) : B.botPlay(G, G.turn)); });
    await [H1, H2][i].waitForFunction((k) => { const G = window.__br.G; return G.played.length + G.auction.length !== k || G.board > 1; }, st[i].k, { timeout: 8000 }).catch(() => {});
    bmoves++;
  }
  const bg = await Promise.all([H1, H2].map((P) => P.evaluate(() => [window.__br.room.status, window.__br.G.phase, JSON.stringify(window.__br.G.totals)])));
  ok(bg[0][0] === 'done' && bg[0][1] === 'done' && bg[0][2] === bg[1][2], `a whole deal is played through the rules (${bmoves} moves by people, totals ${bg[0][2]})`);
  const bsneak = await H2.evaluate(async (c) => {
    const b = await window.__br.rooms.__test.backend();
    try { const r = await b.transact(c, (cur) => cur ? { ...cur, state: { g: 'x' } } : null); return r.committed ? 'written' : 'aborted'; }
    catch (e) { return 'denied: ' + e.message; }
  }, bcode);
  ok(bsneak.startsWith('denied'), `a finished deal can't be rewritten (${bsneak.slice(0, 40)})`);
  for (const P of [H1, H2]) { await P.evaluate(() => document.getElementById('hint').click()); await P.waitForTimeout(300); }
  ok(await H2.waitForFunction(() => window.__br.room.status === 'playing' && window.__br.G.board === 2, null, { timeout: 8000 }).then(() => true).catch(() => false), 'next deal starts once both tapped, totals carried over');
  await H2.screenshot({ path: `${out}/e2e-bridge.png` });

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

  // ---- Wall Race on real Firebase: 2 players, walls and pawn moves, a whole race, play again, leave ----
  const WR = BASE + 'wall-race/?backend=emulator';
  const W1 = await page(WR); await W1.click('#create'); await W1.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const wcode = (await W1.textContent('#waiting-code')).trim();
  const W2 = await page(WR + '&room=' + wcode);
  await W1.waitForSelector('#board:not([hidden])', { timeout: 15000 }); await W2.waitForSelector('#board:not([hidden])', { timeout: 15000 });
  ok(await W2.evaluate(() => document.getElementById('board').style.transform === 'rotate(180deg)'), `wall race: room ${wcode} starts when the second player joins; their board is turned`);
  // Each player first places a wall in front of the other, then heads straight for their goal (shortest path).
  const wrBot = async (wall) => {
    const { room: r, seat } = window.__wr; const me = seat.seat;
    if (r.status !== 'playing' || r.turn !== me) return 'skip';
    const pos = r.state.pos.split(',').map(Number);
    if (wall !== null) return (await window.__wr.act(wall), 'wall');
    const goalRow = me === 0 ? 0 : 8;
    const dist = (cell) => { const seen = new Map([[cell, 0]]), q = [cell]; while (q.length) { const x = q.shift(); if (Math.floor(x / 9) === goalRow) return seen.get(x);
      for (const n of window.__wr.movesFrom(r.board, pos.map((p, i) => (i === me ? x : -1)), me)) if (!seen.has(n)) { seen.set(n, seen.get(x) + 1); q.push(n); } } return 99; };
    const m = window.__wr.movesFrom(r.board, pos, me).sort((a, b) => dist(a) - dist(b));
    await window.__wr.act(m[0]); return 'move';
  };
  ok(await W1.evaluate(() => window.__wr.wallProblem('-'.repeat(64), 27, 'h', [76, 4], 2) === '' && window.__wr.wallProblem('-'.repeat(27) + 'h' + '-'.repeat(36), 28, 'h', [76, 4], 2) !== ''), 'overlapping walls are refused');
  await W1.evaluate(wrBot, { slot: 19, o: 'h' }); await W2.waitForFunction(() => window.__wr.room.turn === 1, null, { timeout: 8000 });
  await W2.evaluate(wrBot, { slot: 43, o: 'h' }); await W1.waitForFunction(() => window.__wr.room.turn === 0, null, { timeout: 8000 });
  let wturns = 0;
  for (; wturns < 100; wturns++) {
    const r = await W1.evaluate(() => window.__wr.room);
    if (r.status !== 'playing') break;
    await [W1, W2][r.turn].evaluate(wrBot, null);
    await [W1, W2][r.turn].waitForFunction((t) => window.__wr.room.turn !== t || window.__wr.room.status !== 'playing', r.turn, { timeout: 8000 });
  }
  const wr = await W1.evaluate(() => window.__wr.room);
  const wpos = wr.state.pos.split(',').map(Number);
  const reached = wpos.map((p, s) => (s === 0 ? p < 9 : p >= 72));
  ok(wr.status === 'done' && typeof wr.winner === 'number' && reached[wr.winner] && !reached[1 - wr.winner] && wr.board.replace(/-/g, '').length === 2 && wr.state.walls === '9,9',
    `the rules accept walls and moves; the first to the far side wins (${wturns} moves, seat ${wr.winner} at ${wpos[wr.winner]})`);
  ok(await statusIs([W1, W2][wr.winner], 'You win! 🎉') && await statusIs([W1, W2][1 - wr.winner], `P${wr.winner + 1} wins`), 'both players are told who won');
  await W2.waitForTimeout(500); await W2.screenshot({ path: `${out}/e2e-wr.png` });
  await W1.click('#rematch'); await W2.click('#rematch');
  await W1.waitForFunction(() => window.__wr.room.round === 1 && window.__wr.room.status === 'playing' && window.__wr.room.turn === 1, null, { timeout: 8000 });
  ok(true, 'play again starts a new race once both tapped, and the other player goes first');
  W1.once('dialog', (d) => d.accept()); await W1.click('#leave'); await W1.waitForSelector('#home:not([hidden])', { timeout: 8000 });
  ok(await statusIs(W2, 'P1 left. You win 🎉'), 'leaving mid-game forfeits to the other player');

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
