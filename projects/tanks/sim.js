// Tanks: the game itself, with no drawing and no network. The page runs it for solo play, and the game server
// (worker/src/games/tanks.js) runs the same code for online rooms, so both play the same.
//
// Distances are in units: a tile is 8 units, the field 13×13 tiles (104 units). The map is kept in cells of 4 units
// (half a tile, 26×26), the size of one brick block. Tanks are one tile; directions are 0 up, 1 right, 2 down, 3 left.
// Players' tanks are driven by their own devices (moveTank, checked here), everything else is decided by step().

export const U = 104, N = 26, CELL = 4, TANK = 8;
export const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export const EMPTY = 0, BRICK = 1, STEEL = 2, WATER = 3, TREES = 4, BASE = 5;
export const PLAYER_SPEED = 20, SHELL_SPEED = 80;
// Enemy kinds: 0 steady, 1 fast, 2 fast shells, 3 armoured (four hits).
export const KINDS = [
  { speed: 12, shell: 60, hp: 1 },
  { speed: 22, shell: 60, hp: 1 },
  { speed: 14, shell: 100, hp: 1 },
  { speed: 11, shell: 60, hp: 4 },
];
export const PLAYER_SPAWNS = [[32, 96], [64, 96], [16, 96], [80, 96]];
const ENEMY_SPAWNS = [[0, 0], [48, 0], [96, 0]];
export const BASE_X = 48, BASE_Y = 96;
const SHIELD = 2.5, RESPAWN = 1.6;

// # brick, @ steel, ~ water, % trees, E the eagle. Waves cycle through these.
const LAYOUTS = [
  [
    ".............",
    ".#.#.#.#.#.#.",
    ".#.#.#.#.#.#.",
    ".#.#.#@#.#.#.",
    ".#.#.....#.#.",
    ".....#.#.....",
    "@.##.....##.@",
    ".....#.#.....",
    ".#.#.###.#.#.",
    ".#.#.#.#.#.#.",
    ".#.#.....#.#.",
    ".#.#.###.#.#.",
    ".....#E#.....",
  ],
  [
    ".............",
    "..#..@.@..#..",
    ".###.....###.",
    "..#..###..#..",
    ".....#.#.....",
    "%%%.......%%%",
    "~~~.#####.~~~",
    "%%%.......%%%",
    "..@..#.#..@..",
    ".###.....###.",
    "..#..#.#..#..",
    ".....###.....",
    ".....#E#.....",
  ],
  [
    ".............",
    ".@.#.#.#.#.@.",
    ".#.........#.",
    ".#.##%%%##.#.",
    "...#%%%%%#...",
    ".@.#.....#.@.",
    "...#.@.@.#...",
    ".%%.......%%.",
    ".%%.#####.%%.",
    ".....#.#.....",
    ".#.#.....#.#.",
    ".#.#.###.#.#.",
    ".....#E#.....",
  ],
];
const TILE_KIND = { "#": BRICK, "@": STEEL, "~": WATER, "%": TREES, E: BASE };
const LAYOUT_CELLS = LAYOUTS.map((rows) => {
  const a = new Uint8Array(N * N);
  rows.forEach((row, ty) => [...row].forEach((ch, tx) => {
    for (let k = 0; k < 4; k++) a[(ty * 2 + (k >> 1)) * N + tx * 2 + (k & 1)] = TILE_KIND[ch] || EMPTY;
  }));
  return a;
});
export const layoutFor = (wave) => LAYOUT_CELLS[(wave - 1) % LAYOUT_CELLS.length];
export const freshBricks = (wave) => Uint8Array.from(layoutFor(wave), (t) => (t === BRICK ? 1 : 0));

// The bricks still standing, 6 cells per character (113 characters).
const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
export function encBricks(b) {
  let s = "";
  for (let i = 0; i < N * N; i += 6) { let v = 0; for (let k = 0; k < 6; k++) if (b[i + k]) v |= 1 << k; s += B64[v]; }
  return s;
}
export function decBricks(s, wave) {
  const lay = layoutFor(wave), b = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) { const v = B64.indexOf(s?.[(i / 6) | 0] ?? ""); b[i] = lay[i] === BRICK && v >= 0 && (v >> (i % 6)) & 1 ? 1 : 0; }
  return b;
}

// Difficulty: enemies per wave, how many at once, and which kinds, by wave and team size.
const waveSize = (wave, players) => Math.round((6 + 2 * Math.min(wave, 7)) * (1 + 0.35 * (players - 1)));
const fieldCap = (players) => 3 + players;
const startLives = (players) => (players === 1 ? 3 : 2 + players);
function pickKind(wave, rand) {
  const w = [Math.max(1, 6 - wave), wave >= 2 ? 0.6 * wave : 0, wave >= 3 ? 0.4 * wave : 0, wave >= 4 ? 0.4 * wave : 0];
  let r = rand() * w.reduce((a, b) => a + b, 0);
  for (let k = 0; k < w.length; k++) { r -= w[k]; if (r < 0) return k; }
  return 0;
}

