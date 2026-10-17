// Real-time online games on reclaude's game server (worker/): the server runs the game, the phones only play.
// Rooms, the lobby, names and leaderboards stay on Firebase (shared/rooms.js); once a room is playing, connect:
//
//   import * as server from "../shared/server.js";
//   const game = server.connect(seat, room, { onState: (s) => …, onStatus: (status, detail) => … });
//   game.send({ t: "move", … });   // any small JSON object (≤ 1 KB, at most 30 a second); the game's server module
//                                  // decides what it means
//   game.close();                  // when leaving the room
//
// onState gets what the server sends this player about 10 times a second (the game module's view, plus `at`, the
// server's clock), with `age`: roughly how many ms ago the server sent it (half the measured round trip), so a game
// can move things on by that much. onStatus gets "connecting", "connected" or "refused" (with the server's reason;
// it doesn't retry then). The connection pings every 5 seconds, reconnects by itself (and the server carries on
// from where it was), and closes after 20 seconds in the background so a phone left on another app costs nothing;
// it reconnects when the page is back. game.rtt() is the measured round trip in ms.
// Works with the Firebase backends only (the server checks the player's Firebase sign-in): real Firebase uses the
// live server, ?backend=emulator a local one (cd worker && npm run dev).

const LIVE = "wss://play.reclaude.junsaku.dev";
const LOCAL = "ws://127.0.0.1:8787";
const PING_MS = 5000;
const HIDDEN_MS = 20_000;
const REFUSED = new Set([4003, 4004]); // not seated / no such game: retrying won't help

export function serverUrl() {
  return new URLSearchParams(location.search).get("backend") === "emulator" ? LOCAL : LIVE;
}

export function connect({ backend, code }, room, { onState = () => {}, onStatus = () => {} } = {}) {
  if (!backend.credentials) throw new Error("The game server needs Firebase (not ?backend=fake or one phone).");
  const url = `${serverUrl()}/${room.game}/${code}/${room.createdAt}`;
  let ws = null, closed = false, retry = 500, retryTimer = 0, pingTimer = 0, hiddenTimer = 0;
  let rtt = 150, pingId = 0;
  const pings = new Map();

  function open() {
    if (closed || ws || document.hidden) return;
    onStatus("connecting");
    const sock = ws = new WebSocket(url);
    sock.onopen = async () => {
      try {
        const creds = await backend.credentials();
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: "hello", ...creds }));
      } catch (err) { console.error(err); sock.close(); }
    };
    sock.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === "hi") { retry = 500; onStatus("connected"); ping(); }
      else if (msg.t === "pong") { const at = pings.get(msg.id); if (at) { pings.delete(msg.id); rtt += (performance.now() - at - rtt) * 0.3; } }
      else if (msg.t === "s") onState({ ...msg, age: rtt / 2 });
    };
    sock.onclose = (e) => {
      if (ws === sock) ws = null;
      clearInterval(pingTimer);
      if (closed) return;
      if (REFUSED.has(e.code)) { closed = true; onStatus("refused", e.reason); return; }
      if (document.hidden) return; // reconnects when the page is back
      onStatus("connecting");
      retryTimer = setTimeout(open, retry);
      retry = Math.min(retry * 2, 5000);
    };
    clearInterval(pingTimer);
    pingTimer = setInterval(ping, PING_MS);
  }
  function ping() {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const id = ++pingId;
    pings.set(id, performance.now());
    if (pings.size > 10) pings.delete(pings.keys().next().value);
    ws.send(JSON.stringify({ t: "ping", id }));
  }
  function onVisibility() {
    clearTimeout(hiddenTimer);
    if (document.hidden) hiddenTimer = setTimeout(() => { if (ws) { const s = ws; ws = null; s.close(1000, "In the background"); } }, HIDDEN_MS);
    else { clearTimeout(retryTimer); open(); }
  }
  document.addEventListener("visibilitychange", onVisibility);
  open();

  return {
    send(msg) {
      if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return true; }
      return false;
    },
    rtt: () => rtt,
    isConnected: () => ws?.readyState === WebSocket.OPEN,
    close() {
      closed = true;
      clearTimeout(retryTimer); clearTimeout(hiddenTimer); clearInterval(pingTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      if (ws) { const s = ws; ws = null; s.close(1000, "Left"); }
    },
  };
}
