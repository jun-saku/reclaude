// End-to-end test, run by ../e2e.cjs (see there). Gets the shared helpers; plays on the real Firebase SDK + emulator.
module.exports = async ({ page, ok, statusIs, BASE, out }) => {
  const FL = BASE + 'five-line/?backend=emulator';
  // ---- Names and the turn timer on real Firebase (a 3-seat Five Line room with a 30 s timer) ----
  const T1 = await page(FL); await T1.fill('#my-name', 'Jun'); await T1.click('#mode button[data-mode="3"]'); await T1.click('#timer button[data-secs="30"]');
  await T1.click('#create'); await T1.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const tmcode = (await T1.textContent('#waiting-code')).trim();
  const T2 = await page(FL); await T2.fill('#my-name', 'Bo'); await T2.fill('#join-code', tmcode); await T2.click('#join'); await T2.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  await T1.waitForFunction(() => document.getElementById('seated').textContent.includes('Bo'), null, { timeout: 8000 });
  ok((await T2.textContent('#seated')).includes('Jun'), 'names reach the other players through the real rules');
  await T1.waitForFunction(() => !document.getElementById('start-btn').disabled, null, { timeout: 8000 });
  await T1.click('#start-btn'); await T1.waitForTimeout(3000);
  console.log('DEBUG note:', await T1.textContent('#waiting-note'), JSON.stringify(await T1.evaluate(() => { const r = window.__fl.room; return { status: r.status, turnSecs: r.turnSecs, turnAt: r.turnAt, names: r.names, keys: Object.keys(r) }; })));
  await T2.waitForFunction(() => window.__fl.room?.status === 'playing' && window.__fl.room.turnAt, null, { timeout: 15000 });
  ok(await T2.waitForFunction(() => document.getElementById('status').textContent.startsWith("Jun's turn"), null, { timeout: 8000 }).then(() => true).catch(() => false), 'turns are shown by name');
  const tooSoon = await T2.evaluate(() => window.__fl.rooms.skipTurn(window.__fl.seat, { ...window.__fl.room, turnAt: Date.now() - 60000 }));
  await T1.waitForTimeout(500);
  ok((await T1.evaluate(() => window.__fl.room.turn)) === 0, `skipping before the 30 seconds are up is refused by the rules (the page asked: ${tooSoon})`);
  // The player on turn backdates their own turn start, standing in for 30 seconds of waiting
  await T1.evaluate(() => { const s = window.__fl.seat; return s.backend.update(s.code, { turnAt: Date.now() - 31000 }); });
  await T2.waitForFunction(() => !document.getElementById('skip').hidden, null, { timeout: 8000 });
  await T2.click('#skip'); await T1.waitForFunction(() => window.__fl.room.turn === 1, null, { timeout: 8000 });
  ok(await T2.waitForFunction(() => document.getElementById('status').textContent.startsWith('Your turn'), null, { timeout: 8000 }).then(() => true).catch(() => false), 'once time is up, Skip passes the turn on through the real rules');

  // ---- New: 3-seat lobby, start, turn order, private hands (room API on real Firebase) ----
  const H = await page(BASE + 'four-in-a-row/?backend=emulator');
  const lobby = await H.evaluate(async () => {
    const r = window.__c4.rooms;
    const s = await r.createRoom('lobby-test', { seats: 3, min: 2, auto: false, makeRoom: () => ({ board: '' }) });
    window.__seat = s;
    return s.code;
  });
  const P2 = await page(BASE + 'four-in-a-row/?backend=emulator');
  const P3 = await page(BASE + 'four-in-a-row/?backend=emulator');
  const j2 = await P2.evaluate(async (c) => { const s = await window.__c4.rooms.joinRoom('lobby-test', c); window.__seat = s; return s.seat; }, lobby);
  const j3 = await P3.evaluate(async (c) => { const s = await window.__c4.rooms.joinRoom('lobby-test', c); window.__seat = s; return s.seat; }, lobby);
  ok(j2 === 1 && j3 === 2, `3-seat lobby: joiners get seats 1 and 2 (${j2}, ${j3})`);
  const notHost = await P2.evaluate(async () => { try { await window.__c4.rooms.startGame(window.__seat); return 'started'; } catch (e) { return 'refused'; } });
  ok(notHost === 'refused', 'only the host can start the game');
  const started = await H.evaluate(async () => {
    const room = await window.__c4.rooms.startGame(window.__seat, (room) => ({ ...room, teams: 0, state: { deck: 'AS,KH' } }));
    return { status: room.status, next: window.__c4.rooms.nextSeat(room, 2) };
  });
  ok(started.status === 'playing' && started.next === 0, 'host starts the game; turn order wraps from seat 2 back to seat 0');
  const P4 = await page(BASE + 'four-in-a-row/?backend=emulator');
  const late = await P4.evaluate(async (c) => { try { await window.__c4.rooms.joinRoom('lobby-test', c); return 'joined'; } catch (e) { return e.message; } }, lobby);
  ok(late.includes('full') || late.includes('already started'), `latecomer refused (${late})`);
  await P2.evaluate(async () => { const s = window.__seat; await s.backend.setPrivate(s.code, s.seat, 'QH,2S,7D'); });
  const own = await P2.evaluate(() => new Promise((res) => { const s = window.__seat; s.backend.watchPrivate(s.code, s.seat, (v, e) => res(e ? 'error' : v)); }));
  const peek = await P3.evaluate(() => new Promise((res) => { const s = window.__seat; s.backend.watchPrivate(s.code, 1, (v, e) => res(e ? 'denied' : 'saw: ' + v)); setTimeout(() => res('timeout'), 6000); }));
  ok(own === 'QH,2S,7D', 'a player can read their own private hand');
  ok(peek === 'denied', `another player can't read it (${peek})`);
};