// ---------- the map and moving ----------
export const cellAt = (x, y) => (x < 0 || y < 0 || x >= U || y >= U ? -1 : Math.floor(y / CELL) * N + Math.floor(x / CELL));
export function solidForTank(layout, bricks, i) {
  const t = layout[i];
  return (t === BRICK && bricks[i]) || t === STEEL || t === WATER || t === BASE;
}
export function rectBlocked(layout, bricks, x, y) {
  if (!(x >= 0 && y >= 0 && x <= U - TANK && y <= U - TANK)) return true;
  for (let cy = Math.floor(y / CELL); cy <= Math.floor((y + TANK - 0.001) / CELL); cy++) {
    for (let cx = Math.floor(x / CELL); cx <= Math.floor((x + TANK - 0.001) / CELL); cx++) if (solidForTank(layout, bricks, cy * N + cx)) return true;
  }
  return false;
}
export const overlap = (ax, ay, aw, bx, by, bw) => ax < bx + bw && bx < ax + aw && ay < by + bw && by < ay + aw;
// Moves a tank up to dist units in its direction, stopping at walls and at the given tanks (except ones it already
// overlaps, so tanks that spawned on top of each other can drive apart). Returns how far it went.
export function drive(map, t, dist, blockers) {
  const [dx, dy] = DIRS[t.d];
  const stuck = blockers.filter((b) => overlap(t.x, t.y, TANK, b.x, b.y, TANK));
  let went = 0;
  while (went < dist - 1e-6) {
    const step = Math.min(0.5, dist - went), nx = t.x + dx * step, ny = t.y + dy * step;
    if (rectBlocked(map.layout, map.bricks, nx, ny) || blockers.some((b) => !stuck.includes(b) && overlap(nx, ny, TANK, b.x, b.y, TANK))) break;
    t.x = nx; t.y = ny; went += step;
  }
  return went;
}
// Turning onto the other axis lines the tank up on the half-tile grid, so it fits through one-tile gaps.
export function turn(map, t, d) {
  if (t.d === d) return;
  if ((t.d & 1) !== (d & 1)) {
    const nx = d & 1 ? t.x : Math.round(t.x / CELL) * CELL, ny = d & 1 ? Math.round(t.y / CELL) * CELL : t.y;
    if (!rectBlocked(map.layout, map.bricks, nx, ny)) { t.x = nx; t.y = ny; }
  }
  t.d = d;
}
// Moves a shell; returns what it hit: null, "out", { cells, base } (the map), or { tank } (one of targets).
export function flyShell(map, s, dt, targets) {
  const [dx, dy] = DIRS[s.d];
  let left = s.speed * dt;
  while (left > 0) {
    const step = Math.min(1, left); left -= step;
    s.x += dx * step; s.y += dy * step;
    if (s.x < 0 || s.y < 0 || s.x >= U || s.y >= U) return "out";
    // The leading edge and a 4-unit band across it: up to two cells, like a tank's width of bricks.
    const tipX = s.x + dx, tipY = s.y + dy;
    const cells = new Set();
    for (const o of [-2, 2]) { const c = cellAt(dx ? tipX : s.x + o, dy ? tipY : s.y + o); if (c >= 0) cells.add(c); }
    const hit = [...cells].filter((c) => (map.layout[c] === BRICK && map.bricks[c]) || map.layout[c] === STEEL || map.layout[c] === BASE);
    if (hit.length) return { cells: hit.filter((c) => map.layout[c] === BRICK), base: hit.some((c) => map.layout[c] === BASE) };
    for (const t of targets) if (overlap(s.x - 1, s.y - 1, 2, t.x, t.y, TANK)) return { tank: t };
  }
  return null;
}
const shellFrom = (t, speed) => ({ x: t.x + 4 + DIRS[t.d][0] * 4, y: t.y + 4 + DIRS[t.d][1] * 4, d: t.d, speed });

// ---------- a game ----------
// seats: the seats playing now (solo: [0]); players: the team's size, for the difficulty and lives (default: as
// many as seats; the server passes the room's size, as players connect one by one); rand: random numbers.
export function newGame(seats, { players = seats.length, rand = Math.random } = {}) {
  players = Math.max(1, players);
  const g = {
    wave: 1, layout: layoutFor(1), bricks: freshBricks(1), base: true, players,
    tanks: {}, enemies: [], shells: [], lives: startLives(players), kills: 0,
    toSpawn: waveSize(1, players), spawnIn: 2.5, spawnAt: 0, nextId: 1, nextShell: 1, nextBoom: 1,
    booms: [], over: null, t: 0, bannerUntil: 2, rand,
  };
  for (const s of seats) addTank(g, s);
  return g;
}

