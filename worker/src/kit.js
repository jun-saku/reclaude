// Runs a kit game (projects/<name>/game.js, see shared/kit.js) on the game server: the same rules the page runs for
// solo play. Players send { t: "in", m: move } (the game's own messages), { t: "again" } (Play again, once the game
// is over) and, on the local test server only, { t: "dev", m } (test shortcuts, game.dev). Everyone gets
// { round, again, here, over, v }: the round (it changes when a new game starts), who wants to play again, who's
// connected, the result (game.result) and their own view (game.view); and f, the new part of the game's feed
// (game.feed, see shared/feed.js) since that connection's last update.
import { feedPart } from "../../shared/feed.js";
const seatsOf = (map) => Object.keys(map).map(Number).sort((a, b) => a - b);
const playersIn = (room) => Array.from({ length: room.seats || 0 }, (_, i) => i).filter((i) => room.players?.[`s${i}`]).length;

export function kitGame(game) {
  const fresh = (players, here) => {
    const s = game.setup({ players });
    for (const p of here) game.join?.(s, p);
    return s;
  };
  // Once the game is over and everyone still here wants to play again: a new game with them.
  const maybeRestart = (st) => {
    const here = seatsOf(st.here);
    if (game.result(st.s) && here.length && here.every((p) => st.again[p])) { st.s = fresh(st.players, here); st.again = {}; st.round++; }
  };
  return {
    create: (room) => ({ s: fresh(playersIn(room), []), players: playersIn(room), round: 0, again: {}, here: {} }),
    load: (saved) => ({ ...saved, here: {}, s: game.load ? game.load(saved.s) : saved.s }),
    save: (st) => ({ ...st, here: {}, s: game.save ? game.save(st.s) : st.s }),
    join(st, seat) { st.here[seat] = true; game.join?.(st.s, seat); },
    leave(st, seat) { delete st.here[seat]; delete st.again[seat]; game.leave?.(st.s, seat); maybeRestart(st); },
    input(st, seat, msg, { dev } = {}) {
      if (msg.t === "in") { if (!game.result(st.s)) game.input(st.s, seat, msg.m && typeof msg.m === "object" ? msg.m : {}); }
      else if (msg.t === "again" && game.result(st.s)) {
        st.again[seat] = true;
        maybeRestart(st);
      } else if (msg.t === "dev" && dev) game.dev?.(st.s, msg.m, seat);
    },
    tick(st, dt) { if (!game.result(st.s)) game.tick?.(st.s, dt); },
    view(st, seat, conn = {}) {
      const msg = { round: st.round, again: seatsOf(st.again), here: seatsOf(st.here), over: game.result(st.s), v: game.view ? game.view(st.s, seat) : st.s };
      if (game.feed) {
        const f = game.feed(st.s);
        // A new game (Play again) starts a new list even if the game reuses its ids.
        const [part, had] = feedPart(f && { id: `${st.round}:${f.id}`, items: f.items }, conn.feed);
        conn.feed = had;
        if (part) msg.f = part;
      }
      return msg;
    },
    timeUp(st) { game.timeUp?.(st.s); },
  };
}
