// End-to-end test, run by ../e2e.cjs: a full Doodle Guess room (10 players, some long names) still fits a phone: the
// waiting room lists everyone in two columns with Start on screen, each player has their own colour, and in the game
// the player bar is one row that scrolls sideways (the drawer brought into view) instead of rows pushing the paper down.
module.exports = async ({ page, ok, BASE, out }) => {
  const URL = BASE + 'doodle/?backend=emulator';
  const names = ['Jun', 'Bartholomew', 'Cy', 'Daniela', 'Eve', 'Francesca', 'Gus', 'Hiroshi', 'Ivy', 'Jo-Anne Lee'];
  const wait = (p, fn, arg, ms = 15000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const H = await page(URL); await H.fill('#my-name', names[0]); await H.click('#create');
  await H.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const code = (await H.textContent('#waiting-code')).trim();
  const ps = [H];
  for (const n of names.slice(1)) { const p = await page(URL); await p.fill('#my-name', n.slice(0, 12)); await p.fill('#join-code', code); await p.click('#join'); await p.waitForSelector('#waiting:not([hidden])', { timeout: 15000 }); ps.push(p); }
  await wait(H, () => /10 of 10/.test(document.body.textContent));
  for (const w of [390, 320]) { await H.setViewportSize({ width: w, height: 820 }); await H.screenshot({ path: `${out}/crowd-lobby-${w}.png`, fullPage: true }); }
  const lobby = await H.evaluate(() => {
    const colours = new Set([...document.querySelectorAll('#seated .chip')].map((c) => getComputedStyle(c.querySelector('.disc')).backgroundColor));
    const start = document.getElementById('start-btn').getBoundingClientRect();
    return { colours: colours.size, startOnScreen: start.bottom <= innerHeight, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  });
  ok(lobby.colours === 10, `ten players, ten colours (${lobby.colours})`);
  ok(lobby.startOnScreen && !lobby.sideways, 'the waiting room fits a 320 px phone: Start on screen, no sideways scroll');
  await H.click('#start-btn');
  for (const p of ps) await wait(p, () => window.__kit.info?.view?.phase === 'pick');
  const v = await H.evaluate(() => window.__kit.info.view);
  const D = ps[await Promise.all(ps.map((p) => p.evaluate(() => window.__kit.info.me))).then((s) => s.indexOf(v.drawer))];
  await D.click('[data-pick="0"]');
  const G = ps.find((p) => p !== D);
  await wait(G, () => window.__kit.info.view.phase === 'draw');
  for (const w of [390, 320]) { await G.setViewportSize({ width: w, height: 820 }); await G.waitForTimeout(300); await G.screenshot({ path: `${out}/crowd-game-${w}.png`, fullPage: true }); }
  const word = (await D.evaluate(() => window.__kit.info.view.word));
  for (const p of ps) if (p !== D) { await p.fill('#d-guess', word); await p.press('#d-guess', 'Enter'); }
  await wait(G, () => window.__kit.info.view.phase === 'reveal');
  await G.setViewportSize({ width: 320, height: 760 }); await G.waitForTimeout(400);
  await G.screenshot({ path: `${out}/crowd-reveal-320.png` });
  const bar = await G.evaluate(() => { const b = document.getElementById('players'); return { rows: Math.round(b.getBoundingClientRect().height), scrolls: b.scrollWidth > b.clientWidth, page: document.documentElement.scrollWidth <= document.documentElement.clientWidth }; });
  ok(bar.rows < 50 && bar.scrolls && bar.page, `in the game the player bar is one row that scrolls sideways, the page doesn't (${JSON.stringify(bar)})`);
  ok(await G.evaluate(() => { const b = document.getElementById('players'), on = b.querySelector('.turn'); if (!on) return true; const r = on.getBoundingClientRect(), br = b.getBoundingClientRect(); return r.left >= br.left - 1 && r.right <= br.right + 1; }), "whoever's drawing is in view in the bar");
};