function spawnTank(g, tank) {
  const [x, y] = PLAYER_SPAWNS[tank.seat % PLAYER_SPAWNS.length];
  Object.assign(tank, { x, y, d: 0, alive: true, shield: SHIELD, respawnIn: null, moving: false, life: tank.life + 1 });
}
// A player joins (or comes back): their tank, kept while they were away, or a new one.
export function addTank(g, seat) {
  let t = g.tanks[seat];
  if (!t) { t = g.tanks[seat] = { seat, x: 0, y: 0, d: 0, alive: false, shield: 0, respawnIn: null, moving: false, life: 0, shell: null, present: true }; spawnTank(g, t); }
  t.present = true;
  return t;
}
// A player left: their tank leaves the field (and comes back with them).
export function removeTank(g, seat) {
  const t = g.tanks[seat];
  if (t) { t.present = false; t.moving = false; }
}
const activeTanks = (g) => Object.values(g.tanks).filter((t) => t.present && t.alive);

// A player's own device drives their tank: accept where it says the tank is if that's somewhere a tank can be,
// not too far from the last place (a slow connection sends bursts), and for the tank's current life (a message
// from before it was hit and respawned is ignored).
export function moveTank(g, seat, x, y, d, moving, life) {
  const t = g.tanks[seat];
  if (!t || !t.alive || life !== t.life || g.over) return false;
  if (![x, y].every(Number.isFinite) || !(d >= 0 && d <= 3)) return false;
  if (Math.hypot(x - t.x, y - t.y) > 24 || rectBlocked(g.layout, g.bricks, x, y)) return false;
  t.x = x; t.y = y; t.d = d | 0; t.moving = !!moving;
  return true;
}
export function fire(g, seat) {
  const t = g.tanks[seat];
  if (!t || !t.alive || !t.present || g.over) return false;
  if (t.shell && g.shells.some((s) => s.id === t.shell)) return false;
  const s = { id: g.nextShell++, ...shellFrom(t, SHELL_SPEED), from: "p", owner: seat };
  g.shells.push(s);
  t.shell = s.id;
  return true;
}

function boom(g, x, y, big = false) {
  g.booms.push({ id: g.nextBoom++, x, y, big, at: g.t });
}
function hitTank(g, t) {
  if (!t.alive || t.shield > 0) return false;
  t.alive = false; t.moving = false;
  boom(g, t.x + 4, t.y + 4, true);
  // The team's spare lives bring a player back; with none left they wait for the next wave's bonus.
  if (g.lives > 0) { g.lives--; t.respawnIn = RESPAWN; } else t.respawnIn = null;
  return true;
}

