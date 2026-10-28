// A space's area: what the Space Durable Object (src/index.js) runs, kept free of Cloudflare's own modules so the
// tests can run it in Node with a stand-in for the object's ctx (tests/space.test.mjs). See SPACES.md.
//
// People connect to wss://play.reclaude.junsaku.dev/space/<space>/<area> and first send
//   { t: "hello", token: <Supabase access token> }
// The server checks it (src/supabase.js) and answers { t: "hi", me, people: [{ id, name, avatar }], view }; then:
// - a person's messages go to the space's input(), and whatever event it returns is sent to everyone in the area as
//   { t: "e", by, e: event };
// - { t: "join", person } / { t: "leave", id } as people come and go;
// - the text "ping" is answered "pong" by Cloudflare itself without waking the area (hibernation).
// Closing codes: 4003 refused (with the reason to show; retrying won't help), 4006 full, 4010 Supabase can't be
// reached (try later), 4002 connected again elsewhere, 4005 idle, 4000/4008/4009 bad messages.
//
// The area sleeps (hibernates) whenever nobody sends anything, even with people connected: everything it needs to
// carry on is in each connection's attachment and in storage, never only in memory. Its world is saved in
// batches (SAVE_MS after a change, and when the last person leaves), with the space's version, and kept for good.
import { SPACES } from "./spaces.js";
import { checkPerson, Refused, SpaceDown } from "./supabase.js";

export const PATH = /^\/space\/([a-z0-9-]{1,24})\/([a-z0-9-]{1,24})$/;
const HELLO_MS = 10_000;      // time to send hello before being cut off
const IDLE_MS = 10 * 60_000;  // no input for this long: closed, freeing the place
const GONE_MS = 90_000;       // no ping either (phones ping every 20 s): the connection is dead
const SAVE_MS = 5_000;        // a changed world is saved this long after the first change
const MAX_MESSAGE = 1024;     // characters, for a person's messages
const MAX_HELLO = 8192;       // the hello carries a sign-in token, about 1 KB
const MAX_RATE = 20;          // messages a second per connection
const MAX_WORLD = 100_000;    // characters: a saved world is kept small (and its area's first message with it)
const MAX_PEOPLE = 30;        // per area, unless the space says fewer

function send(ws, msg) {
  try { ws.send(JSON.stringify(msg)); return true; } catch { return false; }
}

export class Area {
  // ctx: the Durable Object's state (acceptWebSocket, getWebSockets, getWebSocketAutoResponseTimestamp, storage).
  constructor(ctx, env, { check = checkPerson, now = Date.now } = {}) {
    this.ctx = ctx;
    this.env = env;
    this.check = check;
    this.now = now;
    this.world = null;     // the space's world, loaded on first use after waking
    this.mod = null;
    this.saveTimer = null;
    this.rates = new WeakMap(); // ws → { window, count } (forgotten on hibernation: harmless)
    this.pending = new WeakSet(); // connections whose hello is being checked
  }

  // A new connection (the WebSocket's server end); its hello must follow.
  accept(ws, space, area) {
    this.ctx.acceptWebSocket(ws);
    ws.serializeAttachment({ space, area, uid: null, at: this.now() });
    setTimeout(() => { if (!this.info(ws)?.uid) this.close(ws, 4001, "No hello"); }, HELLO_MS);
  }

