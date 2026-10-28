// Unit test of the game server's spaces (worker/src/supabase.js, worker/src/space.js, worker/SPACES.md) in Node:
// the Supabase sign-in check with fetch faked, and an area run on a stand-in for its Durable Object (WebSockets,
// attachments, storage), including waking from hibernation. Run: node tests/space.test.mjs   (no dependencies; CI's build job)
import { checkPerson, Refused, SpaceDown } from "../worker/src/supabase.js";
import { Area } from "../worker/src/space.js";
import { SPACES } from "../worker/src/spaces.js";

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + m); };
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const UID = "5b1e2f3a-1111-4222-8333-944455556666";
const token = (claims) => `${enc({ alg: "ES256", typ: "JWT" })}.${enc({ role: "authenticated", sub: UID, exp: now + 3600, is_anonymous: false, ...claims })}.sig`;

// ---------- the sign-in check ----------
let calls = [], answer = {};
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  const path = String(url).split("/rest/v1/")[1] || "";
  const key = path.startsWith("accounts") ? "accounts" : path.startsWith("profiles") ? "profiles" : "role";
  const a = answer[key] ?? answer.all;
  if (a === "throw") throw new TypeError("fetch failed");
  if (typeof a === "number") return new Response("{}", { status: a });
  return new Response(JSON.stringify(a), { status: 200 });
};
const outcome = async (t, access = "accounts", env = {}) => {
  calls = [];
  try { return await checkPerson(t, access, env); } catch (err) { return err instanceof Refused ? `refused: ${err.message}` : err instanceof SpaceDown ? "down" : `error: ${err.message}`; }
};
const fine = { accounts: [{ username: "ann", active: true }], profiles: [{ display_name: "Ann 🌸", avatar: "🐱" }], role: true };

answer = fine;
const me = await outcome(token());
ok(me?.uid === UID && me.name === "Ann 🌸" && me.avatar === "🐱", "an active account gets in, with its profile's name and avatar");
const asked = calls.find((c) => c.url.includes("/accounts?"));
ok(asked && asked.init.headers.Authorization === `Bearer ${token()}` && asked.init.headers["Accept-Profile"] === "core" && asked.url.includes(`id=eq.${UID}`)
  && asked.url.startsWith("https://xikukwpayubiyxcnlwme.supabase.co/") && asked.init.headers.apikey.startsWith("sb_publishable_"),
  "Supabase is asked as that person (their token, the publishable key), for their own account");
ok((await outcome(token(), "accounts", { EMULATOR: "1" })) && calls[0].url.startsWith("http://127.0.0.1:54321/"), "the local test server asks the local Supabase");
answer = { ...fine, profiles: [] };
ok((await outcome(token()))?.name === "ann", "an account without a profile shows its username");
answer = fine;
for (const [t, why] of [["garbage", "junk"], [undefined, "nothing"], [token({ role: "anon" }), "the public anon role"], [token({ sub: "not-a-uuid" }), "a token without a proper user"],
  [token({ exp: now - 5 }), "an expired token"], [token({ is_anonymous: true }), "an anonymous sign-in"], ["x".repeat(5000), "a huge token"]]) {
  const r = await outcome(t);
  ok(typeof r === "string" && r.startsWith("refused") && !calls.length, `${why} is refused without asking Supabase`);
}
answer = { ...fine, all: undefined, accounts: 401 };
ok((await outcome(token())).startsWith("refused"), "a token Supabase doesn't accept (forged, signed by someone else) is refused");
answer = { ...fine, accounts: [] };
ok((await outcome(token())) === "refused: Only accounts can enter. Make one on your Profile page.", "a sign-in without an account is refused");
answer = { ...fine, accounts: [{ username: "ann", active: false }] };
ok((await outcome(token())) === "refused: This account is turned off.", "a deactivated account is refused at once (its token may still be valid)");
for (const a of ["throw", 503, 540, 500]) {
  answer = { ...fine, accounts: a };
  ok((await outcome(token())) === "down", `Supabase unreachable or paused (${a}): spaces are closed, not refused`);
}
answer = { ...fine, role: false };
ok((await outcome(token(), "role:plan/member")).startsWith("refused"), "a role space refuses someone without the role");
const roleCall = calls.find((c) => c.url.endsWith("/rpc/has_app_role"));
ok(roleCall && JSON.parse(roleCall.init.body).app === "plan" && JSON.parse(roleCall.init.body).role === "member", "it asks core.has_app_role for the space's app and role");
answer = fine;
ok((await outcome(token(), "role:plan/member"))?.uid === UID, "and lets someone with it in");
ok((await outcome(token(), "everyone")).startsWith("refused"), "an unknown access setting lets nobody in");