// Advances the game by dt seconds.
export function step(g, dt) {
  if (g.over) return;
  g.t += dt;
  g.booms = g.booms.filter((b) => g.t - b.at < 1);
  const map = g;
  // Players coming back in
  for (const t of Object.values(g.tanks)) {
    t.shield = Math.max(0, t.shield - dt);
    if (!t.alive && t.respawnIn !== null && (t.respawnIn -= dt) <= 0) spawnTank(g, t);
  }
  const blockersFor = (me) => [...g.enemies, ...activeTanks(g)].filter((b) => b !== me);
  // New enemies
  g.spawnIn -= dt;
  if (g.toSpawn > 0 && g.enemies.length < fieldCap(g.players) && g.spawnIn <= 0) {
    const [x, y] = ENEMY_SPAWNS[g.spawnAt % ENEMY_SPAWNS.length];
    g.spawnAt++;
    if (!blockersFor(null).some((b) => overlap(x, y, TANK, b.x, b.y, TANK))) {
      const kind = pickKind(g.wave, g.rand);
      g.enemies.push({ id: g.nextId++, kind, x, y, d: 2, hp: KINDS[kind].hp, moving: true, turnIn: 1 + g.rand() * 2, shell: null, flash: -1 });
      g.toSpawn--;
      g.spawnIn = Math.max(1, 2.6 - 0.12 * Math.min(g.wave, 10)) / (1 + 0.25 * (g.players - 1));
    } else g.spawnIn = 0.4;
  }
  // Enemies roll on, turn now and then (often towards the eagle or a player), and shoot at random.
  for (const e of g.enemies) {
    const want = KINDS[e.kind].speed * dt;
    const went = drive(map, e, want, blockersFor(e));
    e.moving = went > 0;
    e.turnIn -= dt;
    const stuck = went < want * 0.5;
    const canFire = !e.shell || !g.shells.some((s) => s.id === e.shell);
    if (stuck && canFire && g.rand() < 0.08) fireEnemy(g, e);
    if (e.turnIn <= 0 || (stuck && g.rand() < 0.15)) {
      const targets = [{ x: BASE_X, y: BASE_Y }, ...activeTanks(g)];
      const t = targets[Math.floor(g.rand() * targets.length)];
      const r = g.rand();
      turn(map, e, r < 0.35 ? 2 : r < 0.65 ? (t.x > e.x ? 1 : 3) : r < 0.8 ? (t.y > e.y ? 2 : 0) : Math.floor(g.rand() * 4));
      e.turnIn = 0.6 + g.rand() * 2;
    }
    if (canFire && g.rand() < dt * 0.8) fireEnemy(g, e);
  }
  // Shells: players' hit enemies and bricks; enemies' hit players, bricks and the eagle.
  for (const s of [...g.shells]) {
    const targets = s.from === "p" ? g.enemies : activeTanks(g);
    const hit = flyShell(map, s, dt, targets);
    if (!hit) continue;
    g.shells.splice(g.shells.indexOf(s), 1);
    if (hit === "out") continue;
    if (hit.cells) {
      for (const c of hit.cells) g.bricks[c] = 0;
      boom(g, s.x, s.y);
      if (hit.base && s.from === "e" && g.base) { g.base = false; boom(g, BASE_X + 4, BASE_Y + 4, true); }
    }
    if (hit.tank) {
      boom(g, s.x, s.y);
      if (s.from === "p") {
        const e = hit.tank;
        e.hp--; e.flash = g.t;
        if (e.hp <= 0) { g.enemies.splice(g.enemies.indexOf(e), 1); g.kills++; boom(g, e.x + 4, e.y + 4, true); }
      } else hitTank(g, hit.tank);
    }
  }
  // The wave is cleared once nobody's left to come: a bonus life, and on to the next map.
  if (g.base && g.toSpawn <= 0 && g.enemies.length === 0) nextWave(g);
  // Game over: the eagle fell, or every player is down with no lives left. A player who left counts too: their tank
  // waits for them (they can rejoin), so the game carries on for the others.
  const all = Object.values(g.tanks);
  if (!g.base || (all.length && all.every((t) => !t.alive && t.respawnIn === null))) {
    g.over = { base: !g.base, waves: g.wave - 1 };
  }
}
function fireEnemy(g, e) {
  const s = { id: g.nextShell++, ...shellFrom(e, KINDS[e.kind].shell), from: "e" };
  g.shells.push(s);
  e.shell = s.id;
}
export function nextWave(g) {
  g.wave++;
  g.layout = layoutFor(g.wave);
  g.bricks = freshBricks(g.wave);
  g.enemies = []; g.shells = [];
  g.toSpawn = waveSize(g.wave, g.players);
  g.spawnIn = 2.5;
  g.lives = Math.min(g.lives + 1, 99);
  g.bannerUntil = g.t + 2;
  for (const t of Object.values(g.tanks)) {
    if (t.alive) spawnTank(g, t);
    else if (t.respawnIn === null && g.lives > 0) { g.lives--; t.respawnIn = 1; }
  }
}

// ---------- what players see ----------
// A compact copy of the game for the screen (the server sends this 10 times a second).
const r1 = (v) => Math.round(v * 10) / 10;
export function view(g) {
  const tanks = {};
  for (const t of Object.values(g.tanks)) if (t.present) tanks[t.seat] = [r1(t.x), r1(t.y), t.d, t.alive ? 1 : 0, t.shield > 0 ? 1 : 0, t.moving ? 1 : 0, t.life, t.respawnIn === null && !t.alive ? 1 : 0];
  return {
    w: g.wave, l: g.lives, k: g.kills, n: g.toSpawn + g.enemies.length, base: g.base ? 1 : 0, b: encBricks(g.bricks),
    tanks,
    e: g.enemies.map((e) => [e.id, e.kind, r1(e.x), r1(e.y), e.d, e.hp, e.moving ? 1 : 0, g.t - e.flash < 0.1 ? 1 : 0]),
    s: g.shells.map((s) => [s.id, r1(s.x), r1(s.y), s.d, s.speed, s.from === "p" ? s.owner : -1]), // last: who fired (-1 an enemy)
    bo: g.booms.map((b) => [b.id, r1(b.x), r1(b.y), b.big ? 1 : 0]),
    banner: g.t < g.bannerUntil ? `Wave ${g.wave}` : null,
    over: g.over,
  };
}

// For the server keeping a game while its room is empty.
export function save(g) {
  const { rand, layout, bricks, ...rest } = g;
  return { ...rest, bricks: encBricks(bricks) };
}
export function load(saved, rand = Math.random) {
  return { ...saved, rand, layout: layoutFor(saved.wave), bricks: decBricks(saved.bricks, saved.wave) };
}
