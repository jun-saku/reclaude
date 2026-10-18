---
name: new-game
description: How to build or change a game in reclaude on the shared game engine (shared/rooms.js + the Firebase rules) — online rooms, lobby, 2–10 players, teams, turns, turn timer, hidden hands, names, Leave, Play again, leaderboards. Use whenever someone asks to add a game, make a game multiplayer or online, or change an existing game.
---

# Making a game for reclaude

reclaude is a set of small web games on one engine. Each game is its own folder, `projects/<name>/`, published at
`https://reclaude.junsaku.dev/<name>/`. Online games all use the same engine: `shared/rooms.js` (rooms, turns, players)
and `firebase/database.rules.json` (who may write what). Read `CLAUDE.md` first; this file adds the game-specific part.

## The one rule that keeps games independent

- **A game PR touches only `projects/<name>/`** (plus a README line, its card on the games page
  `site/games/index.html`, and its own test file `tests/e2e/<name>.cjs` if you add one). A change like that cannot
  break another game: games don't import each other and their rooms are tagged with their own name.
- **Changes to `shared/` or the rules go in their own PR**, titled as an engine change, never inside "add my game".
  Every online game uses them, so a change there goes live for all games at once: run `cd tests && npm run e2e` and
  `npm run rules` (CI's `e2e` job also runs every game's test for such a PR) and try each online game on the preview
  before asking for a merge.
- Need something the engine doesn't do? Keep it inside your game if you can (in `state`, private data, or the page).
  Only if that's impossible, propose an engine change as a separate PR first.

## Steps