// ---------- an area ----------
SPACES.test = {
  areas: ["main"], version: 2, maxPeople: 2,
  create: () => ({ v: 2, n: 0, wakes: [] }),
  upgrade: (w, from) => ({ ...w, v: 2, upgradedFrom: from }),
  wake(w, away) { w.wakes.push(away); },
  join: (w, p) => ({ hello: p.id }),
  leave: (w, id) => ({ bye: id }),
  input(w, id, msg) { if (msg.t !== "add") return null; w.n++; return { n: w.n }; },
  view: (w, id) => ({ n: w.n, you: id, upgradedFrom: w.upgradedFrom, wakes: w.wakes }),
};
let clock = Date.now();
function makeCtx() {
  const sockets = [], store = new Map();
  return {
    sockets, store,
    acceptWebSocket(ws) { sockets.push(ws); },
    getWebSockets: () => sockets.filter((s) => !s.closed),
    getWebSocketAutoResponseTimestamp: (ws) => ws.pinged || null,
    storage: { get: async (k) => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); } },
  };
}
const sock = () => ({
  sent: [], closed: null, att: null,
  send(t) { if (this.closed) throw new Error("closed"); this.sent.push(JSON.parse(t)); },
  close(code, reason) { this.closed = { code, reason }; },
  serializeAttachment(a) { this.att = structuredClone(a); },
  deserializeAttachment() { return structuredClone(this.att); },
  last(t) { return [...this.sent].reverse().find((m) => m.t === t); },
});
const people = { tA: { uid: "A", name: "Ann", avatar: "🐱" }, tB: { uid: "B", name: "Bo", avatar: null }, tC: { uid: "C", name: "Cy", avatar: null } };
const check = async (t) => {
  if (t === "refuse") throw new Refused("Only accounts can enter.");
  if (t === "down") throw new SpaceDown("Spaces are asleep right now.");
  if (!people[t]) throw new Refused("Sign in first.");
  return people[t];
};
const ctx = makeCtx();
let area = new Area(ctx, {}, { check, now: () => clock });
const connect = async (t, space = "test", where = "main") => {
  const ws = sock();
  area.accept(ws, space, where);
  if (t !== undefined) await area.message(ws, JSON.stringify({ t: "hello", token: t }));
  return ws;
};

const A = await connect("tA");
ok(A.last("hi")?.me === "A" && A.last("hi").people.length === 1 && A.last("hi").view.n === 0, "a person enters and gets their id, who's here and the area");
ok(A.last("e")?.e.hello === "A", "the space's join() event goes out");
const B = await connect("tB");
ok(B.last("hi").people.map((p) => p.id).sort().join() === "A,B" && A.last("join")?.person.name === "Bo", "the next one sees both; the first is told who joined");
await area.message(A, JSON.stringify({ t: "add" }));
ok(A.last("e")?.e.n === 1 && B.last("e")?.e.n === 1 && B.last("e").by === "A", "a person's input goes to the space; its event reaches everyone, with who did it");
const before = B.sent.length;
await area.message(A, JSON.stringify({ t: "nonsense" }));
await area.message(A, "[1,2]");
ok(B.sent.length === before && !A.closed, "input the space ignores sends nothing");

const C = await connect("tC");
ok(C.closed?.code === 4006, "a full area refuses newcomers (the space's maxPeople)");
const A2 = await connect("tA");
ok(A.closed?.code === 4002 && A2.last("hi")?.me === "A" && !B.last("leave"), "the same person connecting again replaces their older connection, without leaving");
ok(A2.last("hi").people.length === 2 && !B.sent.slice(before).some((m) => m.t === "join" && m.person.id === "A"), "and isn't announced again");
await area.gone(A); // its close arrives afterwards
ok(!B.last("leave"), "the replaced connection closing later doesn't make them leave");

ok((await connect("refuse")).closed?.code === 4003, "a refused sign-in is closed with 4003 (its reason to show)");
ok((await connect("down")).closed?.code === 4010, "Supabase unreachable: closed with 4010, to try later");
ok((await connect("tC", "test", "nowhere")).closed?.code === 4004 && (await connect("tC", "nope", "main")).closed?.code === 4004, "an unknown space or area is refused");
const quiet = await connect(undefined);
await area.message(quiet, JSON.stringify({ t: "add" }));
ok(quiet.closed?.code === 4001, "anything but hello first is refused");
const big = await connect(undefined);
await area.message(big, "x".repeat(9000));
ok(big.closed?.code === 4009, "an oversized message is refused");
for (let i = 0; i < 25 && !B.closed; i++) await area.message(B, JSON.stringify({ t: "nonsense" }));
ok(B.closed?.code === 4008, "more than 20 messages a second is refused");
await area.gone(B);
ok(A2.last("leave")?.id === "B" && A2.last("e")?.e.bye === "B", "when someone's last connection closes, the others are told");

