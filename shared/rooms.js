// Shared two-player rooms for reclaude games: room codes, share links, presence, and three backends.
// Import from a project page with:  import * as rooms from "../shared/rooms.js";
//
// A room is one object at rooms/<CODE> in Firebase Realtime Database:
//   { game, x, o?, board, turn, status: "waiting"|"playing"|"done", round, createdAt,
//     winner?, line?, last?, online?: { x?: true, o?: true } }
// Access rules: firebase/database.rules.json. Any field a game adds must be allowed there too.
//
// Backends all expose:
//   uid, local?, watch(code, cb) → unsubscribe, transact(code, fn) → { committed, value },
//   presence(code, side) → stop, online(), offline()
// transact's fn returns the new room, null to delete it, or undefined to abort.

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCCRIEJKgWbghpEhua1HlBvSoAuJ7ffDhE",
  authDomain: "reclaude-67a01.firebaseapp.com",
  databaseURL: "https://reclaude-67a01-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "reclaude-67a01",
  storageBucket: "reclaude-67a01.firebasestorage.app",
  messagingSenderId: "720774301235",
  appId: "1:720774301235:web:d91c1208d791c73b684546",
};
const FIREBASE_VERSION = "10.14.1";
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
export const CODE_RE = /^[A-HJ-NP-Z2-9]{4}$/;
const IDLE_MS = 60_000; // disconnect after this long in the background

export class RoomError extends Error {}

// ---------- backends ----------

async function firebaseBackend() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
  const [appMod, authMod, db$] = await Promise.all([
    import(base + "firebase-app.js"),
    import(base + "firebase-auth.js"),
    import(base + "firebase-database.js"),
  ]);
  const app = appMod.initializeApp(FIREBASE_CONFIG);
  const auth = authMod.getAuth(app);
  const db = db$.getDatabase(app);
  const user = await new Promise((resolve, reject) => {
    const off = authMod.onAuthStateChanged(auth, (u) => { if (u) { off(); resolve(u); } });
    authMod.signInAnonymously(auth).catch(reject);
  });
  const roomRef = (code, path = "") => db$.ref(db, `rooms/${code}${path}`);
  let isOnline = true;
  return {
    uid: user.uid,
    watch(code, cb) {
      return db$.onValue(roomRef(code), (s) => cb(s.val()), (err) => cb(null, err));
    },
    async transact(code, fn) {
      const r = await db$.runTransaction(roomRef(code), (cur) => fn(cur), { applyLocally: false });
      return { committed: r.committed, value: r.snapshot.val() };
    },
    // Marks this player online while connected; Firebase clears it if the connection drops,
    // and it is set again on every reconnect.
    presence(code, side) {
      const r = roomRef(code, `/online/${side}`);
      const off = db$.onValue(db$.ref(db, ".info/connected"), (s) => {
        if (s.val() !== true) return;
        db$.onDisconnect(r).remove().then(() => db$.set(r, true)).catch(() => {});
      });
      return () => {
        off();
        db$.onDisconnect(r).cancel().catch(() => {});
        db$.remove(r).catch(() => {});
      };
    },
    online() { if (!isOnline) { isOnline = true; db$.goOnline(db); } },
    offline() { if (isOnline) { isOnline = false; db$.goOffline(db); } },
  };
}

// Stand-in used by automated tests (?backend=fake): tabs in one browser share rooms
// through localStorage and BroadcastChannel. offline() drops presence like a real disconnect.
function fakeBackend() {
  const KEY = "rooms-fake-db";
  const channel = new BroadcastChannel("rooms-fake");
  const read = () => JSON.parse(localStorage.getItem(KEY) || "{}");
  let uid = sessionStorage.getItem("rooms-fake-uid");
  if (!uid) { uid = "u" + Math.random().toString(36).slice(2, 10); sessionStorage.setItem("rooms-fake-uid", uid); }
  const listeners = new Map();
  const present = new Set(); // "CODE/side" entries this tab keeps online
  let isOnline = true;
  const notify = (code) => {
    const v = read()[code] ?? null;
    for (const cb of listeners.get(code) || []) cb(v === null ? null : structuredClone(v));
  };
  channel.onmessage = (e) => notify(e.data);
  const transact = async (code, fn) => {
    const db = read();
    const cur = db[code] ?? null;
    const next = fn(cur === null ? null : structuredClone(cur));
    if (next === undefined) return { committed: false, value: cur };
    if (next === null) delete db[code]; else db[code] = next;
    localStorage.setItem(KEY, JSON.stringify(db));
    notify(code);
    channel.postMessage(code);
    return { committed: true, value: next };
  };
  const flag = (code, side, on) => transact(code, (room) => {
    if (!room) return undefined;
    room.online = room.online || {};
    if (on) room.online[side] = true; else delete room.online[side];
    return room;
  });
  addEventListener("pagehide", () => { for (const k of present) flag(...k.split("/"), false); });
  return {
    uid,
    fake: true,
    get isOnline() { return isOnline; },
    watch(code, cb) {
      if (!listeners.has(code)) listeners.set(code, new Set());
      listeners.get(code).add(cb);
      setTimeout(() => cb(read()[code] ?? null), 0);
      return () => listeners.get(code).delete(cb);
    },
    transact,
    presence(code, side) {
      present.add(`${code}/${side}`);
      if (isOnline) flag(code, side, true);
      return () => { present.delete(`${code}/${side}`); flag(code, side, false); };
    },
    online() {
      if (isOnline) return;
      isOnline = true;
      for (const k of present) flag(...k.split("/"), true);
    },
    offline() {
      if (!isOnline) return;
      isOnline = false;
      for (const k of present) flag(...k.split("/"), false);
    },
  };
}

