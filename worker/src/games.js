// The games the server runs, by the room's `game` name. Each is a module with:
//   create(room) → state            a new game for this room (room: the Firebase room, with seats, names…)
//   load(saved, room) → state       a game saved by save() when the room last emptied
//   save(state) → JSON-able value   kept for 10 minutes while nobody's connected
//   join(state, seat, room)         a seated player connected (or reconnected)
//   leave(state, seat)              their last connection closed
//   input(state, seat, msg)         a message from a player (any JSON object; check it, players can send anything)
//   tick(state, dt)                 advance the game by dt seconds (30 times a second)
//   view(state, seat) → object      what to send that player (10 times a second)
//   timeUp?(state)                  the game has run for 2 hours: end it
import probe from "./games/probe.js";

export const GAMES = { probe };
