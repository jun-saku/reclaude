// End-to-end test of the game kit's turn-based engine (shared/kit.js, kind: "turns") with a test-only tic-tac-toe
// (tests/fixtures/kit-turns): on one phone, and online through Firebase rooms and the real rules: lobby, moves only
// on your turn, a win, Play again by agreement, and leaving mid-game.
module.exports = async ({ page, ok, BASE }) => {
  const URL = BASE + '__fixtures/kit-turns/?backend=emulator';
  const wait = (p, fn, arg, ms = 10000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const board = (p) => p.evaluate(() => window.__kit.info?.view?.board);

  // Same phone: the players take turns on one device.
  const L = await page(URL);
  await L.click('#local');
  ok(await wait(L, () => window.__kit.mode === 'local' && window.__kit.info.view.board === '---------'), 'a same-phone game starts');
  for (const c of [0, 3, 1, 4]) await L.evaluate((c) => window.__kit.act({ cell: c }), c);
  ok((await board(L)) === 'XX-OO----' && (await L.textContent('#status')).includes('Player 1'), `moves alternate on one phone (${await board(L)})`);
  await L.evaluate(() => window.__kit.act({ cell: 2 }));
  ok(await wait(L, () => !document.getElementById('over').hidden) && /Player 1 wins/.test(await L.textContent('#over-title')), `three in a row wins (${await L.textContent('#over-title')})`);
  await L.click('#rematch');
  ok(await wait(L, () => window.__kit.info.view.board === '---------' && document.getElementById('over').hidden), 'Play again starts afresh');

  // Online: two players, the real rules.
  const A = await page(URL); await A.fill('#my-name', 'Ann'); await A.click('#create');
  await A.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const code = (await A.textContent('#waiting-code')).trim();
  const B = await page(URL); await B.fill('#my-name', 'Ben'); await B.fill('#join-code', code); await B.click('#join');
  await B.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  ok(await wait(A, () => !document.getElementById('start-btn').disabled), 'the host can start once the room is full');
  await A.click('#start-btn');
  ok(await wait(A, () => document.getElementById('status').textContent === 'Your turn') && await wait(B, () => document.getElementById('status').textContent.startsWith("Ann's turn")), 'the game starts: the host moves first');
  const early = await B.evaluate(() => window.__kit.act({ cell: 4 }));
  ok(!early && (await board(B)) === '---------', 'a move out of turn is refused');
  // Bypassing the kit, writing the room directly as B out of turn: the database rules refuse it.
  const forced = await B.evaluate(async () => {
    const s = window.__kit.seat;
    try { await s.backend.update(s.code, { 'state/g': JSON.stringify({ board: 'O--------', turn: 0, moves: 1 }) }); return 'written'; } catch { return 'refused'; }
  });
  ok(forced === 'refused', `and so is writing the game out of turn behind the kit's back (${forced})`);
  for (const [p, c] of [[A, 0], [B, 4], [A, 1], [B, 5]]) {
    const who = p === A ? 0 : 1;
    await wait(p, (w) => window.__kit.info?.turn === w, who);
    ok(await p.evaluate((c) => window.__kit.act({ cell: c }), c), `a move on your turn goes through (cell ${c})`);
  }
  await wait(A, () => window.__kit.info?.turn === 0);
  await A.evaluate(() => window.__kit.act({ cell: 2 }));
  ok(await wait(B, () => !document.getElementById('over').hidden && /Ann wins/.test(document.getElementById('over-title').textContent)), 'the winner is shown to everyone');
  ok(await wait(A, () => /You win/.test(document.getElementById('over-title').textContent)), 'and to the winner as a win');
  await A.click('#rematch');
  ok(await wait(A, () => /Waiting for Ben/.test(document.getElementById('rematch').textContent)), 'Play again waits for everyone');
  await B.click('#rematch');
  ok(await wait(A, () => window.__kit.info?.view?.board === '---------' && document.getElementById('over').hidden) && await wait(B, () => document.getElementById('over').hidden), 'and starts the next round once both agree');
  // Leaving mid-game ends it for the other player (a forfeit).
  B.on('dialog', (d) => d.accept());
  await B.click('#leave');
  ok(await wait(A, () => !document.getElementById('over').hidden && /You win/.test(document.getElementById('over-title').textContent)), 'a player leaving mid-game hands the win to the other');
};
