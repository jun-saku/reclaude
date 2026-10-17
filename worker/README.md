# Game server

Real-time online games (everyone plays at once) run here instead of on a player's phone: a Cloudflare Worker with
one Durable Object per room, at `wss://play.reclaude.junsaku.dev`. Turn-based games don't need it.

- Rooms, the lobby, names, Leave/rejoin and leaderboards stay on Firebase (`shared/rooms.js`).
- Once a room is playing, each player connects with `shared/server.js` and the room's server runs the game:
  players send their input, the server sends each of them the game 10 times a second.
  There's no loop running on a timer: the game moves on each time a message arrives (phones send at least one
  every 100 ms), so each bit of work is a short request, well inside the free plan's CPU limit per request.
- A player connects with their Firebase sign-in (ID token, checked against Google's keys) and App Check token; the
  server reads the room as that player to find their seat. Anyone not seated is refused.
- Nothing keeps running once nobody plays: the loop stops when the last player disconnects, the game is kept 10
  minutes for anyone coming back, then the room's storage is deleted. Phones close their connection after 20 s in
  the background; silent connections are dropped after 30 s; games end after 2 hours.

## A game on the server

A game is a module in `src/games/` listed in `src/games.js` (see there for the functions it provides). The server
advances it in steps of 1/30 s and sends each player its `view`. Check every input: players can send anything.
`src/games/probe.js` is a minimal example (and what `tests/e2e/server.cjs` plays).

## Running it

- Locally, against the Firebase emulator: `npm ci && npm run dev` (port 8787; pages use it with
  `?backend=emulator`). `tests/e2e.cjs` starts it by itself.
- Live: deployed from `main` by `.github/workflows/pages.yml` (job `worker`) with the `CLOUDFLARE_API_TOKEN` secret,
  which needs "Workers Scripts: Edit" on top of Pages. Its address, `play.reclaude.junsaku.dev`, is a custom domain
  added once in the Cloudflare dashboard (Workers & Pages → reclaude-games → Settings → Domains & Routes).
- Cost: Durable Objects are on Cloudflare's free Workers plan (SQLite-backed only): 100,000 requests and 13,000 GB-s
  a day. Messages from players count 20 to a request, messages to them are free, so a 4-player game costs about
  2 requests a second at most; an empty room costs nothing.
