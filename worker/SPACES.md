# Spaces

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
  now. `Space` hands the work to `src/space.js`, which has no Cloudflare imports so the tests run it in Node.
- Spaces are defined in code, in `src/spaces.js` (like `src/games.js`, with the list of what a space provides): a name
  or area that isn't listed is closed at once (4004) without making a Durable Object, so nobody can create spaces by
  typing addresses. `src/spaces/probe.js` is a minimal example, used by the tests.
- Pages enter with `shared/space.js` (see the top of it), which signs in with `shared/core.js`.
- No Firebase room, no database rules change.

## Who gets in

A space says who may enter; the server enforces it (the page only shows a friendly message, it is never the check):

- `access: "accounts"`: Supabase accounts only (the default). Later `"role:<app>/<role>"` for a project role.
- The page connects and first sends `{ t: "hello", token: <Supabase access token> }`.
- The server (`src/supabase.js`) asks Supabase, as that person (their token and the public publishable key), for
  their account and profile, once per connection. Supabase refuses a token it didn't sign or an expired one, so the
  server needs no key of its own, whichever kind of signing key the project uses. No account (an anonymous sign-in),
  or `active` false (a deactivated account, whose token can stay valid up to an hour), is refused. A role space
  also asks `core.has_app_role`. The name and avatar shown are the account's profile (or its username).
- If Supabase doesn't answer within 5 s (the free plan pauses an idle project), the server closes with 4010 and the
  page says "Spaces are asleep right now". Spaces fail closed; games, which never use Supabase, are unaffected.

## Limits

Accounts are invite-only, so who can use spaces is already bounded. On top of that, per space:

- One connection per account: a newer one replaces the older (which is told, and doesn't retry).
- At most 30 people per area (a space can say fewer); beyond it, "This space is full".
- At most 20 messages a second per connection, 1 KB each (8 KB for the hello).
- Closed after 10 minutes without input, or 90 s without even a ping, freeing the place.

No daily budget counter for now. Cloudflare's dashboard shows Durable Object usage per day; if it gets near the free
allowance, add a counter that stops admitting people to spaces at a share of it, keeping the rest for games (which
are never refused, and would report their usage to it).

## Running it cheaply

- **Only awake while used.** The first connection wakes the area and loads its world; it sleeps when the last one
  goes. Things that happen while nobody's there (fish coming back, crops growing) are worked out on waking from the
  time stored with them; an alarm only when something really must happen at a set time.
- **Hibernation.** Connections are accepted with `ctx.acceptWebSocket`, so an area sleeps even with people
  connected when nobody does anything, and pings are answered with `setWebSocketAutoResponse` without waking it.
  Phones send input only when it changes (unlike matches, which send every 100 ms) and ping every 20 s.
- **Small updates.** A newcomer gets the whole area once; after that only events (what someone's input changed,
  who came or went), as they happen. There's no clock running in the area: anything moving smoothly is drawn by
  the phones between events.

## The saved world

- Kept in the area's own storage, written in batches (5 s after a change, and when the last person leaves), never
  on every move; at most 100 KB.
- Stored with a format version from day one. A change of format comes with code that upgrades old saves on load:
  reverting a PR doesn't undo stored data.
- Never deleted by a timer, unlike match rooms. A world saved by a newer version is never overwritten by older code.

## Areas

A space is split into areas from the start, even if the first space has only one: one Durable Object per area keeps
each one small (a few dozen people at most), and people move between areas (the next room of the office, the next
chunk of a build world) by reconnecting to the next one. A page only ever downloads the area it's in.

## Plan

1. This note.
2. Engine: `Space` class, routing, Supabase sign-in and active check, limits, hibernation, saving with versions,
   `shared/space.js`, and `tests/space.test.mjs` (sign-ins allowed and refused, join, move, leave, replaced tabs,
   limits, waking from hibernation, upgrades). Done.
3. First space: a pixel plaza (walk around with your avatar, emoji reactions), linked from the home page. Measure
   loading time, data and usage there.
4. Something to do in it: fishing, a build canvas or office rooms.
