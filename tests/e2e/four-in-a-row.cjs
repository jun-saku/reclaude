// End-to-end test, run by ../e2e.cjs (see there). Gets the shared helpers; plays on the real Firebase SDK + emulator.
module.exports = async ({ page, ok, statusIs, BASE, out }) => {
  // ---- Four in a Row on real Firebase ----
  const C4 = BASE + 'four-in-a-row/?backend=emulator';
  const A = await page(C4);
  await A.click('#create'); await A.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const code = (await A.textContent('#waiting-code')).trim();
  ok(/^[A-HJ-NP-Z2-9]{4}$/.test(code), `four-in-a-row: room ${code} created through the real rules`);
  const B = await page(`${C4}&room=${code}`);
  await B.waitForSelector('#board:not([hidden])', { timeout: 15000 });
  ok(await statusIs(A, 'Your turn') && await statusIs(B, "Friend's turn…"), 'joined by link; Red to move on both phones');
  const drop = async (p, c) => { await p.click(`.slot[data-i="${c}"]`); };
  for (const [p, c, waitP, t] of [[A,0,B,'Your turn'],[B,1,A,'Your turn'],[A,0,B,'Your turn'],[B,1,A,'Your turn'],[A,0,B,'Your turn'],[B,1,A,'Your turn']]) {
    await drop(p, c); await statusIs(waitP, t);
  }
  await drop(A, 0);
  ok(await statusIs(A, 'You win! 🎉') && await statusIs(B, 'Friend wins'), 'moves sync both ways and the win shows on both phones');
  await B.click('#rematch');
  ok(await A.waitForFunction(() => document.getElementById('rematch').textContent.includes('friend is ready'), null, { timeout: 8000 }).then(() => true).catch(() => false) && await B.$eval('#rematch', (b) => b.disabled), 'play again waits for both: Red sees Yellow is ready, Yellow waits');
  await A.click('#rematch');
  ok(await statusIs(B, 'Your turn') && await statusIs(A, "Friend's turn…"), 'play again: Yellow starts round 2 once both tapped');
  const C = await page(C4);
  await C.fill('#join-code', code); await C.click('#join');
  await C.waitForFunction(() => document.getElementById('home-error').textContent.length > 0, null, { timeout: 8000 });
  ok((await C.textContent('#home-error')).includes('That room is full'), 'a third player is turned away');
  // A non-player tries to write to the room directly: the rules must refuse
  const sneak = await C.evaluate(async (code) => {
    const b = await window.__c4.rooms.__test.backend();
    try { const r = await b.transact(code, (cur) => cur ? { ...cur, board: 'x'.repeat(42) } : null); return r.committed ? 'written' : 'aborted'; }
    catch (e) { return 'denied: ' + e.message; }
  }, code);
  ok(sneak.startsWith('denied'), `a non-player can't change the board (${sneak.slice(0, 40)})`);
  await A.reload(); await A.waitForSelector('#board:not([hidden])', { timeout: 15000 });
  ok(await statusIs(A, "Friend's turn…"), 'reload: Red rejoins the same seat');
  // Red is seated but it's Yellow's turn: the rules must refuse Red's write
  const early = await A.evaluate(async (code) => {
    const b = await window.__c4.rooms.__test.backend();
    try { const r = await b.transact(code, (cur) => cur ? { ...cur, board: 'x'.repeat(42) } : null); return r.committed ? 'written' : 'aborted'; }
    catch (e) { return 'denied: ' + e.message; }
  }, code);
  ok(early.startsWith('denied'), `a player can't change the board on the other player's turn (${early.slice(0, 40)})`);
  await A.screenshot({ path: `${out}/e2e-c4.png` });
  // Red leaves mid-game (confirming the dialog): Yellow is told and wins the round
  A.once('dialog', (d) => d.accept());
  await A.click('#leave'); await A.waitForSelector('#home:not([hidden])', { timeout: 8000 });
  ok(await statusIs(B, 'Your friend left. You win 🎉'), 'leaving mid-game forfeits; the friend sees it');
  ok(await B.waitForFunction(() => document.getElementById('rematch').hidden, null, { timeout: 8000 }).then(() => true).catch(() => false), 'play again waits until the friend is back');
  // A waiting room is deleted when its host leaves it
  const Z = await page(C4);
  await Z.click('#create'); await Z.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const zcode = (await Z.textContent('#waiting-code')).trim();
  await Z.click('#leave'); await Z.waitForSelector('#home:not([hidden])', { timeout: 8000 });
  await C.fill('#join-code', zcode); await C.click('#join');
  await C.waitForFunction(() => document.getElementById('home-error').textContent.length > 0, null, { timeout: 8000 });
  ok((await C.textContent('#home-error')).includes('No room called'), 'a waiting room is deleted when its host leaves');
};
