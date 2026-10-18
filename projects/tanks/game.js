// Tanks for the game kit (shared/kit.js): the rules are in sim.js; this says how the kit and the game server run them.
// Each player's device drives its own tank ({ t: "me", x, y, d, m, life }) and says when it fires ({ t: "fire" });
// the game decides everything else. The page runs it for solo play, the game server (worker/) for online rooms.
import * as sim from "./sim.js";

export default {
  id: "tanks",
  kind: "realtime",
  players: [1, 4],
  modes: ["solo", "online"],
  setup: ({ players }) => sim.newGame([], { players }),
  join: (g, seat) => sim.addTank(g, seat),
  leave: (g, seat) => sim.removeTank(g, seat),
  input(g, seat, m) {
    if (m.t === "me") return sim.moveTank(g, seat, Number(m.x), Number(m.y), Number(m.d), !!m.m, Number(m.life));
    if (m.t === "fire") return sim.fire(g, seat);
    return false;
  },
  tick: (g, dt) => sim.step(g, dt),
  view: (g) => sim.view(g),
  // The score is waves cleared (the Top 10's number).
  result: (g) => (g.over ? { ...g.over, score: g.over.waves } : null),
  save: (g) => sim.save(g),
  load: (saved) => sim.load(saved),
  timeUp(g) { if (!g.over) g.over = { base: false, waves: g.wave - 1, timeUp: true }; },
  // Shortcuts for the tests (the local test server only takes them).
  dev(g, what) {
    if (what === "clear") { g.enemies = []; g.toSpawn = 0; }
    if (what === "base") g.base = false;
  },
};
