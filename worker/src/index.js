// reclaude's game server: one Durable Object per room runs a real-time game, so no player's phone is in charge.
// Rooms, the lobby and the Top 10 stay on Firebase; once a room is playing, each player opens a WebSocket here:
//   wss://play.reclaude.junsaku.dev/<game>/<CODE>/<createdAt>
// and first sends { t: "hello", id: <Firebase ID token>, ac: <App Check token> }. The server checks the token,
// reads the room as that player to find their seat, then runs the game from the game's module (src/games.js):
// the players send their input, the server sends each of them the game about 10 times a second.
//
// There is no game loop running on its own: the game moves on whenever a message comes in (phones send at least
// one every 100 ms while connected, shared/server.js), by however long it's been. Each message is its own short
// piece of work, which keeps every one well inside Cloudflare's per-request CPU limit (10 ms on the free plan),
// where a loop running on a timer for the whole game would be cut off.
//
// Lifecycle (nothing keeps running, or costs anything, once nobody plays):
// - The game only moves while at least one seated player is connected (and sending).
// - When the last one goes, the game is saved to the room's storage and an alarm is set for 10 minutes. Anyone
//   reconnecting before then carries on from there; otherwise the alarm deletes everything the room stored.
// - A connection that sends nothing for 30 s is closed (phones send a ping every 5 s, and close their connection
//   after 20 s in the background). A game running for 2 hours is ended.
// - Each room's server is named by game, code and the room's creation time, so a later room reusing a code
//   never meets an old game.
import { DurableObject } from "cloudflare:workers";
import { GAMES } from "./games.js";
import { AuthError, readRoom, seatIn, verifyIdToken } from "./auth.js";