  info(ws) { try { return ws.deserializeAttachment(); } catch { return null; } }
  people(except) {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.info(ws);
      if (ws !== except && a?.uid) out.push({ ws, a });
    }
    return out;
  }
  broadcast(msg, except) { for (const { ws } of this.people(except)) send(ws, msg); }

  close(ws, code, reason) {
    try { ws.close(code, reason); } catch {}
    return this.gone(ws).catch((err) => console.error("space:", err));
  }

  async message(ws, data) {
    const a = this.info(ws);
    if (!a) return;
    const now = this.now();
    if (typeof data !== "string" || data.length > (a.uid ? MAX_MESSAGE : MAX_HELLO)) return this.close(ws, 4009, "Message too big");
    const rate = this.rates.get(ws) || { window: now, count: 0 };
    if (now - rate.window >= 1000) { rate.window = now; rate.count = 0; }
    this.rates.set(ws, rate);
    if (++rate.count > MAX_RATE) return this.close(ws, 4008, "Too many messages");
    let msg;
    try { msg = JSON.parse(data); } catch { return this.close(ws, 4000, "Not JSON"); }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    if (!a.uid) return this.hello(ws, a, msg);
    this.sweep(now, ws);
    a.at = now;
    ws.serializeAttachment(a);
    await this.load(a);
    const event = this.mod.input(this.world, a.uid, msg, { now });
    if (event) this.changed(event, a.uid);
  }

  // Checks who's connecting; they then take their place (replacing an older connection of theirs).
  async hello(ws, a, msg) {
    if (msg.t !== "hello" || this.pending.has(ws)) return this.close(ws, 4001, "Say hello first");
    const mod = SPACES[a.space];
    if (!mod || !mod.areas.includes(a.area)) return this.close(ws, 4004, "No such space");
    this.pending.add(ws);
    let person;
    try { person = await this.check(msg.token, mod.access || "accounts", this.env); } catch (err) {
      this.pending.delete(ws);
      if (err instanceof Refused) return this.close(ws, 4003, err.message);
      return this.close(ws, 4010, err instanceof SpaceDown ? err.message : "Couldn't check your sign-in. Try again later.");
    }
    this.pending.delete(ws);
    if (!this.ctx.getWebSockets().includes(ws)) return; // it went away while we were checking
    const now = this.now();
    this.sweep(now, ws);
    const others = this.people(ws);
    const mine = others.filter((p) => p.a.uid === person.uid);
    if (others.length - mine.length >= Math.min(mod.maxPeople || MAX_PEOPLE, MAX_PEOPLE)) return this.close(ws, 4006, "This space is full. Try again later.");
    // Their older connection goes quietly: they're still here (no leave).
    for (const p of mine) { try { p.ws.serializeAttachment({ ...p.a, uid: null }); p.ws.close(4002, "Connected again elsewhere"); } catch {} }
    Object.assign(a, { uid: person.uid, name: person.name, avatar: person.avatar, at: now });
    ws.serializeAttachment(a);
    await this.load(a);
    const event = mine.length ? null : this.mod.join?.(this.world, { id: person.uid, name: person.name, avatar: person.avatar }, { now });
    send(ws, { t: "hi", me: person.uid, people: this.people().map((p) => face(p.a)), view: this.mod.view(this.world, person.uid) });
    if (!mine.length) this.broadcast({ t: "join", person: face(a) }, ws);
    if (event) this.changed(event, person.uid);
  }

  // Closes connections that have gone quiet (checked whenever anyone sends something: a sleeping area costs nothing).
  sweep(now, except) {
    for (const { ws, a } of this.people(except)) {
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp?.(ws)?.getTime() || 0;
      if (now - a.at > IDLE_MS) this.close(ws, 4005, "Idle");
      else if (now - Math.max(a.at, pinged) > GONE_MS) this.close(ws, 4005, "Gone");
    }
  }

  // The world: in memory while awake, else from storage (upgraded to the space's version), else a new one.
  async load(a) {
    this.mod ||= SPACES[a.space];
    if (this.world) return;
    const saved = await this.ctx.storage.get("world");
    if (this.world) return; // loaded meanwhile
    const now = this.now();
    if (saved && saved.v !== this.mod.version) {
      if (!(saved.v < this.mod.version) || !this.mod.upgrade) throw new Error(`can't upgrade a saved world from version ${saved.v}`);
    }
    this.world = !saved ? this.mod.create(a.area)
      : saved.v === this.mod.version ? saved.world
      : this.mod.upgrade(saved.world, saved.v, a.area);
    // Catch up on what happened while nobody was here.
    this.mod.wake?.(this.world, saved?.at ? now - saved.at : 0, { now });
  }

  changed(event, by) {
    this.broadcast({ t: "e", by, e: event });
    if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save().catch((err) => console.error("space:", err)); }, SAVE_MS);
  }

  async save() {
    if (!this.world) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const world = JSON.parse(JSON.stringify(this.world));
    if (JSON.stringify(world).length > MAX_WORLD) { console.error("space world too big to save"); return; }
    await this.ctx.storage.put("world", { v: this.mod.version, at: this.now(), world });
  }

  // A connection closed: if it was the person's last one, they leave; if it was the last person, save now.
  async gone(ws) {
    const a = this.info(ws);
    if (!a?.uid) return;
    try { ws.serializeAttachment({ ...a, uid: null }); } catch {} // counted out from now, even if still listed
    const left = this.people(ws);
    if (left.some((p) => p.a.uid === a.uid)) return;
    await this.load(a);
    const event = this.mod.leave?.(this.world, a.uid, { now: this.now() });
    this.broadcast({ t: "leave", id: a.uid }, ws);
    if (event) this.changed(event, a.uid);
    if (!left.length) await this.save();
  }
}

const face = (a) => ({ id: a.uid, name: a.name, avatar: a.avatar });
