// The games the server runs, by the room's `game` name. Each is a module with:
//   create(room) → state            a new game for this room (room: the Firebase room, with seats, names…)
//   load(saved, room) → state       a game saved by save() when the room last emptied
//   save(state) → JSON-able value   kept for 10 minutes while nobody's connected
//   join(state, seat, room)         a seated player connected (or reconnected)
//   leave(state, seat)              their last connection closed
//   input(state, seat, msg, { dev }) a message from a player (any JSON object; check it, players can send anything);
//                                   dev is true on the local test server only, for test shortcuts
//   tick(state, dt)                 advance the game by dt seconds (steps of at most 1/30 s)
//   view(state, seat, conn) → object what to send that player (10 times a second); conn is that connection's own
//                                   object, to remember what it was sent (feeds, worker/src/kit.js)
//   timeUp?(state)                  the game has run for 2 hours: end it
import probe from "./games/probe.js";
import { kitGame } from "./kit.js";
import tanks from "../../projects/tanks/game.js";

export const GAMES = { probe, tanks: kitGame(tanks) };
