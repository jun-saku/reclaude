// Unit test of the Pickleball rotation (apps/pickleball/rotation.js): the algorithms and the overrides.
// Run: node tests/pickleball-rotation.test.mjs   (no dependencies; CI's build job)
import * as r from "../apps/pickleball/rotation.js";

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + m); };
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const all = (m) => [...m.a, ...m.b].sort().join("");
const P = ["A", "B", "C", "D", "E", "F", "G", "H"];

// ---------- queue ----------
let s = r.refresh(r.tidy(r.empty(), P.slice(0, 6)), "queue");
ok(same(s.order, ["A", "B", "C", "D", "E", "F"]), "everyone here joins the line in order");
ok(same(s.next, { a: ["A", "D"], b: ["B", "C"], manual: false }), "the first four play, 1st + 4th vs 2nd + 3rd");
let out = r.startNext(s, "queue");
ok(same(out.match, { a: ["A", "D"], b: ["B", "C"] }), "they go on a court");
s = out.state;
ok(same(s.order, ["E", "F"]) && s.games.A === 1, "they leave the line and have played once");
ok(same(s.next, { a: ["E"], b: ["F"], manual: false }), "two left: a singles match is next");
s = r.finish(s, "queue", out.match, "b");
ok(same(s.order, ["E", "F", "B", "C", "A", "D"]), "after the match they go to the back, winners first");

// ---------- fair ----------
s = r.tidy(r.empty(), P.slice(0, 6));
s = r.startNext(s, "fair").state;
s = r.finish(s, "fair", { a: ["A", "D"], b: ["B", "C"] }, null);
s = r.tidy(s, P.slice(0, 7));
s = r.refresh(s, "fair");
ok(all(s.next) === "AEFG", "fair: the three who haven't played (E, F, G) go first, then whoever waited longest (A)");

// ---------- winners stay ----------
s = r.tidy(r.empty(), P.slice(0, 8));
out = r.startNext(s, "winners_stay");
s = r.finish(out.state, "winners_stay", out.match, "a");
ok(same(s.next.a, ["A", "D"]) && all(s.next) === "ADEF", "winners stay on as a side; the next two in line challenge");
out = r.startNext(s, "winners_stay");
s = r.finish(out.state, "winners_stay", out.match, "a");
ok(!s.stay && s.order.slice(-4).includes("A") && !all(s.next).includes("A"), `after ${r.MAX_STREAK} wins, winners go to the back too`);

// ---------- overrides ----------
s = r.refresh(r.tidy(r.empty(), P.slice(0, 6)), "queue");
s = r.skip(s, "queue", "B");
ok(all(s.next) === "ACDE", "skip: B sits out the next match");
s = r.startNext(s, "queue").state;
ok(s.order[0] === "B" && all(s.next) === "BF", "and is first in line after it");

s = r.refresh(r.tidy(r.empty(), P.slice(0, 6)), "queue");
s = r.setAway(s, "queue", "A", true);
ok(all(s.next) === "BCDE" && s.order[0] === "A", "away: A is left out but keeps their place");
s = r.setAway(s, "queue", "A", false);
ok(all(s.next) === "ABCD", "back: A plays next again");

s = r.refresh(r.tidy(r.empty(), P.slice(0, 6)), "queue");
s = r.pair(s, "queue", "A", "F");
ok(same(s.next.a, ["A", "F"]) && all(s.next) === "ABCF", "pair: A and F play next, on the same side");
s = r.unpair(s, "queue", "F");
ok(all(s.next) === "ABCD", "unpair: back to the line's order");

s = r.refresh(r.tidy(r.empty(), P.slice(0, 6)), "queue");
s = r.swap(s, "queue", "B", "F");
ok(same(s.next, { a: ["A", "D"], b: ["F", "C"], manual: true }), "swap: F plays instead of B");
s = r.tidy(s, P.slice(0, 6));
s = r.refresh(s, "queue");
ok(s.next.manual && s.next.b[0] === "F", "a match changed by hand stays as it is");
s = r.swap(s, "queue", "A", "C");
ok(same(s.next.a, ["C", "D"]) && same(s.next.b, ["F", "A"]), "swapping two in the match changes their places");
s = r.repick(s, "queue");
ok(all(s.next) === "ABCD" && !s.next.manual, "pick again: back to the algorithm");

s = r.refresh(r.tidy(r.empty(), P.slice(0, 6)), "queue");
s = r.removeFromNext(s, "queue", "D");
ok(same(s.next, { a: ["A"], b: ["B", "C"], manual: true }), "take someone out: 1 v 2");
out = r.startNext(s, "queue");
ok(same(out.match, { a: ["A"], b: ["B", "C"] }) && out.state.order[0] === "D", "it starts as 1 v 2; D stays first in line");
s = r.removeFromNext(r.removeFromNext(s, "queue", "B"), "queue", "C");
ok(r.startNext(s, "queue").match === null, "a side with nobody can't start");
s = r.addToNext(s, "queue", "b", "E");
ok(same(s.next, { a: ["A"], b: ["E"], manual: true }), "put someone on an empty side");
s = r.addToNext(s, "queue", "b", "F");
s = r.addToNext(s, "queue", "b", "D");
ok(same(s.next.b, ["E", "F"]), "two a side at most");
s = r.addToNext(s, "queue", "a", "E");
ok(same(s.next, { a: ["A", "E"], b: ["F"], manual: true }), "moving someone to the other side");

s = r.refresh(r.tidy(r.empty(), ["A", "B", "C"]), "queue");
ok(s.next.a.length === 2 && s.next.b.length === 1, "three here: 2 v 1");
s = r.refresh(r.tidy(r.empty(), ["A"]), "queue");
ok(s.next === null, "one here: no match");

// ---------- people come and go ----------
s = r.refresh(r.tidy(r.empty(), P.slice(0, 6)), "queue");
s = r.tidy(s, ["A", "C", "D", "E", "F"]);
ok(!s.order.includes("B") && s.next === null, "whoever leaves drops out of the line and the next match");
s = r.tidy(r.refresh(s, "queue"), ["A", "C", "D", "E", "F", "G"], ["A", "C"]);
ok(same(s.order, ["D", "E", "F", "G"]), "players on a court aren't in line; newcomers join at the back");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
