// End-to-end test, run by ../e2e.cjs (see there). Gets the shared helpers; plays on the real Firebase SDK + emulator.
module.exports = async ({ page, ok, BASE, out }) => {
  // ---- Word Grid: a 3-player room on real Firebase ----
  const WG = BASE + 'word-grid/?backend=emulator';
  const ready = (p) => p.waitForFunction(() => window.__wordgrid?.ready(), null, { timeout: 15000 });
  const textIs = (p, sel, t) => p.waitForFunction(([s, t]) => document.querySelector(s)?.textContent === t, [sel, t], { timeout: 10000 }).then(() => true).catch(() => false);
  const play = async (p, w) => { await p.keyboard.type(w); await p.keyboard.press('Enter'); await p.waitForTimeout(80); };
  const timeUp = (p) => p.evaluate(() => window.__wordgrid.setTimeLeft(0));

  const A = await page(WG); await ready(A);
  await A.fill('#my-name', 'Ann'); await A.click('#create');
  await A.waitForSelector('#lobby:not([hidden])', { timeout: 15000 });
  const code = (await A.textContent('#waiting-code')).trim();
  ok(/^[A-HJ-NP-Z2-9]{4}$/.test(code), `word-grid: room ${code} created through the real rules`);
  const B = await page(`${WG}&room=${code}`); await ready(B);
  const C = await page(WG); await ready(C);
  await C.fill('#join-code', code); await C.click('#join');
  for (const p of [B, C]) await p.waitForSelector('#lobby:not([hidden])', { timeout: 15000 });
  ok(await A.isVisible('#start-btn') && !(await B.isVisible('#start-btn')), 'joined by link and by code; only the host can start');
  await A.click('#start-btn');
  for (const p of [A, B, C]) await p.waitForSelector('#play:not([hidden])', { timeout: 10000 });
  const boards = await Promise.all([A, B, C].map((p) => p.evaluate(() => window.__wordgrid.state().game.letters.join())));
  ok(boards.every((b) => b === boards[0]), 'everyone plays the same board');

  // Ann finds the two longest words, Bob one, the third player none.
  const words = await A.evaluate(() => window.__wordgrid.solve().sort((a, b) => b.length - a.length));
  await play(A, words[0]); await play(A, words[1]); await play(B, words[2]);
  await timeUp(B); await timeUp(C); await timeUp(A);
  for (const p of [A, B, C]) await p.waitForFunction(() => window.__wordgrid.state().room?.status === 'done', null, { timeout: 15000 });
  ok(await textIs(A, '#r-title', 'You win! 🎉') && await textIs(B, '#r-title', 'Ann wins!') && await textIs(C, '#r-title', 'Ann wins!'),
    'everyone hands in through the rules and sees the same winner');
  const st = (await C.textContent('#st-list')).replace(/\s+/g, ' ');
  ok(st.startsWith('1.Ann 🏆') && st.includes('0 · 0 words'), `standings list every player (${st.slice(0, 60)})`);
  await A.screenshot({ path: `${out}/e2e-word-grid.png`, fullPage: true });

  // Play again once everyone taps; a new board.
  await A.click('#rematch'); await B.click('#rematch');
  ok(await A.waitForFunction(() => document.getElementById('rematch').textContent.startsWith('Waiting for'), null, { timeout: 8000 }).then(() => true).catch(() => false),
    'play again waits for everyone online');
  await C.click('#rematch');
  for (const p of [A, B, C]) await p.waitForSelector('#play:not([hidden])', { timeout: 10000 });
  const next = await A.evaluate(() => window.__wordgrid.state().game.letters.join());
  ok(next !== boards[0], 'round 2 starts with fresh letters');

  // Reload mid-round: back in the same round with the words found so far.
  const w2 = (await B.evaluate(() => window.__wordgrid.solve()))[0];
  await play(B, w2);
  await B.reload(); await ready(B);
  await B.waitForSelector('#play:not([hidden])', { timeout: 15000 });
  ok((await B.evaluate(() => window.__wordgrid.state().game.found)).includes(w2), 'reload mid-round keeps the round and its words');

  // The first player to hand in leaves mid-round: once everyone else is done, they're skipped and the round ends.
  A.once('dialog', (d) => d.accept());
  await A.click('#end'); await A.waitForSelector('#home:not([hidden])', { timeout: 8000 });
  await timeUp(B); await timeUp(C);
  ok(await B.waitForFunction(() => window.__wordgrid.state().room?.status === 'done', null, { timeout: 60000 }).then(() => true).catch(() => false)
    && await textIs(B, '#r-title', 'You win! 🎉'), 'a player who left is skipped by the turn timer and the round still ends');
  ok((await B.textContent('#st-list')).includes("didn't hand in"), 'the player who left shows as not handed in');

  // A daily score saves to its own day's Top 10.
  const day = await B.evaluate(async () => {
    const id = `word-grid-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
    const rooms = window.__wordgrid.rooms;
    await rooms.saveScore(id, 'Bob', 7);
    return (await rooms.topScores(id, 10)).map((e) => `${e.name}:${e.score}`).join();
  });
  ok(day === 'Bob:7', `the daily Top 10 saves and loads (${day})`);
};
