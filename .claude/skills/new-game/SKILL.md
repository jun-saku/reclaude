---
name: new-game
description: How to build or change a game in reclaude on the shared game engine (shared/rooms.js + the Firebase rules) — online rooms, lobby, 2–10 players, teams, turns, turn timer, hidden hands, names, Leave, Play again, leaderboards. Use whenever someone asks to add a game, make a game multiplayer or online, or change an existing game.
---

# Making a game for reclaude

reclaude is a set of small web games on one engine. Each game is its own folder, `projects/<name>/`, published at
`https://reclaude.junsaku.dev/<name>/`. Online games all use the same engine: `shared/rooms.js` (rooms, turns, players)
and `firebase/database.rules.json` (who may write what). Read `CLAUDE.md` first; this file adds the game-specific part.

## The one rule that keeps games independent

- **A game PR touches only `projects/<name>/`** (plus a README line, and its own section in `tests/e2e.cjs` if you add
  one). A change like that cannot break another game: games don't import each other and their rooms are tagged with
  their own name.
- **Changes to `shared/` or the rules go in their own PR**, titled as an engine change, never inside "add my game".
  Every online game uses them, so a change there goes live for all games at once: run `cd tests && npm run e2e` and
  `npm run rules` and try each online game before asking for a merge.
- Need something the engine doesn't do? Keep it inside your game if you can (in `state`, private data, or the page).
  Only if that's impossible, propose an engine change as a separate PR first.

## Steps

1. `node scripts/new-project.mjs <name> "Title" "One-sentence description"` (lowercase-kebab-case; the name is the URL
   and can't change later).
2. Build the game in `projects/<name>/index.html` (more files next to it if needed). No build step, no npm packages.
   Follow `CLAUDE.md` → "Adding a project": phone first, touch controls, safe-area padding, light and dark mode,
   relative paths only.
3. For online play: `import * as rooms from "../shared/rooms.js";` (exactly this form; the build adds a cache-busting
   version). **Start from `projects/five-line/index.html`**, the most complete example: lobby, 2–4 players, teams,
   hidden hands, names, timer, pass, Leave, Play again. `four-in-a-row` is a smaller 2-player example with a
   same-phone mode.
4. Test (below), add a line to `README.md` under Projects, commit, push, open a PR.

## The engine, in short

A room is one object at `rooms/<CODE>`:

```
{ game, host, seats, min, auto, teams, players: { s0: uid, … }, status: "waiting" | "playing" | "done",
  turn: <seat>, round, createdAt, board?, winner?: <seat | team> | "draw", line?, last?, left?, state?: { … },
  online?: { s0: true, … }, again?: { … }, names?: { s0: "Jun", … }, turnSecs?, turnAt? }
```

Seats are numbers 0–9 in code and keys `s0`–`s9` in the room. **Put your game's data in `board` (a string, ≤ 256
chars) and `state` (any object).** Any other new top-level field is refused by the rules. Hidden data (a hand, a
secret goal) goes in private data: one string per seat, ≤ 512 chars, readable only by that seat's player.

