// End-to-end test, run by ../e2e.cjs (see there). Gets the shared helpers; plays on the real Firebase SDK + emulator.
module.exports = async ({ page, ok, statusIs, BASE, out }) => {
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
  ok(await statusIs(W2, 'P1 left. You win! 🎉'), 'leaving mid-game forfeits to the other player');
};