// Hibernation: the area forgets everything in memory; the connections (and their attachments) and storage remain.
ok(!ctx.store.has("world"), "nothing saved yet (a change is saved a few seconds later, in a batch)");
await area.save();
ok(ctx.store.get("world")?.v === 2 && ctx.store.get("world").world.n === 1, "the world is saved with the space's version");
clock += 60_000;
area = new Area(ctx, {}, { check, now: () => clock });
await area.message(A2, JSON.stringify({ t: "add" }));
ok(A2.last("e")?.e.n === 2, "after waking from hibernation, a person carries on (the world comes back from storage)");
ok(area.world.wakes.at(-1) === 60_000, "the space is told how long the area slept, to catch up");
const D = await connect("tB");
ok(D.last("hi")?.people.length === 2, "who's here comes back from the connections' attachments");

// Idle and dead connections are closed when anyone sends something.
clock += 11 * 60_000;
D.pinged = new Date(clock);
await area.message(D, JSON.stringify({ t: "add" }));
ok(A2.closed?.code === 4005 && D.last("leave")?.id === "A", "someone idle for 10 minutes is closed, freeing the place");
clock += 100_000;
const E = await connect("tA");
ok(D.closed?.code === 4005, "a connection with no input and no ping for 90 s is closed as gone");
await area.gone(E);
ok(ctx.store.get("world").world.n === 3, "when the last person leaves, the world is saved at once");

// Upgrading a saved world.
const old = makeCtx();
old.store.set("world", { v: 1, at: clock - 5000, world: { v: 1, n: 7, wakes: [] } });
area = new Area(old, {}, { check, now: () => clock });
const F = await connect("tA");
ok(F.last("hi")?.view.upgradedFrom === 1 && F.last("hi").view.n === 7, "a world saved by an older version is upgraded, keeping its contents");
const future = makeCtx();
future.store.set("world", { v: 9, at: clock, world: {} });
area = new Area(future, {}, { check, now: () => clock });
let threw = false;
try { await connect("tA"); } catch { threw = true; }
ok(threw && !future.store.get("world").world.n, "a world from a newer version is never overwritten");

// ---------- the Plaza's rules (apps/plaza/space.js) ----------
const { default: plaza, MAP, W, H, REACTIONS, route, walkable } = await import("../apps/plaza/space.js");
ok(MAP.every((row) => row.length === W) && H === MAP.length && SPACES.plaza === plaza, "the Plaza's map is rectangular and the server runs it");
const pw = plaza.create("main");
const evJoin = plaza.join(pw, { id: "ann" }, { now: 0 });
ok(evJoin && walkable(...pw.spots.ann), "someone new appears on a free walkable spot");
plaza.join(pw, { id: "bo" }, { now: 0 });
ok(pw.spots.bo.join() !== pw.spots.ann.join(), "the next newcomer gets another spot");
const goal = [2, 9];
const walked = plaza.input(pw, "ann", { t: "go", x: goal[0], y: goal[1] }, { now: 0 });
ok(walked?.path.at(-1).join() === goal.join() && pw.spots.ann.join() === goal.join(), "walking finds a way to the tile and ends there");
ok(walked.path.every(([x, y], i) => walkable(x, y) && Math.abs(x - (i ? walked.path[i - 1][0] : 6)) + Math.abs(y - (i ? walked.path[i - 1][1] : 1)) === 1), "one tile at a time, never through water or trees");
const water = [6, 5];
ok(!plaza.input(pw, "ann", { t: "go", x: water[0], y: water[1] }, { now: 0 }) && !plaza.input(pw, "ann", { t: "go", x: 0, y: 0 }, { now: 0 }), "the fountain and the trees can't be walked onto");
ok(!plaza.input(pw, "ann", { t: "go", x: 99, y: 2 }, { now: 0 }) && !plaza.input(pw, "ann", { t: "go", x: "1", y: 2 }, { now: 0 }) && !plaza.input(pw, "ann", { t: "go", x: 2.5, y: 2 }, { now: 0 }), "off the map or not a tile: ignored");
ok(!plaza.input(pw, "ghost", { t: "go", x: 2, y: 2 }, { now: 0 }), "someone who never joined can't move");
ok(plaza.input(pw, "ann", { t: "react", i: 0 }, { now: 5000 })?.react === 0, "a reaction goes out");
ok(!plaza.input(pw, "ann", { t: "react", i: 1 }, { now: 5500 }) && plaza.input(pw, "ann", { t: "react", i: 1 }, { now: 6100 }), "at most one reaction a second each");
ok(!plaza.input(pw, "ann", { t: "react", i: REACTIONS.length }, { now: 9000 }) && !plaza.input(pw, "ann", { t: "react", i: "👋" }, { now: 9000 }), "only the listed reactions: no free text");
ok(plaza.join(pw, { id: "ann" }, { now: 0 }) === null && pw.spots.ann.join() === goal.join(), "coming back, you're where you left");
ok(route([1, 6], [11, 6])?.length >= 10, "the way round the fountain is found");
ok(JSON.stringify(plaza.view(pw)).length < 1000, "the area's view is small");

console.log(`\nFAILS: ${fails}`);
process.exit(fails ? 1 : 0);
