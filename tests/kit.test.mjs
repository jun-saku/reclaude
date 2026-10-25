// Unit test of the game server's kit adapter (worker/src/kit.js): Play again, with the real Tanks rules.
// Run: node tests/kit.test.mjs   (no dependencies; CI's build job)
import { kitGame } from "../worker/src/kit.js";
import tanks from "../projects/tanks/game.js";

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + m); };
const room = { seats: 2, players: { s0: "u0", s1: "u1" } };
const mod = kitGame(tanks);
const start = () => { const st = mod.create(room); mod.join(st, 0); mod.join(st, 1); return st; };
const end = (st) => { tanks.dev(st.s, "base"); mod.tick(st, 1 / 30); return !!mod.view(st, 0).over; };

// Both tap Play again: a new round.
let st = start();
ok(end(st), "the eagle falls: game over");
mod.input(st, 0, { t: "again" });
ok(st.round === 0 && mod.view(st, 0).again.join() === "0", "one taps Play again: waiting for the other");
mod.input(st, 1, { t: "again" });
ok(st.round === 1 && !mod.view(st, 0).over, "both tap: a new round starts");

// One taps, the other leaves without tapping: a new round with whoever's left.
st = start();
end(st);
mod.input(st, 0, { t: "again" });
mod.leave(st, 1);
ok(st.round === 1 && !mod.view(st, 0).over, "the other leaves: a new round starts for the one waiting");
ok(mod.view(st, 0).here.join() === "0" && mod.view(st, 0).again.length === 0, "with just them, nobody waiting");

// Nobody tapped and one leaves: still over. The last one leaving starts nothing.
st = start();
end(st);
mod.leave(st, 1);
ok(st.round === 0 && !!mod.view(st, 0).over, "a leave without anyone tapping changes nothing");
mod.leave(st, 0);
ok(st.round === 0, "the last one leaving starts nothing");

// Mid-game: Play again is ignored and a leave restarts nothing.
st = start();
mod.input(st, 0, { t: "again" });
mod.leave(st, 1);
ok(st.round === 0 && mod.view(st, 0).again.length === 0, "mid-game, Play again is ignored and a leave restarts nothing");

console.log(fails ? `\n${fails} failed` : "\nAll passed.");
process.exit(fails ? 1 : 0);
