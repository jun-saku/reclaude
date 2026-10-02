// Generates firebase/database.rules.json. Edit the rules here, not in the JSON: room rules repeat per seat,
// so they are built from small pieces for SEATS seats.
//   node scripts/rules.mjs           writes firebase/database.rules.json
//   node scripts/rules.mjs --check   fails if the JSON is not what this script generates (the rules test runs it)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEATS = 10; // seats s0..s9 (rooms.js MAX_SEATS must match)
const S = Array.from({ length: SEATS }, (_, i) => i);
const SEAT_RE = `^s[0-${SEATS - 1}]$`;
const NAME_RE = "^[^<>&]{1,16}$"; // names are shown in pages, so no HTML characters

const same = (k) => `newData.child('${k}').val() === data.child('${k}').val()`;
const leaves = (ks) => ks.map(same).join(" && ");
const stateKept = "newData.child('state').exists() === data.child('state').exists()";
const isHost = "data.child('host').val() === auth.uid";
const turnPlayer = "data.child('players/s' + data.child('turn').val()).val() === auth.uid";
const st = (v) => `(data.child('status').val() === '${v}')`;
const ownFlag = (field) => S.map((i) => `(${same(`${field}/s${i}`)} || newData.child('players/s${i}').val() === auth.uid)`).join(" && ");
// Fields that make up the game itself: who may change them depends on the room's status (below).
const game = ["board", "turn", "winner", "line", "last", "round", "teams", "left"];

// ---------- rooms/<code> ----------
const seated = S.map((i) => `data.child('players/s${i}').val() === auth.uid`).join(" || ");
const joining = `(data.child('status').val() === 'waiting' && (${S.map((i) => `(!data.child('players/s${i}').exists() && newData.child('players/s${i}').val() === auth.uid)`).join(" || ")}))`;
const write = `auth != null && $code.matches(/^[A-HJ-NP-Z2-9]{4}$/) && (newData.exists() ? (!data.exists() || ${seated} || ${joining}) : ` +
  // Deleting a room: its host before the game starts, or anyone once it is a day old.
  `(data.child('createdAt').val() < now - 86400000 || (${isHost} && ${st("waiting")})))`;

// A seat, once taken, can't be emptied or given to someone else.
const seatsKept = S.map((i) => `(!data.child('players/s${i}').exists() || ${same(`players/s${i}`)})`).join(" && ");
// Only the seat's own player changes its online flag, play-again flag and name. Play-again flags are all
// cleared when a new round starts.
const online = ownFlag("online");
const again = `(newData.child('round').val() !== data.child('round').val() || (${ownFlag("again")}))`;
const names = ownFlag("names");
const full = S.slice(1).map((i) => `(newData.child('seats').val() <= ${i} || newData.child('players/s${i}').exists())`).join(" && ");
// Waiting: the host sets the game up; others may only take a seat (and start an auto room once it is full).
const waiting = `(!${st("waiting")} || ${isHost} || (${leaves(game)} && (${same("status")} || (newData.child('status').val() === 'playing' && data.child('auto').val() === true && ${full}))))`;
// Forfeit: the leaver names their own seat in `left`; the win goes to another seat (no teams), to the other
// team (2 teams), or the game ends in a draw (3+ players). Everything else stays as it was.
const evens = S.filter((i) => i % 2 === 0).map((i) => `newData.child('left').val() === ${i}`).join(" || ");
const otherWins = `(newData.child('winner').val() === 'draw' || (data.child('teams').val() === 0 && newData.child('winner').isNumber() && data.child('players/s' + newData.child('winner').val()).exists() && newData.child('winner').val() !== newData.child('left').val()) || (data.child('teams').val() === 2 && newData.child('winner').val() === ((${evens}) ? 1 : 0)))`;
const forfeit = `(newData.child('status').val() === 'done' && data.child('players/s' + newData.child('left').val()).val() === auth.uid && ${otherWins} && ${leaves(game.filter((k) => k !== "winner" && k !== "left"))} && ${stateKept})`;
// Turn timer: once a turn has run longer than turnSecs, any seated player may pass it to another seated player.
// (Rules fail as a whole on a missing value in arithmetic, so check both are numbers first.)
const skip = `(data.child('turnSecs').isNumber() && data.child('turnAt').isNumber() && data.child('turnSecs').val() > 0 && data.child('turnAt').val() + data.child('turnSecs').val() * 1000 < now && newData.child('turn').val() !== data.child('turn').val() && data.child('players/s' + newData.child('turn').val()).exists() && ${leaves([...game.filter((k) => k !== "turn"), "status"])} && ${stateKept})`;
// Playing: only the player whose turn it is may change the game (or a forfeit, or a skip after the timer).
const playing = `(!${st("playing")} || ${turnPlayer} || ${forfeit} || ${skip} || (${leaves([...game, "status"])} && ${stateKept}))`;
// Done: the result stays put; anyone seated may start the next round.
const done = `(!${st("done")} || (newData.child('status').val() !== 'done' ? newData.child('round').val() === data.child('round').val() + 1 : ${leaves(game)} && ${stateKept}))`;

const ps = "data.parent().child('status').val()";
const forfeiting = "newData.parent().child('status').val() === 'done' && newData.parent().child('left').exists() && data.parent().child('players/s' + newData.parent().child('left').val()).val() === auth.uid";

const seatOk = (i) => (i < 2 ? `$seat === 's${i}'` : `($seat === 's${i}' && newData.parent().parent().child('seats').val() >= ${i + 1})`);
const perSeat = (validate) => ({ $seat: { ".validate": `$seat.matches(/${SEAT_RE}/) && ${validate}` } });
const fixed = "(!data.exists() || newData.val() === data.val())";

