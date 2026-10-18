// End-to-end test, run by ../e2e.cjs (see there). Two players in a Tanks room (a game kit game, shared/kit.js): the lobby on the real Firebase SDK +
// emulator, the game on the game server (worker/, run locally): tanks, enemies, waves, a player going away without
// pausing anyone, coming back, game over, Play again and saving a score.
module.exports = async ({ page, ok, BASE, out }) => {
  const URL = BASE + 'tanks/?backend=emulator';
  const wait = (p, fn, arg, ms = 10000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const enemyAt = (p) => p.evaluate(() => JSON.stringify(window.__tanks.world()?.enemies.map((e) => [e.id, Math.round(e.x), Math.round(e.y)])));
  const H = await page(URL); await H.fill('#my-name', 'Jun'); await H.click('#create');
  await H.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const code = (await H.textContent('#waiting-code')).trim();
  const P = await page(URL); await P.fill('#my-name', 'Bo'); await P.fill('#join-code', code); await P.click('#join');
  await P.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  ok(await wait(H, () => !document.getElementById('start-btn').disabled), 'the host can start once a friend joins');
  ok(await P.isHidden('#start-btn'), 'only the host has a Start button');
  await H.click('#start-btn');
  ok(await wait(H, () => window.__kit.status === 'connected') && await wait(P, () => window.__kit.status === 'connected'), 'both players connect to the game server');
  ok(await wait(P, () => Object.keys(window.__kit.latest?.v.tanks || {}).length === 2), 'the server has both tanks');

  // P drives up: P's own tank moves straight away, and the host sees it through the server.
  await wait(P, () => window.__tanks.me?.alive);
  const startY = await P.evaluate(() => window.__tanks.me.y);
  await P.evaluate(() => window.__tanks.hold(0)); await P.waitForTimeout(800); await P.evaluate(() => window.__tanks.hold(null));
  const py = await P.evaluate(() => window.__tanks.me.y);
  ok(py < startY - 8, `P's own tank drives straight away (${startY} → ${py})`);
  ok(await wait(H, (y) => { const t = window.__tanks.world().tanks.find((x) => x.seat === 1); return t && Math.abs(t.y - y) < 1; }, py), "the host sees P's tank where it is");

  // Enemies come from the server, the same for both players.
  ok(await wait(P, () => window.__tanks.world().enemies.length > 0, null, 12000), 'enemies appear for both players');
  await H.waitForTimeout(300);
  const [he, pe] = await Promise.all([H.evaluate(() => window.__tanks.world().enemies), P.evaluate(() => window.__tanks.world().enemies)]);
  const near = he.length === pe.length && he.every((e) => { const o = pe.find((x) => x.id === e.id); return o && Math.hypot(o.x - e.x, o.y - e.y) < 4; });
  ok(near, `both players see the same enemies in the same places (${he.length} / ${pe.length})`);

  // P's shell is the server's: firing straight up from P's spot hits bricks or flies off; the server counts it.
  await P.evaluate(() => window.__tanks.fire(true)); await P.waitForTimeout(400); await P.evaluate(() => window.__tanks.fire(false));
  ok(await wait(H, () => window.__tanks.world().shells.length > 0 || window.__kit.latest.v.bo.length > 0, null, 3000), "P's shot shows up for the host");

  // P goes away (screen off, signal lost): the game carries on for the host, without a pause.
  await P.evaluate(() => window.__kit.disconnect());
  ok(await wait(H, () => !window.__kit.latest.v.tanks[1], null, 8000), "when P goes away, P's tank leaves the field for the host");
  const a = await enemyAt(H); await H.waitForTimeout(1500); const b = await enemyAt(H);
  ok(a !== b, 'and the enemies keep moving for the host (no pause)');
  await P.evaluate(() => window.__kit.reconnect());
  ok(await wait(P, () => window.__kit.status === 'connected' && window.__tanks.me?.alive) && await wait(H, () => !!window.__kit.latest.v.tanks[1]), 'P comes back into the same game');

  // The wave is cleared: wave 2 for everyone.
  await H.evaluate(() => window.__kit.dev('clear'));
  ok(await wait(P, () => window.__tanks.world().wave === 2) && await wait(H, () => window.__tanks.world().wave === 2), 'a cleared wave starts wave 2 for everyone');

  // The host leaves: the game goes on for P.
  await H.click('#leave');
  ok(await wait(P, () => !window.__kit.latest.v.tanks[0], null, 8000), "when the host leaves, the host's tank goes");
  ok(await wait(P, () => window.__tanks.world().enemies.length > 0, null, 12000), 'and the game goes on for P');

  // Game over (the eagle falls), then P saves the team's score and starts again.
  await P.evaluate(() => window.__kit.dev('base'));
  ok(await wait(P, () => !!window.__kit.latest.over && !document.getElementById('over').hidden, null, 8000), 'the eagle falling ends the game');
  const text = await P.textContent('#over-text');
  ok(/cleared 1 wave/.test(text), `the result counts waves cleared (${text})`);
  await P.click('#save-btn');
  ok(await wait(P, () => /Saved/.test(document.getElementById('save-msg').textContent), null, 10000), `the score saves to the Top 10 (${await P.textContent('#save-msg')})`);
  await P.screenshot({ path: `${out}/tanks-over.png` });
  await P.click('#rematch');
  ok(await wait(P, () => !window.__kit.latest.over && window.__tanks.world().wave === 1 && window.__tanks.me?.alive && document.getElementById('over').hidden), 'Play again starts a new game');
};