| Function | What it does |
| --- | --- |
| `createRoom(game, { seats, min, auto, turnSecs, makeRoom })` | New room, creator is host in seat 0. `seats` 2–10; `min` players to start; `auto: true` starts when full, `false` = host taps Start; `turnSecs` 0 = no timer; `makeRoom()` returns your initial `board`/`state`/`turn`. Returns `seat` = `{ backend, code, seat }`. |
| `joinRoom(game, code)` | Takes the first free seat, or rejoins your old one. Throws `RoomError` with a message for players. |
| `startGame(seat, setup)` | Host only, in a lobby: `setup(room)` deals and returns the room; status becomes `playing`. |
| `enter(seat, onRoom, onGone)` | Watch the room and keep your online dot; returns `leave()`. |
| `seat.backend.transact(code, fn)` | Change the room: `fn(cur)` returns the new room, or `undefined` to abort. Firebase may call it again with fresher data, so check the turn inside `fn`. |
| `seat.backend.setPrivate(code, seat, str)` / `watchPrivate(code, seat, cb)` | Your hidden data. |
| `quit(seat)` | Leave for good: forfeits a game in play, closes the host's lobby. Call it before `leave()`. |
| `playAgain(seat, deal)` | Marks you ready; once everyone online is ready, `deal(room, round)` sets up the next round. |
| `skipTurn(seat, room)` / `turnLeft(room)` | Turn timer: seconds left, and passing an overdue turn on. |
| `nameOf(room, s)`, `myName()`, `setMyName(name, seat?)` | Player names (escape them before putting them in HTML). |
| `seatList`, `playerCount`, `seatOf`, `nextSeat`, `teamOf`, `isOnline`, `wantsAgain` | Small helpers. |
| `localRoom(game, players, makeRoom)` | Same-phone mode, no network. |
| `share(code, title)`, `roomFromUrl()` | Share links; open `?room=CODE` to join directly. |
| `topScores(game, n, order)`, `myScore(game)`, `saveScore(game, name, score, { order })` | Public leaderboard at `scores/<game>`, one entry per player. `order: "high"` (default) or `"low"` is better; `saveScore` only saves an improvement and throws `RoomError` with a message otherwise. |
| `topTen({ game, rooms, button, order, format })` from `shared/leaderboard.js` | The shared 🏆 Top 10 sheet (Reload, close, your entry highlighted, fits the page's colours). Pass `rooms: () => import("../shared/rooms.js")`; call `sheet.stale()` after saving. See 2048. |

## What the rules enforce (write your game to fit)

- **Waiting:** only the host changes the room; others may only take a seat.
- **Playing:** only the player in seat `turn` may change `board`, `turn`, `winner`, `line`, `last`, `round`,
  `teams`, `left` or `state`. So make every move inside a `transact` by the player on turn, and pass the turn by
  setting `turn` (usually `rooms.nextSeat(room, me)`) in the same write. There are no moves out of turn and no
  simultaneous moves.
- **Done:** the result is fixed. The next round must set `round` to `round + 1` (`playAgain` does).
- Anyone seated may forfeit (`quit`), set their own online dot, Play-again flag and name, and skip an overdue turn.
- `turnAt` is stamped automatically whenever a write changes `turn`, `round` or starts the game. Don't set it.
- The rules check whose turn it is, not whether a move is legal: the player on turn is trusted. This is a personal
  project, so that's fine; just check moves in your own code so honest mistakes can't happen.
- Leaderboards are generic: a name (1–12 letters, numbers, spaces), any number as the score, at most one save
  every 5 seconds. **What a valid score is belongs in your game** (2048 checks it's even and possible, for example).

## Patterns that already work

- **Hidden hands:** in `startGame`'s setup, shuffle the deck into `state`; each player then saves their own slice to
  private data. After a move, save the new hand right after the room write (Five Line shows how, including repairing
  a hand whose save failed).
- **Teams:** `teams: 2` in `makeRoom`; seats alternate teams (`teamOf`). Require all seats with `min: seats`.
- **Pass / nothing to play:** advance `turn` without changing the board; end the game when everyone passes.
- **End of game:** set `status: "done"` and `winner` in the winning move's write. Keep the result on screen; Play
  again waits for everyone.
- **Leaving:** confirm mid-game ("Your friend wins this round"), then `await rooms.quit(seat)` and go home.
- **Leaderboard:** check the score yourself, `rooms.saveScore(game, name, score, { order })`, show the error message
  if it throws, then `sheet.stale()`. Open the sheet with `topTen({ …, button })`.

## Testing

- Quick UI test: open the page with `?backend=fake` in several tabs of one browser (they share rooms, no rules).
- Real rules: `cd tests && npm run e2e` (the real Firebase SDK on the emulator). For a new online game, add a short
  section to `tests/e2e.cjs` that plays one game through and checks the winner, like the Five Line section.
- Drive it with Playwright at 390px wide, screenshot light and dark, and look at the screenshots before pushing.
- An engine PR also needs `npm run rules`, new cases in `tests/rules.test.mjs`, and rules edited in
  `scripts/rules.mjs` (then `node scripts/rules.mjs`), never in the JSON.

## Before asking for a merge

- [ ] The PR touches only `projects/<name>/` (+ README, + its own e2e section), or is clearly an engine PR.
- [ ] Works on a phone: touch, no sideways scroll, safe areas, light and dark.
- [ ] Online: create, join by code and by link, play to a win, Play again, Leave mid-game, reload mid-game.
- [ ] `node scripts/build.mjs` passes, and `npm run e2e` passes if the game is online.
- [ ] Short summary for the user with the game link and the PR's Cloudflare preview link.