const room = {
  ".read": "auth != null && $code.matches(/^[A-HJ-NP-Z2-9]{4}$/)",
  ".write": write,
  ".validate": `newData.hasChildren(['game', 'host', 'seats', 'players', 'status', 'turn', 'round', 'createdAt']) && (!data.exists() || (${seatsKept} && ${online} && ${again} && ${names} && ${waiting} && ${playing} && ${done}))`,
  game: { ".validate": `newData.isString() && newData.val().matches(/^[a-z0-9-]{1,24}$/) && ${fixed}` },
  host: { ".validate": "newData.isString() && (data.exists() ? newData.val() === data.val() : newData.val() === auth.uid && newData.parent().child('players/s0').val() === auth.uid)" },
  seats: { ".validate": `newData.isNumber() && newData.val() >= 2 && newData.val() <= ${SEATS} && ${fixed}` },
  min: { ".validate": `newData.isNumber() && newData.val() >= 1 && newData.val() <= ${SEATS} && ${fixed}` },
  auto: { ".validate": `newData.isBoolean() && ${fixed}` },
  teams: { ".validate": "newData.val() === 0 || newData.val() === 2 || newData.val() === 3" },
  players: { $seat: { ".validate": `(${S.map(seatOk).join(" || ")}) && newData.isString() && (data.exists() ? newData.val() === data.val() : newData.val() === auth.uid)` } },
  status: { ".validate": "newData.val() === 'waiting' || newData.val() === 'playing' || newData.val() === 'done'" },
  turn: { ".validate": `newData.isNumber() && newData.val() >= 0 && newData.val() <= ${SEATS - 1}` },
  round: { ".validate": "newData.isNumber() && newData.val() >= 0" },
  createdAt: { ".validate": "newData.isNumber() && (data.exists() ? newData.val() === data.val() : newData.val() > now - 3600000 && newData.val() < now + 3600000)" },
  // Turn timer: seconds per turn (0 = off), fixed at creation; turnAt is when the current turn started.
  turnSecs: { ".validate": `newData.isNumber() && newData.val() >= 0 && newData.val() <= 3600 && ${fixed}` },
  turnAt: { ".validate": "newData.isNumber() && newData.val() <= now + 60000" },
  board: { ".validate": "newData.isString() && newData.val().length <= 256" },
  winner: { ".validate": `(newData.isNumber() && newData.val() >= 0 && newData.val() <= ${SEATS - 1}) || newData.val() === 'draw'` },
  line: { ".validate": "newData.isString() && newData.val().length <= 128 && newData.val().matches(/^[0-9,]*$/)" },
  last: { ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() < 256" },
  left: { ".validate": `newData.isNumber() && newData.val() >= 0 && newData.val() <= ${SEATS - 1}` },
  state: { ".validate": `newData.hasChildren() && ((${ps} !== 'playing' && ${ps} !== 'done') || (${ps} === 'playing' && (data.parent().child('players/s' + data.parent().child('turn').val()).val() === auth.uid || (${forfeiting}))) || (${ps} === 'done' && newData.parent().child('status').val() !== 'done'))` },
  online: perSeat("newData.isBoolean()"),
  again: perSeat("newData.isBoolean()"),
  names: perSeat(`newData.isString() && newData.val().matches(/${NAME_RE}/)`),
  $other: { ".validate": false },
};

// ---------- private/<code>/<seat>: one string only that seat's player can read or write ----------
const mySeat = `auth != null && $seat.matches(/${SEAT_RE}/) && root.child('rooms').child($code).child('players').child($seat).val() === auth.uid`;
const priv = {
  $code: {
    // The room's host may clear old private data left under a reused code, before the game starts.
    ".write": "auth != null && !newData.exists() && root.child('rooms').child($code).child('host').val() === auth.uid && root.child('rooms').child($code).child('status').val() === 'waiting'",
    $seat: { ".read": mySeat, ".write": mySeat, ".validate": "newData.isString() && newData.val().length <= 512" },
  },
};

// ---------- scores/<game>/<uid>: public leaderboards ----------
const scores = {
  $game: {
    ".read": "$game.matches(/^[a-z0-9-]{1,24}$/)",
    ".indexOn": ["score"],
    $uid: {
      ".write": "auth != null && auth.uid === $uid && newData.exists() && (!data.exists() || now - data.child('at').val() >= 5000)",
      ".validate": "newData.hasChildren(['name', 'score', 'at']) && (!data.exists() || newData.child('score').val() >= data.child('score').val())",
      name: { ".validate": "newData.isString() && newData.val().matches(/^[A-Za-z0-9][A-Za-z0-9 ]{0,11}$/)" },
      score: { ".validate": "newData.isNumber() && newData.val() > 0 && newData.val() <= 3932156 && newData.val() % 2 === 0" },
      at: { ".validate": "newData.val() === now" },
      $other: { ".validate": false },
    },
  },
};

const out = JSON.stringify({ rules: { rooms: { $code: room }, private: priv, scores } }, null, 2) + "\n";
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "firebase", "database.rules.json");
if (process.argv.includes("--check")) {
  if (fs.readFileSync(file, "utf8") !== out) {
    console.error("firebase/database.rules.json is out of date: run node scripts/rules.mjs");
    process.exit(1);
  }
  console.log("firebase/database.rules.json matches scripts/rules.mjs");
} else {
  fs.writeFileSync(file, out);
  console.log(`wrote firebase/database.rules.json (${SEATS} seats)`);
}
