// Unit test of feeds (shared/feed.js) as the game server sends them (worker/src/kit.js) and a page puts them back
// together: each connection gets only what's new, everything when it (re)connects, and a fresh list for the next
// drawing or a new game. Run: node tests/feed.test.mjs   (no dependencies; CI's build job)
import { feedPart, feedJoin } from "../shared/feed.js";
import { kitGame } from "../worker/src/kit.js";

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + m); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The pure functions.
let [part, had] = feedPart({ id: "a", items: [1, 2] }, null);
ok(same(part, { id: "a", from: 0, items: [1, 2] }) && same(had, { id: "a", n: 2 }), "a new connection gets the whole list");
[part, had] = feedPart({ id: "a", items: [1, 2] }, had);
ok(part === null, "nothing new: nothing sent");
[part, had] = feedPart({ id: "a", items: [1, 2, 3, 4] }, had);
ok(same(part, { id: "a", from: 2, items: [3, 4] }), "then only what was added");
[part, had] = feedPart({ id: "b", items: [9] }, had);
ok(same(part, { id: "b", from: 0, items: [9] }), "a new id: the new list, whole");
[part] = feedPart({ id: "b", items: [] }, { id: "b", n: 5 });
ok(same(part, { id: "b", from: 0, items: [] }), "a list that got shorter (can't happen) is sent whole");
let list = feedJoin(null, { id: "a", from: 0, items: [1] });
list = feedJoin(list, { id: "a", from: 1, items: [2, 3] });
ok(same(list, { id: "a", items: [1, 2, 3] }), "the page appends pieces");
list = feedJoin(list, { id: "a", from: 7, items: [8] });
ok(same(list.items, [1, 2, 3]), "a piece that doesn't follow on is ignored");
list = feedJoin(list, undefined);
ok(same(list.items, [1, 2, 3]), "an update without a piece keeps the list");

// Through the server's kit adapter: a game whose feed is its strokes, cleared each turn.
const game = {
  setup: () => ({ turn: 1, strokes: [] }),
  input(g, seat, m) { if (m.t === "draw") g.strokes.push(m.p); if (m.t === "next") { g.turn++; g.strokes = []; } },
  result: (g) => (g.turn > 3 ? { winner: 0 } : null),
  view: (g) => ({ turn: g.turn }),
  feed: (g) => ({ id: g.turn, items: g.strokes }),
};
const mod = kitGame(game);
const st = mod.create({ seats: 2, players: { s0: "u0", s1: "u1" } });
mod.join(st, 0); mod.join(st, 1);
const a = {}, b = {};
const pageA = { list: null }, pageB = { list: null };
const update = (conn, page, seat) => { const msg = mod.view(st, seat, conn); page.list = feedJoin(page.list, msg.f); return msg; };
update(a, pageA, 0); update(b, pageB, 1);
for (let i = 0; i < 5; i++) mod.input(st, 0, { t: "in", m: { t: "draw", p: [i, i] } });
let msg = update(b, pageB, 1);
ok(msg.f && msg.f.from === 0 && msg.f.items.length === 5, "the server sends a connection only the new strokes");
ok(update(b, pageB, 1).f === undefined, "and nothing while nothing's new");
mod.input(st, 0, { t: "in", m: { t: "draw", p: [5, 5] } });
msg = update(b, pageB, 1);
ok(same(msg.f, { id: "0:1", from: 5, items: [[5, 5]] }), "one new stroke: just that one");
const c = {}, pageC = { list: null };
msg = update(c, pageC, 1);
ok(msg.f.from === 0 && pageC.list.items.length === 6, "a reconnecting player gets the whole drawing at once");
mod.input(st, 0, { t: "in", m: { t: "next" } });
update(a, pageA, 0); update(b, pageB, 1);
ok(pageB.list.id === "0:2" && pageB.list.items.length === 0, "the next turn starts an empty drawing");
mod.input(st, 1, { t: "in", m: { t: "draw", p: [1, 1] } });
update(a, pageA, 0);
ok(same(pageA.list.items, [[1, 1]]), "and fills it piece by piece");
// The game ends; both play again: same ids again, but a new list.
mod.input(st, 0, { t: "in", m: { t: "next" } }); mod.input(st, 0, { t: "in", m: { t: "next" } });
ok(!!mod.view(st, 0, {}).over, "the game ends");
mod.input(st, 0, { t: "again" }); mod.input(st, 1, { t: "again" });
update(a, pageA, 0);
ok(pageA.list.id === "1:1" && pageA.list.items.length === 0, "Play again starts a new list even though the game's ids repeat");

console.log(fails ? `\n${fails} failed` : "\nAll passed.");
process.exit(fails ? 1 : 0);
