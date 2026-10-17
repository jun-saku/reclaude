// End-to-end test, run by ../e2e.cjs (see there). Two players in a real-time Tanks room on the real Firebase SDK +
// emulator: lobby, live tank positions, the lead's enemies and waves, a player leaving, game over and saving a score.
module.exports = async ({ page, ok, BASE, out }) => {
  const URL = BASE + 'tanks/?backend=emulator';
  const wait = (p, fn, arg, ms = 10000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const H = await page(URL); await H.fill('#my-name', 'Jun'); await H.click('#create');
  await H.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const code = (await H.textContent('#waiting-code')).trim();
  const P = await page(URL); await P.fill('#my-name', 'Bo'); await P.fill('#join-code', code); await P.click('#join');
  await P.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  ok(await wait(H, () => !document.getElementById('start-btn').disabled), 'the host can start once a friend joins');
  ok(await P.isHidden('#start-btn'), 'only the host has a Start button');
  await H.click('#start-btn');
  ok(await wait(P, () => window.__tanks.room?.status === 'playing' && !document.getElementById('play').hidden), 'both players are in the game');
  ok(await wait(H, () => window.__tanks.lead), 'the host leads (runs the enemies)');

  // P drives up: the host sees P's tank move through the live slots.
  const startY = await P.evaluate(() => window.__tanks.me.y);
  await P.evaluate(() => window.__tanks.hold(0)); await P.waitForTimeout(800); await P.evaluate(() => window.__tanks.hold(null));
  const py = await P.evaluate(() => window.__tanks.me.y);
  ok(py < startY - 8, `P's own tank drives straight away (${startY} → ${py})`);
  ok(await wait(H, (y) => { const o = window.__tanks.others[1]; return o && o.present && Math.abs(o.y - y) < 1.5; }, py), "the host sees P's tank where it is");

  // Enemies come from the lead and show up for P.
  ok(await wait(P, () => window.__tanks.enemies.length > 0, null, 12000), 'enemies run by the lead appear for the other player');
  // P's hit (as reported by P's own shell) counts on the lead: the enemy goes, for both.
  const target = await P.evaluate(() => { const e = window.__tanks.enemies.find((x) => x.hp === 1); if (!e) return null; for (let i = 0; i < e.hp; i++) window.__tanks.report('e', e.id); return e.id; });
  ok(target !== null && await wait(H, (id) => !window.__tanks.enemies.some((e) => e.id === id) && window.__tanks.header.kills >= 1, target), `a hit by P destroys the enemy on the lead (enemy ${target})`);
  ok(await wait(P, (id) => !window.__tanks.enemies.some((e) => e.id === id) && window.__tanks.header.kills >= 1, target), 'and P sees the kill counted');
  const lens = await H.evaluate(() => window.__tanks.encodeMine().length);
  ok(lens <= 256, `the lead's live update fits in a slot (${lens} characters)`);

  // The lead clears the wave: the next wave reaches P through the room.
  await H.evaluate(() => window.__tanks.clearWave());
  ok(await wait(P, () => window.__tanks.wave === 2 && window.__tanks.room.state.wave === 2), 'a cleared wave starts wave 2 for everyone');

  // The host's screen goes off: its game loop stops (a page in the background gets no animation frames) while its
  // timers may still run. The game mustn't freeze for P: P takes the lead and the enemies keep moving.
  await H.evaluate(() => { window.requestAnimationFrame = () => 0; });
  ok(await wait(P, () => window.__tanks.lead, null, 12000), "when the host's game stops, P takes the lead");
  const moving = await P.evaluate(async () => {
    const at = () => JSON.stringify(window.__tanks.enemies.map((e) => [e.id, Math.round(e.x), Math.round(e.y)]));
    for (let i = 0; i < 40 && !window.__tanks.enemies.length; i++) await new Promise((r) => setTimeout(r, 250));
    const a = at(); await new Promise((r) => setTimeout(r, 1500));
    return window.__tanks.enemies.length > 0 && at() !== a;
  });
  ok(moving, 'and the enemies keep moving for P');

  // The host leaves: the game goes on and P takes the lead.
  await H.click('#leave');
  ok(await wait(P, () => window.__tanks.lead && window.__tanks.room.status === 'playing', null, 12000), 'when the host leaves, the game goes on and P leads');
  ok(await wait(P, () => window.__tanks.enemies.length > 0, null, 12000), 'the new lead keeps the enemies coming');

  // Game over (the eagle falls), then P saves the team's score.
  await P.evaluate(() => window.__tanks.dropBase());
  ok(await wait(P, () => window.__tanks.room.status === 'done' && !document.getElementById('over').hidden, null, 8000), 'the eagle falling ends the game');
  const text = await P.textContent('#over-text');
  ok(/cleared 1 wave/.test(text), `the result counts waves cleared (${text})`);
  await P.click('#save-btn');
  ok(await wait(P, () => /Saved/.test(document.getElementById('save-msg').textContent), null, 10000), `the score saves to the Top 10 (${await P.textContent('#save-msg')})`);
  await P.screenshot({ path: `${out}/tanks-over.png` });
};
