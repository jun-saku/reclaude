// Spaces on reclaude's game server (worker/, worker/SPACES.md): places that are always there, where people with an
// account come and go. Enter one with:
//
//   import * as space from "../shared/space.js";   (from an app: ../../shared/space.js)
//   const s = space.enter("plaza", "main", {
//     onWelcome: ({ me, people, view }) => …,  // connected (again): your id, who's here, the whole area
//     onJoin: (person) => …,                   // { id, name, avatar } arrived
//     onLeave: (id) => …,
//     onEvent: (event, by) => …,               // what the space's server sent after someone's message
//     onStatus: (status, detail) => …,         // "connecting" | "connected" | "closed" (detail: why, to show)
//   });
//   s.send({ t: "go", x: 3, y: 4 });            // any small JSON object (≤ 1 KB, at most 20 a second): send only
//                                               // when something changes, so the area can sleep in between
//   s.leave();
//
// It signs in with this device's Supabase sign-in (shared/core.js): spaces are for accounts. "closed" means it won't
// retry by itself: not an account, the space is full, or Supabase is asleep (detail says which); a new enter() tries
// again. Otherwise it reconnects by itself, pings every 20 seconds (answered without waking the area), and closes
// after 20 seconds in the background so a phone left on another app costs nothing, coming back with the page.
// On this machine (localhost) it uses the local server (cd worker && npm run dev) and local Supabase, as core.js does.
import { accessToken } from "../shared/core.js";

const LIVE = "wss://play.reclaude.junsaku.dev";
const LOCAL = "ws://127.0.0.1:8787";
const PING_MS = 20_000;
const HIDDEN_MS = 20_000;
const CLOSED = new Set([4003, 4004, 4006, 4010]); // refused, no such space, full, Supabase asleep: retrying won't help now

export function enter(name, area, { onWelcome = () => {}, onJoin = () => {}, onLeave = () => {}, onEvent = () => {}, onStatus = () => {} } = {}) {
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  const url = `${local ? LOCAL : LIVE}/space/${name}/${area}`;
  let ws = null, done = false, retry = 500, retryTimer = 0, pingTimer = 0, hiddenTimer = 0;

  async function open() {
    if (done || ws || document.hidden) return;
    onStatus("connecting");
    const token = await accessToken();
    if (done || ws) return;
    if (!token) { stop("Only accounts can enter. Make one on your Profile page."); return; }
    const sock = ws = new WebSocket(url);
    sock.onopen = () => sock.send(JSON.stringify({ t: "hello", token }));
    sock.onmessage = (e) => {
      if (e.data === "pong") return;
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === "hi") { retry = 500; onStatus("connected"); onWelcome(msg); }
      else if (msg.t === "join") onJoin(msg.person);
      else if (msg.t === "leave") onLeave(msg.id);
      else if (msg.t === "e") onEvent(msg.e, msg.by);
    };
    sock.onclose = (e) => {
      if (ws === sock) ws = null;
      if (done) return;
      if (CLOSED.has(e.code)) { stop(e.reason || "Couldn't enter."); return; }
      if (e.code === 4002) { stop("You're in this space in another tab."); return; }
      if (document.hidden) return; // reconnects when the page is back
      onStatus("connecting", e.reason ? `${e.code}: ${e.reason}` : `closed (${e.code})`);
      retryTimer = setTimeout(open, retry);
      retry = Math.min(retry * 2, 10_000);
    };
  }
  function stop(why) {
    done = true;
    cleanup();
    onStatus("closed", why);
  }
  function cleanup() {
    clearTimeout(retryTimer); clearTimeout(hiddenTimer); clearInterval(pingTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    if (ws) { const s = ws; ws = null; s.close(1000, "Left"); }
  }
  function onVisibility() {
    clearTimeout(hiddenTimer);
    if (document.hidden) hiddenTimer = setTimeout(() => { if (ws) { const s = ws; ws = null; s.close(1000, "In the background"); } }, HIDDEN_MS);
    else { clearTimeout(retryTimer); open(); }
  }
  document.addEventListener("visibilitychange", onVisibility);
  pingTimer = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send("ping"); }, PING_MS);
  open();

  return {
    send(msg) {
      if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return true; }
      return false;
    },
    isConnected: () => ws?.readyState === WebSocket.OPEN,
    leave() { done = true; cleanup(); },
  };
}
