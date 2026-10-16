// End-to-end test, run by ../e2e.cjs (see there). Gets the shared helpers; plays on the real Firebase SDK + emulator.
module.exports = async ({ page, ok, statusIs, BASE, out }) => {
  // ---- Bridge on real Firebase: 2 friends as partners, computers in the other seats run by the host ----
  const BR = BASE + 'bridge/?backend=emulator';
  const H1 = await page(BR); await H1.click('#create'); await H1.waitForSelector('#lobby:not([hidden])', { timeout: 15000 });
  const bcode = (await H1.textContent('#lobby-code')).trim();
  const H2 = await page(BR + '&room=' + bcode); await H2.waitForSelector('#lobby:not([hidden])', { timeout: 15000 });
  await H1.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 8000 });
  await H1.click('#start');
  for (const P of [H1, H2]) await P.waitForFunction(() => window.__br.G, null, { timeout: 15000 });
  ok(JSON.stringify(await H2.evaluate(() => window.__br.G.owner)) === '[1,-1,0,-1]', `bridge: room ${bcode}, the guest sits North opposite the host`);
  // Whoever must act (a person, or the host for the computers) plays the computer's choice.
  let bmoves = 0, bstuck = 0;
  for (; bmoves < 400 && bstuck < 60; ) {
    const st = await Promise.all([H1, H2].map((P) => P.evaluate(() => ({ s: window.__br.room.status, mine: window.__br.myTurn(), k: window.__br.G.played.length + window.__br.G.auction.length }))));
    if (st[0].s === 'done' && st[1].s === 'done') break;
    const i = st.findIndex((x) => x.mine);
    if (i < 0) { bstuck++; await H1.waitForTimeout(250); continue; }
    bstuck = 0;
    await [H1, H2][i].evaluate(async () => { const B = window.__br, G = B.G; await B.act(G.phase === 'bidding' ? 'call' : 'play', G.phase === 'bidding' ? B.botCall(G, G.turn) : B.botPlay(G, G.turn)); });
    await [H1, H2][i].waitForFunction((k) => { const G = window.__br.G; return G.played.length + G.auction.length !== k || G.board > 1; }, st[i].k, { timeout: 8000 }).catch(() => {});
    bmoves++;
  }
  const bg = await Promise.all([H1, H2].map((P) => P.evaluate(() => [window.__br.room.status, window.__br.G.phase, JSON.stringify(window.__br.G.totals)])));
  ok(bg[0][0] === 'done' && bg[0][1] === 'done' && bg[0][2] === bg[1][2], `a whole deal is played through the rules (${bmoves} moves by people, totals ${bg[0][2]})`);
  const bsneak = await H2.evaluate(async (c) => {
    const b = await window.__br.rooms.__test.backend();
    try { const r = await b.transact(c, (cur) => cur ? { ...cur, state: { g: 'x' } } : null); return r.committed ? 'written' : 'aborted'; }
    catch (e) { return 'denied: ' + e.message; }
  }, bcode);
  ok(bsneak.startsWith('denied'), `a finished deal can't be rewritten (${bsneak.slice(0, 40)})`);
  for (const P of [H1, H2]) { await P.evaluate(() => document.getElementById('hint').click()); await P.waitForTimeout(300); }
  ok(await H2.waitForFunction(() => window.__br.room.status === 'playing' && window.__br.G.board === 2, null, { timeout: 8000 }).then(() => true).catch(() => false), 'next deal starts once both tapped, totals carried over');
  await H2.screenshot({ path: `${out}/e2e-bridge.png` });
};
