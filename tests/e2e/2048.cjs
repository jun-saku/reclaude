// End-to-end test, run by ../e2e.cjs (see there). Gets the shared helpers; plays on the real Firebase SDK + emulator.
module.exports = async ({ page, ok, statusIs, BASE, out }) => {
  // ---- 2048 leaderboard on real Firebase ----
  const G = BASE + '2048/?backend=emulator';
  const names = (p) => p.$$eval('#leader-list li', (lis) => lis.map((li) => [...li.children].map((c) => c.textContent).join(' ')));
  const shown = (p, sel) => p.evaluate((sel) => getComputedStyle(document.querySelector(sel)).display !== 'none', sel);
  const openTop = async (p) => { await p.click('#trophy'); await p.waitForFunction(() => !document.getElementById('leaders-reload').disabled, null, { timeout: 15000 }); };
  const closeTop = (p) => p.click('#leaders-close');
  const lose = (p, s) => p.evaluate((s) => { window.__2048.setSpawn(false); window.__2048.setGrid([[2,4,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,8]], s); }, s);
  const saveAs = async (p, name) => { await p.fill('#save-name', name); await p.click('#save-btn'); await p.waitForFunction(() => !/Saving/.test(document.getElementById('save-msg').textContent) && document.getElementById('save-msg').textContent, null, { timeout: 8000 }); return p.textContent('#save-msg'); };

  const P = await page(G);
  await P.waitForTimeout(1500);
  ok(await P.evaluate(async () => (await window.__2048.leaderboard()).top === null) && await P.evaluate(() => window.__2048.rooms()) === null,
    'nothing connects to Firebase until the 🏆 is tapped');
  ok(!(await shown(P, '#save-form')), 'no save form during play');
  await openTop(P);
  ok((await P.textContent('#leaders-status')) === 'No scores yet. Be the first!', 'opening 🏆 fetches the Top 10 (empty)');
  await closeTop(P);

  await lose(P, 1840);
  ok(await shown(P, '#save-form') && (await P.textContent('#save-btn')) === 'Save 1,840', 'losing shows a name box and "Save 1,840" on the game-over screen');
  await P.click('#save-name');
  const before = await P.evaluate(() => JSON.stringify(window.__2048.grid()));
  await P.keyboard.type('Jun wasd');
  ok(await P.evaluate(() => JSON.stringify(window.__2048.grid())) === before, 'typing a name (incl. w/a/s/d) does not move tiles');
  const m1 = await saveAs(P, '<b>Jun</b>!!');
  ok(m1.startsWith('Saved 1,840 as bJunb'), `saved through the real rules; name cleaned of symbols (${m1})`);
  ok(!(await shown(P, '#save-form')), 'the save form goes away once saved');
  await openTop(P);
  const n1 = await names(P);
  ok(n1.length === 1 && n1[0] === '1. bJunb 1,840' && await P.$eval('#leader-list li', (li) => li.classList.contains('me')), 'the 🏆 shows the new entry, highlighted as yours');
  await closeTop(P);

  const Q = await page(G);
  await openTop(Q);
  ok((await names(Q))[0] === '1. bJunb 1,840', 'another player sees it');
  await closeTop(Q);
  await lose(Q, 3000);
  ok((await saveAs(Q, 'Bo')).startsWith('Saved 3,000'), 'another player saves a higher score');
  await openTop(P);
  ok(JSON.stringify(await names(P)) === JSON.stringify(['1. bJunb 1,840']), 'the open sheet keeps what it fetched…');
  await P.click('#leaders-reload');
  await P.waitForFunction(() => document.querySelectorAll('#leader-list li').length === 2, null, { timeout: 8000 });
  ok(JSON.stringify(await names(P)) === JSON.stringify(['1. Bo 3,000', '2. bJunb 1,840']), '…and Reload fetches the new standings, best first');
  await closeTop(P);

  await P.click('button[data-action="new"]');
  await lose(P, 500);
  const low = await saveAs(P, 'Jun');
  ok(low.includes('already higher'), `saving a lower score is refused with a clear message (${low.slice(0, 50)}…)`);
  await P.waitForTimeout(5200);
  await P.click('button[data-action="new"]');
  await lose(P, 2500);
  ok((await saveAs(P, 'Jun')).startsWith('Saved 2,500'), 'a higher score replaces your entry');
  await P.click('button[data-action="new"]');
  await lose(P, 2600);
  const quick = await saveAs(P, 'Jun');
  ok(quick.includes('a few seconds ago'), 'saving again within 5 seconds is refused, with a clear message');
  ok(await P.evaluate(() => [99999998, 1001, -2, 0].every((n) => !window.__2048.validScore(n)) && window.__2048.validScore(2600)), '2048 itself refuses impossible scores (over the maximum, odd, negative, zero)');
  await lose(P, 1001);
  ok((await saveAs(P, 'Jun')).includes("isn't a possible 2048 score"), "an impossible score on the board isn't saved, with a clear message");
  // A Reload tapped just after a fetch must not be cut off by that fetch's delayed disconnect (1.5 s later):
  // slow the next fetch down so it is still running when the disconnect would fire.
  await openTop(P); await P.waitForTimeout(1200);
  await P.evaluate(async () => { const b = await (await window.__2048.rooms()).__test.backend(); const real = b.topScores.bind(b); b.topScores = async (...a) => { await new Promise((r) => setTimeout(r, 600)); return real(...a); }; });
  await P.click('#leaders-reload');
  ok(await P.waitForFunction(() => !document.getElementById('leaders-reload').disabled, null, { timeout: 6000 }).then(() => true).catch(() => false)
    && (await names(P)).length === 2, 'a Reload right after a fetch still loads (not cut off by the earlier disconnect)');
  await P.screenshot({ path: `${out}/e2e-2048-sheet.png` });
  await P.mouse.click(195, 30);
};
