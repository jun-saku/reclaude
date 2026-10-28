# Spaces (design, not built yet)

A space is a place that's always there: people come and go, move around, and rack up points or build things, and
the space remembers it. A hangout (a pixel plaza, office-style rooms), a drop-in game (fishing, a snake arena) or a
shared creation (a build world). It runs on this game server, next to the match rooms Tanks uses.

## Matches and spaces

|                 | Match room (`GameRoom`, now)                    | Space (`Space`, new)                                   |
|-----------------|-------------------------------------------------|--------------------------------------------------------|
| Who             | 2–10 fixed seats                                | anyone allowed in, any time, up to a cap               |
| Flow            | lobby → play → game over → Play again           | open the link and you're in                            |
| Lifetime        | one match; deleted 10 min after everyone leaves | kept: its world is saved                               |
| Sign-in         | Firebase (anonymous), seat read from the room   | Supabase account (`shared/core.js`)                    |
| Client          | `shared/kit.js` + `shared/server.js`            | `shared/space.js`                                      |
| Fits            | a game with a start, an end and a winner        | a place people drop into, that remembers tomorrow      |

Matches stay as they are: anyone can play without an account, and nothing a game needs depends on Supabase. Tanks
doesn't change. A space can link to a match (gather in a space, then start a Tanks room together), never become one.

## Where it lives

- The same Worker (`reclaude-games`, `play.reclaude.junsaku.dev`), with a second Durable Object class, `Space`:
  a `SPACES` binding and a `v2` migration (`new_sqlite_classes = ["Space"]`) in `wrangler.toml`.
- `src/index.js` sends `/space/<name>/<area>` to `Space` (one object per area) and everything else to `GameRoom` as
  now. `space` becomes a reserved project name in `scripts/build.mjs`.
- Spaces are defined in code, in `src/spaces.js` (like `src/games.js`): a name that isn't listed is a 404, so nobody
  can create spaces by typing addresses.
- No Firebase room, no database rules change.

## Who gets in

A space says who may enter; the server enforces it (the page only shows a friendly message, it is never the check):

- `access: "accounts"`: Supabase accounts only (the default). Later `"role:<app>/<role>"` for a project role.
- The page connects and first sends `{ t: "hello", token: <Supabase access token> }`.
- The server verifies the token with Supabase's public signing keys (as `src/auth.js` does for Firebase's), and
  refuses anonymous users (`is_anonymous` in the token).
- A token stays valid up to an hour after an account is deactivated, so the server also calls `core.is_active()`
  (and `core.has_app_role` for role spaces) as that user, once per connection.
- If Supabase can't be reached (the free plan pauses an idle project), the server refuses with a reason and the
  page says "Spaces are asleep right now". Spaces fail closed; games, which never use Supabase, are unaffected.

## Limits

Accounts are invite-only, so who can use spaces is already bounded. On top of that, per space:

- One connection per account: a second tab replaces the first.
- A cap on people per area (about 30); beyond it, "This space is full".
- The message rate limit `GameRoom` already has (`MAX_RATE`), and the same message size limits.
- An idle kick after a few minutes without input, so a forgotten tab doesn't keep a space awake.

No daily budget counter for now. Cloudflare's dashboard shows Durable Object usage per day; if it gets near the free
allowance, add a counter that stops admitting people to spaces at a share of it, keeping the rest for games (which
are never refused, and would report their usage to it).

## Running it cheaply

- **Only awake while used.** The first connection wakes the area and loads its world; it sleeps when the last one
  goes. Things that happen while nobody's there (fish coming back, crops growing) are worked out on waking from the
  time stored with them; an alarm only when something really must happen at a set time.
- **Hibernation.** Connections are accepted with `ctx.acceptWebSocket`, so an area sleeps even with people
  connected when nobody does anything, and pings are answered with `setWebSocketAutoResponse` without waking it.
  Phones send input only when it changes (unlike matches, which send every 100 ms).
- **Small updates.** After the first full snapshot of the area, only what changed, at most 10 times a second (fewer
  for slow spaces).

## The saved world

- Kept in the area's own storage, written in batches (every few seconds and when the last person leaves), never on
  every move.
- Stored with a format version from day one. A change of format comes with code that upgrades old saves on load:
  reverting a PR doesn't undo stored data.
- Never deleted by a timer, unlike match rooms.

## Areas

A space is split into areas from the start, even if the first space has only one: one Durable Object per area keeps
each one small (a few dozen people at most), and people move between areas (the next room of the office, the next
chunk of a build world) by reconnecting to the next one. A page only ever downloads the area it's in.

## Plan

1. This note.
2. Engine PR: `Space` class, routing, Supabase token and active check, limits, hibernation, saving with versions,
   `shared/space.js`, and tests (allowed and refused sign-ins, join, move, leave, rejoin with the world kept).
3. First space: a pixel plaza (walk around with your avatar, emoji reactions), linked from the home page. Measure
   loading time, data and usage there.
4. Something to do in it: fishing, a build canvas or office rooms.
