// End-to-end test, run by ../e2e.cjs: Tanks stays smooth on a phone-like network. Every message from the game server
// reaches both players up to 150 ms late (in order, like a mobile connection); the host should still see the other
// player's tank glide (not freeze and jump), and a player should see their own shell the moment they fire.
module.exports = async ({ page, ok, BASE }) => {
  const URL = BASE + 'tanks/?backend=emulator';
  const wait = (p, fn, arg, ms = 10000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const JITTER = 150;
  // Incoming messages arrive 0..JITTER ms late, in order (like TCP on a mobile network).
  const jitter = (j) => {
    const Real = window.WebSocket;
    window.WebSocket = class extends Real {
      set onmessage(fn) {
        let release = 0;
        super.onmessage = (e) => { const at = Math.max(release, performance.now() + Math.random() * j); release = at; setTimeout(() => fn(e), at - performance.now()); };
      }
    };
  };
  const H = await page(URL); await H.fill('#my-name', 'Jun'); await H.click('#create');
  await H.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  const code = (await H.textContent('#waiting-code')).trim();
  const P = await page(URL); await P.fill('#my-name', 'Bo'); await P.fill('#join-code', code); await P.click('#join');
  await P.waitForSelector('#waiting:not([hidden])', { timeout: 15000 });
  for (const p of [H, P]) await p.evaluate(jitter, JITTER);
  await wait(H, () => !document.getElementById('start-btn').disabled);
  await H.click('#start-btn');
  ok(await wait(H, () => window.__kit.status === 'connected') && await wait(P, () => window.__kit.status === 'connected' && window.__tanks.me?.alive), 'both players connect through the slow network');
  await H.waitForTimeout(1500);
  // H records every frame: where P's tank is drawn, and the shells drawn.
  await H.evaluate(() => {
    window.__rec = [];
    const loop = () => { const w = window.__tanks.world(); const t = w?.tanks.find((x) => x.seat === 1); window.__rec.push({ at: performance.now(), y: t?.y, x: t?.x, shells: w?.shells.length || 0 }); if (window.__rec.length < 2000) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  // P drives up and down, firing.
  for (let i = 0; i < 4; i++) {
    await P.evaluate(() => window.__tanks.hold(0)); await P.waitForTimeout(700);
    await P.evaluate(() => window.__tanks.hold(2)); await P.waitForTimeout(700);
  }
  await P.evaluate(() => window.__tanks.hold(null));
  const rec = await H.evaluate(() => window.__rec.splice(0));
  // Frames where P's tank should move (P was driving) but was drawn still, and big jumps.
  let still = 0, moving = 0, jumps = 0, maxJump = 0;
  for (let i = 1; i < rec.length; i++) {
    const d = Math.abs(rec[i].y - rec[i - 1].y), dt = rec[i].at - rec[i - 1].at;
    const expect = 20 * dt / 1000;
    if (rec[i].at - rec[0].at > 5400) break;
    moving++;
    if (d < expect * 0.1) still++;
    if (d > expect * 3 && d > 0.8) { jumps++; maxJump = Math.max(maxJump, d); }
  }
  // (Still frames: a few each time P turns round, 8 times here.)
  ok(still / moving < 0.15 && jumps <= 5, `the other player's tank moves smoothly with late updates (${moving} frames: ${still} still, ${jumps} jumps, biggest ${maxJump.toFixed(1)} units)`);

  // Shells: P fires 6 times; how many frames show a shell on P's screen within 300 ms of pressing Fire.
  await P.evaluate(() => window.__tanks.hold(0)); await P.waitForTimeout(120); await P.evaluate(() => window.__tanks.hold(null));
  let seen = 0;
  for (let i = 0; i < 6; i++) {
    const n = await P.evaluate(async () => {
      window.__tanks.fire(true); setTimeout(() => window.__tanks.fire(false), 60);
      let frames = 0; const t0 = performance.now();
      await new Promise((r) => { const f = () => { if (window.__tanks.world().shells.length) frames++; if (performance.now() - t0 < 300) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f); });
      return frames;
    });
    if (n > 0) seen++;
    await P.waitForTimeout(900);
  }
  ok(seen === 6, `a player sees their own shell at once (${seen} of 6 shots within 300 ms of Fire)`);
};