const TICK_MS = 1000 / 30;     // the game advances in steps of this (at most 15 of them per message)
const SEND_MS = 100;           // and is sent to the players 10 times a second
const IDLE_MS = 30_000;        // a silent connection is closed after this
const KEEP_MS = 10 * 60_000;   // an empty room's game is kept this long (the tests shorten it with the KEEP_MS variable)
const MAX_GAME_MS = 2 * 3600_000;
const HELLO_MS = 10_000;       // time to send hello before being cut off
const MAX_MESSAGE = 1024;      // characters, for game messages
const MAX_HELLO = 8192;        // the hello carries two sign-in tokens, about 2 KB live
const MAX_RATE = 40;           // messages a second per connection
const PATH = /^\/([a-z0-9-]{1,24})\/([A-HJ-NP-Z2-9]{4})\/(\d{1,15})$/;
// Pages allowed to connect: the site, its previews, and (EMULATOR only) local test servers.
const ORIGINS = [/^https:\/\/reclaude\.junsaku\.dev$/, /^https:\/\/([a-z0-9-]+\.)?reclaude\.pages\.dev$/];
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// Sends to a connection that may have just gone away.
function send(socket, msg) {
  try { socket.send(JSON.stringify(msg)); return true; } catch { return false; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = PATH.exec(url.pathname);
    if (!m || !GAMES[m[1]]) return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const origin = request.headers.get("Origin") || "";
    if (!ORIGINS.some((r) => r.test(origin)) && !(env.EMULATOR === "1" && LOCAL.test(origin))) return new Response("Forbidden", { status: 403 });
    const room = env.ROOMS.get(env.ROOMS.idFromName(`${m[1]}:${m[2]}:${m[3]}`));
    try { return await room.fetch(request); } catch (err) {
      // The player went away mid-connect, or the room's server restarted: their page simply tries again.
      return new Response(`Try again (${String(err?.message || err).slice(0, 80)})`, { status: 503 });
    }
  },
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.conns = new Map(); // WebSocket → { seat, uid, lastAt, window, count }
    this.meta = null;       // { game, code, created }
    this.mod = null;        // the game's module
    this.state = null;      // the game, while it's loaded
    this.startedAt = 0;
    this.lastTick = 0;
    this.lastSend = 0;
  }

  async fetch(request) {
    const [, game, code, created] = PATH.exec(new URL(request.url).pathname);
    this.meta = { game, code, created: Number(created) };
    this.mod = GAMES[game];
    const { 0: client, 1: socket } = new WebSocketPair();
    socket.accept();
    const conn = { seat: null, uid: null, lastAt: Date.now(), window: Date.now(), count: 0, busy: false };
    this.conns.set(socket, conn);
    socket.addEventListener("message", (e) => this.onMessage(socket, conn, e.data).catch((err) => this.drop(socket, 1011, String(err?.message || err).slice(0, 100))));
    socket.addEventListener("close", () => this.onClose(socket));
    socket.addEventListener("error", () => this.onClose(socket));
    setTimeout(() => { if (conn.seat === null) this.drop(socket, 4001, "No hello"); }, HELLO_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  drop(socket, code, reason) {
    try { socket.close(code, reason); } catch {}
    this.onClose(socket);
  }

  async onMessage(socket, conn, data) {
    const now = Date.now();
    if (typeof data !== "string" || data.length > (conn.seat === null ? MAX_HELLO : MAX_MESSAGE)) return this.drop(socket, 4009, "Message too big");
    if (now - conn.window >= 1000) { conn.window = now; conn.count = 0; }
    if (++conn.count > MAX_RATE) return this.drop(socket, 4008, "Too many messages");
    conn.lastAt = now;
    let msg;
    try { msg = JSON.parse(data); } catch { return this.drop(socket, 4000, "Not JSON"); }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "ping") send(socket, { t: "pong", id: Number(msg.id) || 0 });
    else if (conn.seat === null) return this.hello(socket, conn, msg);
    else if (this.state && msg.t !== "tick") this.mod.input(this.state, conn.seat, msg, { dev: this.env.EMULATOR === "1" });
    if (conn.seat !== null) this.advance(now);
  }

  // A new connection proves who it is; it then takes its seat (replacing any older connection for that seat).
  async hello(socket, conn, msg) {
    if (msg.t !== "hello" || conn.busy) return this.drop(socket, 4001, "Say hello first");
    conn.busy = true;
    let uid, room;
    try {
      uid = await verifyIdToken(msg.id, this.env);
      room = await readRoom(this.meta.code, msg.id, typeof msg.ac === "string" ? msg.ac : "", this.env);
    } catch (err) {
      return this.drop(socket, 4003, err instanceof AuthError ? err.message : "Couldn't check the room");
    }
    const seat = seatIn(room, uid);
    if (!room || room.game !== this.meta.game || room.createdAt !== this.meta.created) return this.drop(socket, 4004, "No such game");
    if (seat === null) return this.drop(socket, 4003, "Not seated in this room");
    if (!this.conns.has(socket)) return; // it went away while we were checking
    for (const [other, c] of this.conns) if (other !== socket && c.seat === seat) this.drop(other, 4002, "Connected again elsewhere");
    Object.assign(conn, { seat, uid });
    if (!this.state) await this.load(room);
    this.mod.join(this.state, seat, room);
    send(socket, { t: "hi", seat });
    this.advance(Date.now());
  }

  // The game: the one saved when the room last emptied (same room), or a new one.
  async load(room) {
    const saved = await this.ctx.storage.get("game");
    this.state = saved && saved.created === this.meta.created ? this.mod.load(saved.game, room) : this.mod.create(room);
    this.startedAt = saved?.startedAt || Date.now();
    this.lastTick = this.lastSend = 0;
    await this.ctx.storage.deleteAlarm();
  }

  // Moves the game on to now (in steps of TICK_MS, at most half a second at once), and sends it to everyone if
  // it's time.
  advance(now) {
    for (const [socket, c] of this.conns) if (now - c.lastAt > IDLE_MS) this.drop(socket, 4005, "Idle");
    if (!this.state) return;
    if (!this.lastTick) this.lastTick = now;
    if (now - this.startedAt > MAX_GAME_MS) this.mod.timeUp?.(this.state);
    let left = Math.min(500, now - this.lastTick);
    this.lastTick = now;
    while (left > 0) { const step = Math.min(TICK_MS, left); this.mod.tick(this.state, step / 1000); left -= step; }
    if (now - this.lastSend >= SEND_MS - 20) { // (a little early rather than a whole message late)
      this.lastSend = now;
      for (const [socket, c] of this.conns) {
        if (c.seat === null) continue;
        if (!send(socket, { t: "s", at: now, ...this.mod.view(this.state, c.seat, c) })) this.onClose(socket);
      }
    }
  }

  onClose(socket) {
    const conn = this.conns.get(socket);
    if (!conn) return;
    this.conns.delete(socket);
    if (conn.seat !== null && this.state && ![...this.conns.values()].some((c) => c.seat === conn.seat)) this.mod.leave(this.state, conn.seat);
    if ([...this.conns.values()].some((c) => c.seat !== null)) return;
    // Nobody's playing: keep the game for a while in case someone comes back, then forget it.
    if (this.state) {
      const game = this.mod.save(this.state);
      this.state = null;
      this.ctx.storage.put("game", { created: this.meta.created, startedAt: this.startedAt, game })
        .then(() => this.ctx.storage.setAlarm(Date.now() + (Number(this.env.KEEP_MS) || KEEP_MS)))
        .catch(() => {});
    }
  }

  async alarm() {
    if ([...this.conns.values()].some((c) => c.seat !== null)) return;
    await this.ctx.storage.deleteAll();
  }
}
