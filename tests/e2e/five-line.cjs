// End-to-end test, run by ../e2e.cjs (see there). Gets the shared helpers; plays on the real Firebase SDK + emulator.
module.exports = async ({ page, ok, statusIs, BASE, out }) => {
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
  ok(await statusIs(stayer, `P${2 - fr1.turn} left. You win! 🎉`), 'leaving off-turn forfeits a game with state; the other player wins');
};
