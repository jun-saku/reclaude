// End-to-end test, run by ../e2e.cjs (see there). Gets the shared helpers; plays on the real Firebase SDK + emulator.
module.exports = async ({ page, ok, statusIs, BASE, out }) => {
  // ---- Chain Reaction on real Firebase: 2 players, bursts and take-overs, a whole game, play again, leave ----
  const CR = BASE + 'chain-reaction/?backend=emulator';
  const CR1 = await page(CR); await CR1.click('#create'); await CR1.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const crcode = (await CR1.textContent('#waiting-code')).trim();
  const CR2 = await page(CR + '&room=' + crcode);
  await CR1.waitForSelector('#board:not([hidden])', { timeout: 15000 }); await CR2.waitForSelector('#board:not([hidden])', { timeout: 15000 });
  ok(true, `chain reaction: room ${crcode} starts when the second player joins`);
  ok(await CR1.evaluate(() => { const s = window.__cr.play('01' + '--'.repeat(52) + '11', 0, 0); return s.length === 2 && s[1].startsWith('--') && s[1].slice(2, 4) === '01' && s[1].slice(12, 14) === '01'; }),
    'a full corner bursts into its two neighbours');
  // Each player taps a cell they may play (their fullest one when they have some), until someone owns every orb.
  const crBot = async () => {
    const { room: r, seat } = window.__cr; const me = seat.seat;
    if (r.status !== 'playing' || r.turn !== me || window.__cr.animating) return 'skip';
    const ok = []; for (let i = 0; i < 54; i++) if (window.__cr.canPlace(r.board, i, me)) ok.push(i);
    const mine = ok.filter((i) => r.board[2 * i] !== '-').sort((a, b) => r.board[2 * b + 1] - r.board[2 * a + 1]);
    await window.__cr.move(mine.length && Math.random() < 0.7 ? mine[0] : ok[Math.floor(Math.random() * ok.length)]); return 'move';
  };
  let crturns = 0;
  for (; crturns < 400; crturns++) {
    const r = await CR1.evaluate(() => window.__cr.room);
    if (r.status !== 'playing') break;
    const P = [CR1, CR2][r.turn];
    await P.waitForFunction(() => !window.__cr.animating, null, { timeout: 20000 });
    await P.evaluate(crBot);
    await P.waitForFunction((t) => window.__cr.room.turn !== t || window.__cr.room.status !== 'playing', r.turn, { timeout: 8000 });
  }
  const crr = await CR1.evaluate(() => window.__cr.room);
  const crown = new Set(); for (let i = 0; i < crr.board.length; i += 2) if (crr.board[i] !== '-') crown.add(Number(crr.board[i]));
  ok(crr.status === 'done' && typeof crr.winner === 'number' && crown.size === 1 && crown.has(crr.winner), `the rules accept every move; the last colour on the board wins (${crturns} moves, seat ${crr.winner})`);
  await CR2.waitForFunction(() => !window.__cr.animating, null, { timeout: 30000 });
  ok(await CR2.evaluate(() => { const b = window.__cr.room.board; return [...document.querySelectorAll('.cell')].every((el, i) => el.querySelectorAll('.orb').length === Math.min(3, b[2 * i] === '-' ? 0 : Number(b[2 * i + 1]))); }),
    'the other phone plays the bursts out and ends on the same board');
  ok(await statusIs([CR1, CR2][crr.winner], 'You win! 🎉') && await statusIs([CR1, CR2][1 - crr.winner], `P${crr.winner + 1} wins`), 'both players are told who won');
  await CR2.screenshot({ path: `${out}/e2e-cr.png` });
  await CR1.click('#rematch'); await CR2.click('#rematch');
  await CR1.waitForFunction(() => window.__cr.room.round === 1 && window.__cr.room.status === 'playing' && window.__cr.room.turn === 1, null, { timeout: 8000 });
  ok(true, 'play again starts a new game once both tapped, and the other player goes first');
  CR2.once('dialog', (d) => d.accept()); await CR2.click('#leave'); await CR2.waitForSelector('#home:not([hidden])', { timeout: 8000 });
  ok(await statusIs(CR1, 'P2 left. You win! 🎉'), 'leaving mid-game forfeits to the other player');
};