// Two players sharing one device; no network at all.
export function localBackend() {
  let room = null;
  let cb = null;
  return {
    uid: "local",
    local: true,
    watch(code, fn) { cb = fn; setTimeout(() => cb && cb(room), 0); return () => { cb = null; }; },
    async transact(code, fn) {
      const next = fn(room === null ? null : structuredClone(room));
      if (next === undefined) return { committed: false, value: room };
      room = next;
      if (cb) cb(room === null ? null : structuredClone(room));
      return { committed: true, value: room };
    },
    presence() { return () => {}; },
    online() {},
    offline() {},
  };
}

// ---------- connection ----------

let netPromise = null;
let idleTimer = null;
let inRoom = false;

// Connects on first use (creating or joining), so just opening a game costs no connection.
export function connect() {
  if (!netPromise) {
    const fake = new URLSearchParams(location.search).get("backend") === "fake";
    netPromise = (fake ? Promise.resolve(fakeBackend()) : firebaseBackend())
      .then((b) => { watchVisibility(b); return b; })
      .catch((err) => { netPromise = null; throw err; });
  }
  return netPromise.then((b) => { b.online(); return b; });
}

// Drop the connection after a minute in the background, and whenever the player isn't in a room.
function watchVisibility(b) {
  document.addEventListener("visibilitychange", () => {
    clearTimeout(idleTimer);
    if (document.hidden) idleTimer = setTimeout(() => b.offline(), IDLE_MS);
    else if (inRoom) b.online();
  });
}

// ---------- rooms ----------

function randomCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (n) => CODE_CHARS[n % 32]).join("");
}

// Creates a room with a fresh code. makeRoom(uid) returns the initial room (without game/x/createdAt).
export async function createRoom(game, makeRoom) {
  const b = await connect();
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode();
    const r = await b.transact(code, (cur) => {
      if (cur !== null) return undefined; // code taken, try another
      return { ...makeRoom(b.uid), game, x: b.uid, createdAt: Date.now() };
    });
    if (r.committed) return { backend: b, code, side: "x" };
  }
  throw new RoomError("Couldn't find a free room code. Try again.");
}

// Joins (or rejoins) a room. Returns { backend, code, side } or throws RoomError with a message for players.
export async function joinRoom(game, raw) {
  const code = String(raw || "").trim().toUpperCase();
  if (!CODE_RE.test(code)) throw new RoomError("Room codes are 4 letters or numbers.");
  const b = await connect();
  const current = await new Promise((resolve, reject) => {
    let off = null;
    off = b.watch(code, (v, err) => { setTimeout(() => off && off(), 0); err ? reject(err) : resolve(v); });
  });
  if (!current) throw new RoomError(`No room called ${code}. Check the code with your friend.`);
  if ((current.game || "tic-tac-toe") !== game) throw new RoomError(`${code} is a room for a different game.`);
  if (current.x === b.uid) return { backend: b, code, side: "x" };
  if (current.o === b.uid) return { backend: b, code, side: "o" };
  if (current.o) throw new RoomError("That room already has two players.");
  const r = await b.transact(code, (cur) => {
    // Firebase may first call this with an empty local cache. Returning null (not aborting) makes the
    // server reject it and retry with the real room; if the room really is gone, writing null is a no-op.
    if (cur === null) return null;
    if (cur.o || cur.x === b.uid) return undefined;
    cur.o = b.uid;
    cur.status = "playing";
    return cur;
  });
  if (r.committed && !r.value) throw new RoomError(`No room called ${code}. Check the code with your friend.`);
  if (!r.committed || r.value.o !== b.uid) throw new RoomError("That room already has two players.");
  return { backend: b, code, side: "o" };
}

// Watches a room and keeps this player's presence while they're in it. Returns leave().
export function enter({ backend, code, side }, onRoom, onGone) {
  inRoom = !backend.local;
  const stopPresence = backend.local ? () => {} : backend.presence(code, side);
  const unwatch = backend.watch(code, (value, err) => {
    if (err) return onGone("Lost access to the room. Check your connection and try again.");
    if (!value) return onGone(backend.local ? "" : "That room has closed.");
    onRoom(value);
  });
  if (!backend.local) setRoomInUrl(code);
  return function leave() {
    unwatch();
    stopPresence();
    inRoom = false;
    setRoomInUrl(null);
    // Give the presence removal a moment to send, then free the connection.
    if (!backend.local) setTimeout(() => { if (!inRoom) backend.offline(); }, 1500);
  };
}

// ---------- links ----------

function setRoomInUrl(code) {
  const url = new URL(location.href);
  if (code) url.searchParams.set("room", code); else url.searchParams.delete("room");
  history.replaceState(null, "", url);
}

export function roomFromUrl() {
  return new URLSearchParams(location.search).get("room");
}

export function shareUrl(code) {
  const url = new URL(location.href);
  const backend = url.searchParams.get("backend");
  url.search = "";
  url.searchParams.set("room", code);
  if (backend) url.searchParams.set("backend", backend);
  return url.toString();
}

export async function share(code, title) {
  const url = shareUrl(code);
  if (navigator.share) {
    try { await navigator.share({ title, text: `Join my game: ${code}`, url }); return "shared"; } catch { return "cancelled"; }
  }
  try { await navigator.clipboard.writeText(url); return "copied"; } catch { return "failed"; }
}

// Test hooks: simulate the idle disconnect without waiting a minute.
export const __test = {
  idleNow: async () => (await netPromise)?.offline(),
  wake: async () => (await netPromise)?.online(),
  isOnline: async () => (netPromise ? (await netPromise).isOnline : null),
};
