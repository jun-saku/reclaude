// End-to-end test of the game server (worker/, run locally by ../e2e.cjs) with its "probe" test game: real Firebase
// SDK + emulator for rooms and sign-in, shared/server.js in the page. Checks seats, outsiders, reconnecting and
// that an emptied room keeps its game.
module.exports = async ({ page, ok, BASE }) => {
  const URL = BASE + 'four-in-a-row/?backend=emulator';
  const setup = () => import('../shared/server.js').then((server) => {
    window.__server = server; window.__states = []; window.__status = [];
    window.__connect = (seat, room) => {
      window.__game = server.connect(seat, room, {
        onState: (s) => { window.__last = s; window.__states.push(s); },
        onStatus: (st, why) => window.__status.push(why ? `${st}: ${why}` : st),
      });
    };
  });
  const A = await page(URL), B = await page(URL), D = await page(URL);
  for (const p of [A, B, D]) await p.evaluate(setup);
  const code = await A.evaluate(async () => {
    const r = window.__c4.rooms;
    window.__seat = await r.createRoom('probe', { seats: 3, min: 2, auto: false });
    return window.__seat.code;
  });
  await B.evaluate(async (c) => { window.__seat = await window.__c4.rooms.joinRoom('probe', c); }, code);
  const room = await A.evaluate(() => window.__c4.rooms.startGame(window.__seat));
  ok(room.status === 'playing', 'a probe room is playing');
  const wait = (p, fn, arg, ms = 10000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);

  // Live sign-in tokens are about 2 KB together (the emulator's are tiny): pad A's hello to that size.
  await A.evaluate(() => {
    const b = window.__seat.backend, real = b.credentials.bind(b);
    b.credentials = async () => ({ ...(await real()), pad: 'x'.repeat(2500) });
  });
  for (const p of [A, B]) await p.evaluate((room) => window.__connect(window.__seat, room), room);
  ok(await wait(A, () => window.__status.includes('connected')) && await wait(B, () => window.__status.includes('connected')), 'seated players connect to the game server (their Firebase sign-in is checked)');
  ok(await A.evaluate(() => window.__status.includes('connected')), 'a hello as big as a live one (two sign-in tokens, ~2 KB) is accepted');
  await A.evaluate(() => window.__game.send({ t: 'set', v: 7 }));
  await B.evaluate(() => window.__game.send({ t: 'set', v: 9 }));
  ok(await wait(B, () => window.__last?.values?.[0] === 7 && window.__last.values[1] === 9 && window.__last.here.length === 2), "each player's input reaches everyone through the server");
  const states = await B.evaluate(async () => { const n = window.__states.length; await new Promise((r) => setTimeout(r, 1000)); return window.__states.length - n; });
  ok(states >= 7 && states <= 12, `the server sends the game about 10 times a second (${states} in 1 s)`);
  ok(await B.evaluate(() => window.__last.me === 1 && typeof window.__last.age === 'number'), 'each player is told their own seat, and how old an update is');

  // Someone not seated in the room is refused, and so is a game that isn't this room's.
  const dSeat = await D.evaluate(async (code) => {
    await window.__c4.rooms.myUid();
    const backend = await window.__c4.rooms.__test.backend();
    window.__seat = { backend, code };
    return !!backend;
  }, code);
  await D.evaluate((room) => window.__connect(window.__seat, room), room);
  ok(dSeat && await wait(D, () => window.__status.some((s) => s.startsWith('refused'))), `a player who isn't seated is refused (${await D.evaluate(() => window.__status.join(' / '))})`);
  await B.evaluate((room) => { window.__status = []; const g = window.__server.connect(window.__seat, { ...room, createdAt: room.createdAt - 1 }, { onStatus: (s, w) => window.__status.push(w ? `${s}: ${w}` : s) }); window.__wrong = g; }, room);
  ok(await wait(B, () => window.__status.some((s) => s.startsWith('refused'))), 'an old room under the same code is a different game');
  await B.evaluate(() => window.__wrong.close());
  ok(await wait(B, () => window.__last?.here?.length === 2 && window.__game.isConnected()), "and that didn't disturb B's own connection");

  // A leaves and comes back: the others see it, and the game carries on.
  await A.evaluate(() => window.__game.close());
  ok(await wait(B, () => window.__last.here.length === 1), 'when a player disconnects, the others see it');
  await A.evaluate((room) => { window.__status = []; window.__connect(window.__seat, room); }, room);
  ok(await wait(A, () => window.__last?.values?.[0] === 7 && window.__last.here.length === 2), 'they reconnect to the same game');

  // Everyone leaves: the game stops and is kept; the first player back carries on from where it was.
  const before = await A.evaluate(() => window.__last.ticks);
  for (const p of [A, B]) await p.evaluate(() => window.__game.close());
  await A.waitForTimeout(1500);
  await A.evaluate((room) => { window.__last = null; window.__connect(window.__seat, room); }, room);
  ok(await wait(A, () => window.__last?.values?.[1] === 9), 'an emptied room keeps its game for players coming back');
  const after = await A.evaluate(() => window.__last.ticks);
  ok(after >= before && after < before + 30 * 1.2, `the game didn't run while nobody was there (ticks ${before} → ${after})`);

  // Nobody comes back: the room's storage is deleted (after 4 s in the tests, 10 minutes live).
  await A.evaluate(() => window.__game.close());
  await A.waitForTimeout(6000);
  await A.evaluate((room) => { window.__last = null; window.__connect(window.__seat, room); }, room);
  ok(await wait(A, () => window.__last && !window.__last.values[1] && window.__last.ticks < 60), `a room left empty is forgotten: the game starts afresh (${await A.evaluate(() => JSON.stringify(window.__last?.values))})`);
  await A.evaluate(() => window.__game.close());
};
