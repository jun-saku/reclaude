// End-to-end test, run by ../e2e.cjs: Doodle Guess played for real, many times. Two rooms at once (2 and 4 players)
// each play three whole games in a row (Play again); a 5-player room draws once each; a player leaves mid-game on
// their own turn. Every turn the drawer really picks and draws and the others really guess; only the few seconds of
// the end-of-turn reveal are skipped. All players must agree on everything, every turn.
module.exports = async ({ page, ok, BASE }) => {
  const URL = BASE + 'doodle/?backend=emulator';
  const wait = (p, fn, arg, ms = 12000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const view = (p) => p.evaluate(() => window.__kit.info?.view);
  const plain = (p) => p.evaluate(() => window.__doodle.paper.strokes.map((s) => {
    const out = [];
    for (let i = 0; i < s.pts.length; i += 2) if (out.at(-2) !== s.pts[i] || out.at(-1) !== s.pts[i + 1]) out.push(s.pts[i], s.pts[i + 1]);
    return out.join(',');
  }).join('/'));

  async function room(names) {
    const H = await page(URL); await H.fill('#my-name', names[0]); await H.click('#create');
    await H.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
    const code = (await H.textContent('#waiting-code')).trim();
    const ps = [H];
    for (const n of names.slice(1)) {
      const p = await page(URL); await p.fill('#my-name', n); await p.fill('#join-code', code); await p.click('#join');
      await p.waitForSelector('#waiting:not([hidden])', { timeout: 15000 }); ps.push(p);
    }
    await wait(H, (n) => document.getElementById('start-btn').textContent === `Start with ${n} players`, names.length);
    await H.click('#start-btn');
    for (const p of ps) await wait(p, () => window.__kit.status === 'connected' && !!window.__kit.info?.view, null, 15000);
    return { ps, code, label: `${names.length}-player room` };
  }

  // Plays one whole game in this room; `leaveOn` (a turn number): that turn's drawer taps Leave instead of drawing.
  async function playGame(r, { leaveOn = 0 } = {}) {
    let ps = r.ps, turns = 0, problems = [], lastTurn = 0;
    const seatOf = new Map();
    for (const p of ps) seatOf.set(p, await p.evaluate(() => window.__kit.info.me));
    const expected = ps.length * (ps.length <= 4 ? 2 : 1);
    for (let guard = 0; guard < 40; guard++) {
      const H = ps[0];
      // The next turn starts (or the game ends).
      const next = await wait(H, (t) => { const i = window.__kit.info; return !!i.over || (i.view.phase === 'pick' && i.view.turn > t); }, lastTurn, 15000);
      if (!next) { problems.push(`turn ${lastTurn + 1} never started (phase ${(await view(H))?.phase})`); break; }
      if (await H.evaluate(() => !!window.__kit.info.over)) break;
      const v = await view(H);
      lastTurn = v.turn; turns++;
      const views = await Promise.all(ps.map(view));
      if (!views.every((x) => x.drawer === v.drawer && x.turn === v.turn)) problems.push(`turn ${v.turn}: players disagree on who draws`);
      const D = ps.find((p) => seatOf.get(p) === v.drawer);
      if (!D) { problems.push(`turn ${v.turn}: the drawer isn't here`); break; }
      if (v.turn === leaveOn) {
        // The drawer walks away while picking: their turn ends, the game goes on without them.
        await D.click('#leave');
        ps = ps.filter((p) => p !== D);
        if (!(await wait(ps[0], () => ['reveal', 'pick'].includes(window.__kit.info.view.phase) && window.__kit.info.view.phase !== 'draw'))) problems.push('leaving mid-turn didn\'t end the turn');
        await ps[0].evaluate(() => window.__kit.dev('skip'));
        continue;
      }
      await D.click('[data-pick="1"]');
      if (!(await wait(D, () => window.__kit.info.view.phase === 'draw' && !!window.__kit.info.view.word))) { problems.push(`turn ${v.turn}: couldn't start drawing`); continue; }
      const word = (await view(D)).word;
      // Draw a couple of strokes, a little different each turn.
      const k = v.turn * 7;
      await D.evaluate((k) => { window.__doodle.draw([10 + k, 20, 80, 90 + k, 150, 40, 200, 200]); const l = []; for (let i = 0; i < 90; i++) l.push(20 + i * 2, 128 + Math.round(40 * Math.sin((i + k) / 8))); window.__doodle.draw(l); }, k);
      const guessers = ps.filter((p) => p !== D);
      const drawn = await plain(D);
      for (const g of guessers) if (!(await wait(g, (n) => window.__doodle.paper.strokes.length === n, 2))) problems.push(`turn ${v.turn}: a guesser didn't get the drawing`);
      await guessers[0].waitForTimeout(300);
      for (const g of guessers) if ((await plain(g)) !== drawn) problems.push(`turn ${v.turn}: a guesser's drawing differs`);
      for (const g of guessers) if ((await view(g)).word !== '') problems.push(`turn ${v.turn}: a guesser could see the word`);
      // One wrong guess, then everyone gets it.
      await guessers[0].fill('#d-guess', 'zzz nope'); await guessers[0].press('#d-guess', 'Enter');
      for (const g of guessers) { await g.fill('#d-guess', word); await g.press('#d-guess', 'Enter'); }
      if (!(await wait(H, () => window.__kit.info.view.phase === 'reveal'))) problems.push(`turn ${v.turn}: the turn didn't end once everyone had it`);
      // Everyone's phone catches up (an update or two) to the same scores.
      const want = await H.evaluate(() => JSON.stringify(window.__kit.info.view.scores));
      for (const p of ps) if (!(await wait(p, (w) => JSON.stringify(window.__kit.info.view.scores) === w, want, 3000))) problems.push(`turn ${v.turn}: players see different scores`);
      await H.evaluate(() => window.__kit.dev('skip')); // past the reveal
    }
    // Game over: everyone sees the same result; the scores add up.
    const overs = await Promise.all(ps.map((p) => wait(p, () => !document.getElementById('over').hidden, null, 8000)));
    if (!overs.every(Boolean)) problems.push('not everyone saw the game end');
    const res = await ps[0].evaluate(() => window.__kit.info.over);
    const texts = new Set(await Promise.all(ps.map((p) => p.textContent('#over-text'))));
    const totalTurns = leaveOn ? turns : expected;
    ok(problems.length === 0 && turns === totalTurns && texts.size >= 1, `${r.label}: a whole game, ${turns} turns (${problems.join('; ') || 'every turn agreed'}) — ${await ps[0].textContent('#over-title')} ${[...texts][0]}`);
    r.ps = ps;
    return res;
  }
  async function again(r) {
    for (const p of r.ps) await p.click('#rematch');
    return wait(r.ps[0], () => { const i = window.__kit.info; return !i.over && i.view.turn === 1 && Object.values(i.view.scores).every((s) => s === 0); }, null, 10000);
  }

  // Two rooms at once, three games each.
  const A = await room(['Ann', 'Ben']), B = await room(['Cat', 'Dan', 'Eve', 'Fay']);
  ok(A.code !== B.code, `two rooms at once (${A.code}, ${B.code})`);
  for (let game = 1; game <= 3; game++) {
    await Promise.all([playGame(A), playGame(B)]);
    if (game < 3) ok(await again(A) && await again(B), `Play again: game ${game + 1} starts fresh in both rooms`);
  }
  // A 5-player room: each draws once; on the third turn that turn's drawer leaves.
  const C = await room(['Gus', 'Hal', 'Ivy', 'Jo', 'Kim']);
  await playGame(C, { leaveOn: 3 });
  ok(C.ps.length === 4, 'the player who left is gone, the other four finished the game');
};
