// End-to-end test, run by ../e2e.cjs: Doodle Guess with three players, the lobby on the real Firebase SDK + emulator
// and the game on the game server (worker/, run locally). The drawer picks a word and draws; the others see the
// drawing come in piece by piece (the game's feed) and guess; a reconnecting player gets the whole drawing; the pen
// goes round; the game ends and everyone plays again.
module.exports = async ({ page, ok, BASE, out }) => {
  const URL = BASE + 'doodle/?backend=emulator';
  const wait = (p, fn, arg, ms = 10000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const view = (p) => p.evaluate(() => window.__kit.info?.view);
  // A drawing as plain points, without the repeated point where a piece of a stroke joins the one before.
  const strokes = (p) => p.evaluate(() => window.__doodle.paper.strokes.map((s) => {
    const out = [];
    for (let i = 0; i < s.pts.length; i += 2) if (out.at(-2) !== s.pts[i] || out.at(-1) !== s.pts[i + 1]) out.push(s.pts[i], s.pts[i + 1]);
    return [s.c, s.w, out.join(',')].join('|');
  }).join(' / '));

  const H = await page(URL); await H.fill('#my-name', 'Jun'); await H.click('#create');
  await H.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const code = (await H.textContent('#waiting-code')).trim();
  const join = async (name) => { const p = await page(URL); await p.fill('#my-name', name); await p.fill('#join-code', code); await p.click('#join'); await p.waitForSelector('#waiting:not([hidden])', { timeout: 15000 }); return p; };
  const B = await join('Bo'), C = await join('Cy');
  ok(await wait(H, () => !document.getElementById('start-btn').disabled), 'the host can start with friends in');
  await H.click('#start-btn');
  const all = [H, B, C];
  for (const p of all) ok(await wait(p, () => window.__kit.status === 'connected' && window.__kit.info?.view?.phase === 'pick', null, 15000), 'each player connects and the first turn starts');

  // Who draws first: the one whose view says so.
  const seats = await Promise.all(all.map((p) => p.evaluate(() => window.__kit.info.me)));
  const drawerSeat = (await view(H)).drawer;
  const D = all[seats.indexOf(drawerSeat)], [G1, G2] = all.filter((p) => p !== D);
  ok((await view(D)).choices.length === 3 && (await view(G1)).choices.length === 0, 'only the drawer gets three words to choose from');
  ok(await G1.isVisible('text=is picking a word'), 'the others see who is picking');
  await D.click('[data-pick="0"]');
  ok(await wait(D, () => window.__kit.info.view.phase === 'draw' && !!window.__kit.info.view.word), 'the drawer picks a word and starts drawing');
  const word = (await view(D)).word;
  const g1 = await view(G1);
  ok(g1.word === '' && g1.mask.length === word.length && !/[a-z]/.test(g1.mask), `guessers see blanks, not the word (${g1.mask.replace(/ /g, '·')})`);

  // The drawer draws: a short stroke, a long one (sent in pieces), a dot, in another colour and size.
  const long = []; for (let i = 0; i < 150; i++) long.push(20 + i, 60 + Math.round(30 * Math.sin(i / 10)));
  await D.evaluate((l) => { window.__doodle.draw([10, 10, 50, 50, 90, 20]); window.__doodle.draw(l); }, long);
  await D.click('[data-colour="6"]'); await D.click('[data-size="2"]');
  await D.evaluate(() => window.__doodle.draw([200, 200]));
  const mine = await strokes(D);
  ok(await wait(G1, (n) => window.__doodle.paper.strokes.length === n && !window.__kit.info.feed.items.length === false, 3, 8000), 'the drawing reaches the guessers');
  await G1.waitForTimeout(400);
  ok(await strokes(G1) === mine && await strokes(G2) === mine, 'they see exactly what was drawn, long strokes and colours included');
  const items = await G1.evaluate(() => window.__kit.info.feed.items.length);
  ok(items >= 4, `a long stroke goes in several pieces (${items} pieces for 3 strokes)`);

  // A guesser drops out and comes back: they get the whole drawing again.
  await G2.evaluate(() => window.__kit.disconnect());
  await D.evaluate(() => window.__doodle.draw([100, 100, 120, 140]));
  await G2.evaluate(() => window.__kit.reconnect());
  ok(await wait(G2, () => window.__kit.status === 'connected' && window.__doodle.paper.strokes.length === 4, null, 10000), 'a player who reconnects gets the whole drawing');
  // Undo and clear reach everyone.
  await D.click('#d-undo');
  ok(await wait(G2, () => window.__doodle.paper.strokes.length === 3), 'Undo takes the last stroke away for everyone');
  await D.screenshot({ path: `${out}/doodle-drawer.png` }); await G1.screenshot({ path: `${out}/doodle-guesser.png` });

  // Guesses: a wrong one everyone sees, a close one only its guesser sees, then a right one.
  await G1.fill('#d-guess', 'definitely not it'); await G1.press('#d-guess', 'Enter');
  ok(await wait(G2, () => /definitely not it/.test(document.getElementById('d-chat').textContent)), 'a wrong guess shows in everyone\'s chat');
  const close = word.slice(0, -1) + (word.at(-1) === 'z' ? 'y' : 'z');
  await G1.fill('#d-guess', close); await G1.press('#d-guess', 'Enter');
  ok(await wait(G1, () => /close!/.test(document.getElementById('d-chat').textContent)), 'a nearly-right guess tells its guesser "close!"');
  await G2.waitForTimeout(500);
  ok(!(await G2.textContent('#d-chat')).includes(close), 'and nobody else sees it (it would give the word away)');
  await G1.fill('#d-guess', word.toUpperCase()); await G1.press('#d-guess', 'Enter');
  ok(await wait(G1, () => window.__kit.info.view.word !== '' && document.getElementById('d-guess').disabled), 'the right guess: the guesser sees the word and is done guessing');
  ok(await wait(G2, () => /got it!/.test(document.getElementById('d-chat').textContent)), 'everyone sees who got it');
  const g1Seat = await G1.evaluate(() => window.__kit.info.me);
  ok((await view(G2)).scores[g1Seat] > 0 && (await view(G2)).word === '', 'they score, and the word still hides from the others');

  // The last guesser gets it: the turn ends and the word shows for everyone.
  await G2.fill('#d-guess', word); await G2.press('#d-guess', 'Enter');
  ok(await wait(D, () => window.__kit.info.view.phase === 'reveal'), 'once everyone has it, the turn ends');
  ok(await wait(G2, (w) => document.getElementById('d-cover').textContent.includes(w), word), 'and everyone sees the word');
  ok((await view(D)).scores[drawerSeat] === 100, 'the drawer scores for each player who got it');

  // The pen moves on to someone else, with a fresh page.
  await H.evaluate(() => window.__kit.dev('skip'));
  ok(await wait(H, (d) => window.__kit.info.view.phase === 'pick' && window.__kit.info.view.drawer !== d, drawerSeat), 'the next player draws');
  ok(await wait(G1, () => window.__doodle.paper.strokes.length === 0), 'on a clean page');

  // Skip through the rest (3 players draw twice each): the game ends with a winner, then everyone plays again.
  for (let i = 0; i < 30 && !(await H.evaluate(() => !!window.__kit.info.over)); i++) { await H.evaluate(() => window.__kit.dev('skip')); await H.waitForTimeout(150); }
  ok(await wait(B, () => !document.getElementById('over').hidden), 'after everyone has drawn twice, the game ends');
  ok(/1\. /.test(await B.textContent('#over-text')), `with the scores (${await B.textContent('#over-title')}: ${await B.textContent('#over-text')})`);
  for (const p of all) await p.click('#rematch');
  ok(await wait(H, () => !window.__kit.info.over && window.__kit.info.view.phase === 'pick' && window.__kit.info.view.turn === 1), 'Play again starts a new game');
};