1. `node scripts/new-project.mjs <name> "Title" "One-sentence description"` (lowercase-kebab-case; the name is the URL
   and can't change later).
2. Build the game in `projects/<name>/index.html` (more files next to it if needed). No build step, no npm packages.
   Follow `CLAUDE.md` → "Adding a project": phone first, touch controls, safe-area padding, light and dark mode,
   relative paths only.
   Page conventions the smoke test and shared styles rely on:
   - The `‹ All games` link (`<a class="home-link" href="../games/">`, styles included) first in `<main>`, copied from
     any other game. It hides itself while `<section id="home">` (the start screen) is hidden, so players use Leave
     in a room.
   - A same-phone mode, if the game has one, starts from a button with `id="local"` and hides `#home`.
   - Security policy (added by the build): scripts only in `<script>` blocks or files in the folder; no `onclick=`
     -style attributes (use `addEventListener`), no `eval`/`new Function`, no external sources beyond those allowed
     in `CLAUDE.md`. They would be blocked in the browser.
   - Escape anything a player typed (names) before putting it into HTML.
3. For online play: `import * as rooms from "../shared/rooms.js";` (exactly this form; the build adds a cache-busting
   version). **Start from `projects/five-line/index.html`**, the most complete example: lobby, 2–4 players, teams,
   hidden hands, names, timer, pass, Leave, Play again. `chain-reaction` is a simpler 2–6 player example with a
   same-phone mode; `four-in-a-row` a small 2-player one.
4. Follow the design standard, [DESIGN.md](DESIGN.md): the title, the wording, the home screen's sections and their
   order (create and join rooms), the lobby, the game screen and the controls. The kit does most of it; a game with
   its own screens copies it. Then run the design check, `node scripts/build.mjs && node tests/ui-audit.cjs <name>`,
   and fix everything it reports until it says `0 problem(s).` (CI's `ui` job runs it on every PR).
5. Test (below), add a line to `README.md` under Projects and a card to `site/games/index.html` (newest first: icon, title,
   one line, player tags), commit, push, open a PR.

## The game kit (start here for a new game)

`shared/kit.js` runs everything around a game, so a game is its rules and its drawing:

```
projects/<name>/game.js     the rules: no drawing, no network (the game server bundles it too)
projects/<name>/index.html  <link rel="stylesheet" href="../shared/kit.css">, the "‹ All games" link in <main>, and
                            start(game, { title, howTo, setup(stage), render(info), frame(info), … })
```

- `game.js` exports `{ id, kind: "turns" | "realtime", players: [min, max], modes: ["solo", "local", "online"],
  setup({ players }), input(state, seat, move), result(state), … }`; turn-based games add `turn(state)`, real-time
  games `tick(state, dt)` and `join`/`leave`. The full list is at the top of `shared/kit.js`.
- The kit builds the home screen (name, Solo / Same phone / Create / Join), the lobby, the player bar, Leave, game
  over, Play again and (with `leaderboard`) the Top 10, and runs the game: on the phone for solo and one-phone play;
  online turn-based through Firebase rooms (the state is JSON in `state.g`, the player on turn writes each move and the
  rules refuse anyone else); online real-time on the game server, which runs the same `game.js` (list it in
  `worker/src/games.js` with `kitGame(...)`).
- The page draws `info.view` in `render(info)` (or every frame in `frame(info)` for real-time games) and plays with
  `info.act(move)`. `projects/tanks/` is the real-time example; `tests/fixtures/kit-turns/` a minimal turn-based one.
- Not yet in the kit: hidden per-player data for turn-based games (use rooms.js private data directly, as Five Line
  does), turn timers and teams. Games that need those still use rooms.js directly, as below.

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

## Real-time games (the game server)

For games where everyone plays at once, run the game on the game server (`worker/`, see `worker/README.md`) rather
than on a player's phone: no phone is in charge, so a player switching apps or losing signal only affects their own
tank. The room and lobby work as usual on Firebase; once it's playing, connect with `shared/server.js`
(`server.connect(seat, room, { onState, onStatus })`, `send(msg)`, `close()`), and write the game's rules as a
module in `worker/src/games/<name>.js` (listed in `worker/src/games.js`). That module is part of the game's PR (the
one exception to "only `projects/<name>/`"). Test it with `tests/e2e/<name>.cjs`: `tests/e2e.cjs` runs the server
locally. Keep the page's own solo mode working without the server.

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
- Smoke test: `node scripts/build.mjs && node tests/smoke.cjs` (also part of the required `build` check). It finds new
  games by itself; a project that isn't a game (no card, no link) goes in its `NOT_GAMES` list.
- Real rules: `cd tests && npm run e2e` (the real Firebase SDK on the emulator). For a new online game, add
  `tests/e2e/<name>.cjs` (named like the game's folder) that plays one game through and checks the winner, like
  `five-line.cjs`; CI then runs it on every PR that changes the game. `E2E=<name> npm run e2e` runs just yours.
- Drive it with Playwright at 390px wide, screenshot light and dark, and look at the screenshots before pushing.
- Real Firebase: App Check is enforced, so only the live site and the PR's Cloudflare preview can reach it (not a
  local server). Ask the user to play one online game on the preview, across two devices, before merging.
- An engine PR also needs `npm run rules`, new cases in `tests/rules.test.mjs`, and rules edited in
  `scripts/rules.mjs` (then `node scripts/rules.mjs`), never in the JSON.

## Before asking for a merge

- [ ] The PR touches only `projects/<name>/` (+ README, + its landing-page card, + its own `tests/e2e/<name>.cjs`), or is clearly an engine PR.
- [ ] Works on a phone: touch, no sideways scroll, safe areas, light and dark.
- [ ] Follows [DESIGN.md](DESIGN.md), and `node tests/ui-audit.cjs <name>` reports 0 problems (title, standard
      wording and section order, 44 px controls, 12 px text, 4.5:1 contrast, labels; mark the board or rack container
      `data-small-ok`). Text on an accent button uses `var(--on-accent)`.
- [ ] Online: create, join by code and by link, play to a win, Play again, Leave mid-game, reload mid-game
      (`?backend=fake` and the emulator test), then the user tries it on the preview.
- [ ] `node scripts/build.mjs` and `node tests/smoke.cjs` pass, and `E2E=<name> npm run e2e` passes if the game is online.
- [ ] Short summary for the user with the game link and the PR's Cloudflare preview link.
