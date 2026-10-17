// End-to-end test, run by ../e2e.cjs (see there). Gets the shared helpers; plays on the real Firebase SDK + emulator.
module.exports = async ({ page, ok, statusIs, BASE, out }) => {
  // ---- Word Tiles: 2 players on real Firebase ----
  const WT = BASE + 'word-tiles/?backend=emulator';
  const A = await page(WT);
  await A.evaluate(() => window.__wt.wordsReady);
  await A.click('#create'); await A.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const code = (await A.textContent('#waiting-code')).trim();
  ok(/^[A-HJ-NP-Z2-9]{4}$/.test(code), `word-tiles: room ${code} created through the real rules`);
  const B = await page(`${WT}&room=${code}`);
  await B.evaluate(() => window.__wt.wordsReady);
  await B.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  await A.waitForFunction(() => !document.getElementById('start-btn').disabled, null, { timeout: 8000 });
  await A.click('#start-btn');
  ok(await statusIs(A, 'Your turn') && await statusIs(B, 'P1\'s turn…'), 'the host starts; the host moves first');
  const rackOf = (p) => p.waitForFunction(() => window.__wt.rack.length === 7 && window.__wt.rack, null, { timeout: 8000 }).then((h) => h.jsonValue()).catch(() => '');
  const ra = await rackOf(A), rb = await rackOf(B);
  ok(ra.length === 7 && rb.length === 7, `each player is dealt 7 private tiles (${ra} / ${rb})`);
  const peek = await B.evaluate(async (code) => {
    const b = await window.__wt.rooms.__test.backend();
    return new Promise((res) => { const stop = b.watchPrivate(code, 0, (v) => res(v === null ? 'empty' : 'read: ' + v)); setTimeout(() => res('denied'), 4000); });
  }, code);
  ok(peek !== `read: ${ra}` && !String(peek).startsWith('read'), `a player can't read the other's rack (${peek})`);

  // Ann plays a word from her rack across the ★.
  const word = await A.evaluate(() => window.__wt.findWord());
  await A.evaluate((w) => window.__wt.place(w, 7, 7 - Math.floor(w.length / 2)), word);
  const preview = await A.textContent('#hint');
  await A.click('#play-btn');
  ok(await statusIs(B, 'Your turn') && await statusIs(A, "P2's turn…"), `${word} played (${preview}); the turn passes`);
  const pts = Number(preview.match(/(\d+) points/)?.[1]);
  ok(await B.waitForFunction((w) => window.__wt.room.board.includes(w), word, { timeout: 8000 }).then(() => true).catch(() => false)
    && (await B.textContent('#players')).includes(String(pts)), 'the board and score reach the other phone');
  const after = await A.waitForFunction((n) => window.__wt.rack.length === 7 && window.__wt.room.state.n === n && window.__wt.rack, 1, { timeout: 8000 }).then((h) => h.jsonValue()).catch(() => '');
  ok(after.length === 7 && after !== ra, `the rack is refilled from the bag (${after})`);

  // Ann can't move on Bob's turn: the rules refuse it.
  const early = await A.evaluate(async (code) => {
    const b = await window.__wt.rooms.__test.backend();
    try { const r = await b.transact(code, (cur) => (cur ? { ...cur, board: 'x'.repeat(225) } : null)); return r.committed ? 'written' : 'aborted'; }
    catch (e) { return 'denied: ' + e.message; }
  }, code);
  ok(early.startsWith('denied'), `a player can't change the board on the other's turn (${early.slice(0, 40)})`);

  // Bob swaps two tiles, then reloads: his new rack is still there.
  await B.click('#swap'); await B.click('.rack .tile >> nth=0'); await B.click('.rack .tile >> nth=1'); await B.click('#swap-go');
  ok(await statusIs(A, 'Your turn') && (await A.textContent('#last')).includes('swapped 2 tiles'), 'swapping tiles ends the turn');
  const rb2 = await B.waitForFunction((n) => window.__wt.room.state.n === n && window.__wt.rack.length === 7 && window.__wt.rack, 2, { timeout: 8000 }).then((h) => h.jsonValue()).catch(() => '');
  await B.reload();
  await B.waitForSelector('#play:not([hidden])', { timeout: 15000 });
  const rb3 = await rackOf(B);
  ok(rb3 === rb2, `reload keeps the rack (${rb2} → ${rb3})`);

  // Six scoreless turns in a row end the game; rack values come off the scores.
  for (let k = 0; k < 5; k++) {
    const p = k % 2 === 0 ? A : B;
    p.once('dialog', (d) => d.accept());
    await p.click('#pass');
    await (k % 2 === 0 ? B : A).waitForFunction((n) => window.__wt.room.state.n === n, 3 + k, { timeout: 8000 });
  }
  const done = await A.waitForFunction(() => window.__wt.room.status === 'done', null, { timeout: 8000 }).then(() => true).catch(() => false);
  const fin = await A.evaluate(() => window.__wt.room.state);
  ok(done && (await A.isVisible('#final')) && (await B.isVisible('#final')), `the game ends after 6 scoreless turns (scores ${fin.sc}, racks ${fin.rv})`);
  ok(Number(fin.sc.split(',')[0]) === pts - Number(fin.rv.split(',')[0]), 'tiles left on the rack count against the score');
  await A.screenshot({ path: `${out}/e2e-word-tiles.png` });

  // Play again: a fresh board, and the other player starts.
  await A.click('#rematch'); await B.click('#rematch');
  ok(await statusIs(B, 'Your turn') && await statusIs(A, "P2's turn…"), 'play again deals a new game and the other player starts');
  ok((await rackOf(A)).length === 7 && await A.evaluate(() => !/[A-Za-z]/.test(window.__wt.room.board)), 'new racks and an empty board');

  // Leaving mid-game forfeits.
  A.once('dialog', (d) => d.accept());
  await A.click('#leave'); await A.waitForSelector('#home:not([hidden])', { timeout: 8000 });
  ok(await statusIs(B, 'P1 left. You win 🎉'), 'leaving mid-game forfeits; the other player sees it');
};
