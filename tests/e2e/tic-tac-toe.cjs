// End-to-end test, run by ../e2e.cjs (see there). Gets the shared helpers; plays on the real Firebase SDK + emulator.
module.exports = async ({ page, ok, statusIs, BASE, out }) => {
  // ---- Tic-tac-toe on real Firebase ----
  const TT = BASE + 'tic-tac-toe/?backend=emulator';
  const X = await page(TT);
  await X.click('#create'); await X.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const tcode = (await X.textContent('#waiting-code')).trim();
  const O = await page(TT);
  await O.fill('#join-code', tcode.toLowerCase()); await O.click('#join');
  await O.waitForSelector('#board:not([hidden])', { timeout: 15000 });
  ok(await statusIs(X, 'Your turn'), `tic-tac-toe: room ${tcode}, friend joined by typing the code`);
  for (const [p, i, w] of [[X,4,O],[O,0,X],[X,2,O],[O,1,X]]) { await p.click(`.cell[data-i="${i}"]`); await statusIs(w, 'Your turn'); }
  await X.click('.cell[data-i="6"]');
  ok(await statusIs(X, 'You win! 🎉') && await statusIs(O, 'Friend wins'), 'X wins the diagonal on both phones');
};
