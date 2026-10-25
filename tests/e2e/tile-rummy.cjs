// End-to-end test, run by ../e2e.cjs (see there). Gets the shared helpers; plays on the real Firebase SDK + emulator.
module.exports = async ({ page, ok, statusIs, BASE, out }) => {
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
  // Live view: the player on turn puts a tile down; the other watches it appear before Done, then Undo clears it.
  {
    const t0 = await R1.evaluate(() => window.__tr.room.turn);
    const [M, O] = t0 === 0 ? [R1, R2] : [R2, R1];
    await M.waitForFunction(() => window.__tr.work, null, { timeout: 8000 });
    await M.evaluate(() => window.__tr.put([window.__tr.work.hand[0]], 'new'));
    const seen = await O.waitForFunction(() => document.querySelectorAll('#table .set').length === 1 && /arranging/.test(document.getElementById('hint').textContent), null, { timeout: 8000 }).then(() => true, () => false);
    await M.click('#reset');
    const gone = await O.waitForFunction(() => !document.querySelector('#table .set'), null, { timeout: 8000 }).then(() => true, () => false);
    ok(seen && gone, 'the other player watches the table change live, and Undo takes it back');
  }
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
};
