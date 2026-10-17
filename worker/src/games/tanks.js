// Tanks online: the game (projects/tanks/sim.js, the same code the page runs for solo) on the server. Each player's
// device drives their own tank and says when it fires; the server runs everything else and sends everyone the game.
import * as sim from "../../../projects/tanks/sim.js";

const seatsOf = (room) => Array.from({ length: room.seats || 0 }, (_, i) => i).filter((i) => room.players?.[`s${i}`]);

export default {
  create: (room) => ({ g: sim.newGame([], { players: seatsOf(room).length }), seats: seatsOf(room).length, again: {}, round: 0 }),
  load: (saved) => ({ ...saved, g: sim.load(saved.g) }),
  save: (s) => ({ ...s, g: sim.save(s.g) }),
  join(s, seat) { sim.addTank(s.g, seat); },
  leave(s, seat) { sim.removeTank(s.g, seat); delete s.again[seat]; },
  input(s, seat, msg, { dev } = {}) {
    if (msg.t === "me") sim.moveTank(s.g, seat, Number(msg.x), Number(msg.y), Number(msg.d), !!msg.m, Number(msg.life));
    else if (msg.t === "fire") sim.fire(s.g, seat);
    else if (msg.t === "again" && s.g.over) {
      s.again[seat] = true;
      // Everyone still here agrees: a new game with the same players.
      const here = Object.values(s.g.tanks).filter((t) => t.present).map((t) => t.seat);
      if (here.every((p) => s.again[p])) {
        s.g = sim.newGame(here, { players: s.seats });
        s.again = {};
        s.round++;
      }
    }
    // Shortcuts for the tests, on the local test server only.
    else if (msg.t === "dev" && dev) {
      if (msg.do === "clear") { s.g.enemies = []; s.g.toSpawn = 0; }
      if (msg.do === "base") s.g.base = false;
    }
  },
  tick(s, dt) { sim.step(s.g, dt); },
  view: (s, seat) => ({ me: seat, round: s.round, again: Object.keys(s.again).map(Number), ...sim.view(s.g) }),
  timeUp(s) { if (!s.g.over) s.g.over = { base: false, waves: s.g.wave - 1, timeUp: true }; },
};
