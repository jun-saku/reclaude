// The game kit: a game is its rules (game.js) and its drawing; the kit does everything around them. The home screen
// (name, Solo / Same phone / online rooms), the lobby with code and share link, the player bar, Leave, game over,
// Play again and the Top 10, in light and dark mode (shared/kit.css), and running the game in one of three engines:
//   local     solo or passing one phone around: game.js runs on the phone
//   turns     online turn-based (kind: "turns"): Firebase rooms (shared/rooms.js); the player on turn runs the move
//             and the database rules let only them write it
//   realtime  online, everyone at once (kind: "realtime"): the game server (worker/) runs the same game.js and
//             sends each player their view about 10 times a second (shared/server.js)
//
//   import { start } from "../shared/kit.js";
//   import game from "./game.js";
//   start(game, { title: "…", setup(stage, kit) { … }, render(info) { … }, frame(info) { … } });
//
// game.js (no drawing, no network; the server bundles it too, so no DOM in it):
//   id: the room/leaderboard name; kind: "turns" | "realtime"; players: [min, max]; modes: ["solo", "local", "online"]
//   setup({ players }) → state         a new game for this many players
//   join?(state, seat), leave?(state, seat)          realtime: a player arrives / goes (and comes back)
//   turn(state) → seat                  turns: whose turn it is
//   input(state, seat, move) → false?   apply a move (return false to refuse it); realtime: any message from a player
//   tick?(state, dt)                    realtime: advance by dt seconds
//   view?(state, seat) → what that seat sees (default: the state)
//   feed?(state) → { id, items }        realtime: a growing list (a drawing's strokes): items are only ever added, a
//                                       new id starts a new list. Sent a piece at a time (shared/feed.js), as info.feed
//   result(state) → null | { winner?: seat | "draw", score?: number, … }   the game is over
//   save?/load?, dev?(state, msg), timeUp?(state)   realtime extras (see worker/src/kit.js)
//
// ui (the page):
//   title, logo (SVG markup), howTo (HTML), soloText, onlineText
//   leaderboard?: { order: "high" | "low", format(n) }   save result.score to the Top 10
//   setup(stage, kit)    build the board/canvas and controls inside `stage` (called each time a game screen opens)
//   render(info)         the view changed: draw it (turns: after every move; realtime: every update)
//   frame?(info)         every animation frame while playing (realtime games drive and draw here)
//   status?(info) → text  the line above the board (default: whose turn it is)
//   resultText?(result, info) → { title, text }
// info: { mode: "solo" | "local" | "online", kind, me (this player's seat), seats, view, over (result or null),
//   turn, myTurn, act(move), name(seat), snaps (realtime: recent { at, recv, v }), clockOff, status, now, dt,
//   feed (realtime: { id, items } or null; the same items array grows, a new id is a new list) }.
// act(move) plays a move (turns: only on your turn) or sends a message to the game (realtime).
import * as rooms from "../shared/rooms.js";
import { topTen } from "../shared/leaderboard.js";
import { feedJoin } from "../shared/feed.js";

export { rooms };

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const range = (n) => Array.from({ length: n }, (_, i) => i);

export function start(game, ui = {}) {
  const modes = game.modes || ["online"];
  const [minP, maxP] = game.players || [2, 2];
  const online = modes.includes("online");
  const realtime = game.kind === "realtime";
  const main = document.querySelector("main") || document.body.appendChild(document.createElement("main"));
  const localPlayers = modes.includes("local") ? range(maxP - Math.max(2, minP) + 1).map((i) => i + Math.max(2, minP)) : [];
  main.insertAdjacentHTML("beforeend", `
    <div class="kit-title"><h1>${ui.logo || ""}${esc(ui.title || game.id)}</h1>${ui.leaderboard ? '<button class="trophy" id="trophy" aria-label="Top 10 leaderboard" aria-haspopup="dialog">🏆</button>' : ""}</div>
    <section id="home">
      ${online || ui.leaderboard ? `<div class="card"><label class="name-row"><span>Your name</span>
        <input id="my-name" maxlength="12" autocomplete="nickname" spellcheck="false" placeholder="So friends know it's you"></label></div>` : ""}
      ${online ? `<div class="card"><h2>Play friends online</h2>
        <p class="muted">${ui.onlineText || `Create a room for ${Math.max(2, minP) === maxP ? maxP : `${Math.max(2, minP)}–${maxP}`} players and send the code or link. The host starts once everyone's in.`}</p>
        <button id="create">Create room</button></div>
      <div class="card"><h2>Join a room</h2>
        <form class="join" id="join-form" autocomplete="off">
          <input id="join-code" maxlength="4" autocapitalize="characters" spellcheck="false" placeholder="CODE" aria-label="Room code">
          <button id="join" type="submit">Join</button>
        </form>
        <p class="error" id="home-error" role="alert"></p></div>` : ""}
      ${localPlayers.length ? `<div class="card"><h2>Same phone</h2><p class="muted">Pass the phone around. Works offline.</p>
        ${localPlayers.length > 1 ? `<div class="name-row"><span>Players</span><div class="seg" id="local-count">${localPlayers.map((n, i) => `<button type="button" data-n="${n}" aria-pressed="${!i}">${n}</button>`).join("")}</div></div>` : ""}
        <button class="secondary" id="${modes.includes("solo") ? "local-many" : "local"}" data-players="${localPlayers[0]}">Play here</button></div>` : ""}
      ${modes.includes("solo") ? `<div class="card"><h2>Solo</h2><p class="muted">${ui.soloText || "Play on your own. Works offline."}</p>
        <button class="secondary" id="local" data-players="1">Play solo</button></div>` : ""}
      ${ui.howTo ? `<details class="card rules"><summary>How to play</summary>${ui.howTo}</details>` : ""}
    </section>
    <section id="game" hidden>
      <div class="bar"><div class="players" id="players"></div><div class="code" id="room-label"></div></div>
      <div class="card" id="waiting" hidden>
        <p class="muted" style="text-align: center">Send this code to your friends</p>
        <p class="bigcode" id="waiting-code"></p>
        <div class="row"><button id="share">Share link</button><button class="secondary" id="copy">Copy code</button></div>
        <div class="seated" id="seated"></div>
        <button id="start-btn" hidden>Start game</button>
        <p class="muted" id="waiting-note" style="text-align: center; font-size: 0.9rem"></p>
      </div>
      <p class="status" id="status" aria-live="polite"></p>
      <div id="stage"></div>
      <p class="hint" id="hint"></p>
      <div class="card over" id="over" hidden>
        <h2 id="over-title"></h2>
        <p class="muted" id="over-text"></p>
        <form class="save" id="save-form" autocomplete="off" hidden>
          <input id="save-name" maxlength="12" placeholder="Your name" aria-label="Name for the leaderboard" enterkeyhint="done">
          <button id="save-btn" type="submit">Save</button>
        </form>
        <p class="hint" id="save-msg"></p>
        <button id="rematch">Play again</button>
      </div>
      <div class="row"><button class="secondary" id="leave">Leave</button></div>
    </section>`);
  const $ = (id) => document.getElementById(id);
  const stage = $("stage");

  // ---------- state ----------
  let mode = null;        // "solo" | "local" | "online" | null (home)
  let engine = null;      // the running engine
  let seat = null;        // online: { backend, code, seat }
  let room = null;        // online: the Firebase room
  let leaveRoom = null;
  let lastView = null, lastKey = "";
  const kit = {
    get mode() { return mode; }, get room() { return room; }, get seat() { return seat; },
    get info() { return engine ? info() : null; },
    act: (m) => engine?.act(m),
    rooms,
  };

  // ---------- engines ----------
  // Each engine: { me, seats, view(), over(), turn(), act(move), again(), frame(now, dt), snaps, status, leave() }.
  function newState(players) {
    const s = game.setup({ players });
    if (realtime) for (const p of range(players)) game.join?.(s, p);
    return s;
  }
  const viewOf = (s, me) => (game.view ? game.view(s, me) : s);

  function localEngine(players) {
    let s = newState(players), round = 0;
    const e = {
      seats: range(players), snaps: [], status: "connected",
      get me() { return realtime || players === 1 ? 0 : game.turn(s); },
      view: () => viewOf(s, e.me), over: () => game.result(s), turn: () => (realtime ? null : game.turn(s)),
      act(move) {
        if (game.result(s)) return false;
        const ok = game.input(s, e.me, move) !== false;
        if (ok && !realtime) changed();
        return ok;
      },
      again() { s = newState(players); round++; e.snaps = []; changed(); },
      frame(now, dt) {
        if (!realtime) return;
        if (!document.hidden && !game.result(s)) game.tick?.(s, dt);
        e.snaps.push({ at: now, recv: now, round, again: [], here: e.seats, over: game.result(s), v: viewOf(s, 0) });
        if (e.snaps.length > 3) e.snaps.shift();
        changed();
      },
      dev: (m) => game.dev?.(s, m, 0),
      get state() { return s; },
      get feed() { const f = game.feed?.(s); return f ? { id: `${round}:${f.id}`, items: f.items } : null; },
      leave() {},
    };
    return e;
  }

  // Online, turn-based: the game is the room's state (JSON in state.g), and a move is a transaction by the player on
  // turn: the database rules refuse anyone else's.
  function turnsEngine() {
    const parse = (r) => { try { return JSON.parse(r.state?.g || "null"); } catch { return null; } };
    const e = {
      snaps: [], status: "connected",
      get me() { return seat.seat; },
      get seats() { return rooms.seatList(room).flatMap((u, i) => (u ? [i] : [])); },
      view: () => { const s = parse(room); return s && viewOf(s, seat.seat); },
      // Over by the game's own rules, or because someone left (a forfeit: the room says who left and who wins).
      over: () => {
        if (room?.status === "done" && typeof room.left === "number") return { winner: room.winner, left: room.left };
        const s = parse(room); return s && game.result(s);
      },
      turn: () => room?.turn,
      async act(move) {
        const round = room.round, uid = seat.backend.uid, me = seat.seat;
        const r = await seat.backend.transact(seat.code, (cur) => {
          if (!cur || cur.status !== "playing" || cur.round !== round || cur.turn !== me || rooms.seatOf(cur, uid) !== me) return undefined;
          const s = parse(cur);
          if (!s || game.turn(s) !== me || game.result(s) || game.input(s, me, move) === false) return undefined;
          const res = game.result(s);
          cur.state = { g: JSON.stringify(s) };
          if (res) { cur.status = "done"; cur.winner = typeof res.winner === "number" ? res.winner : "draw"; }
          else cur.turn = game.turn(s);
          return cur;
        }).catch((err) => { console.error(err); return { committed: false }; });
        return r.committed;
      },
      async again() {
        await rooms.playAgain(seat, (cur, round) => {
          const s = newState(rooms.playerCount(cur));
          return { ...cur, round, status: "playing", turn: game.turn(s), state: { g: JSON.stringify(s) }, winner: null, left: null };
        });
      },
      frame() {},
      leave: () => {},
    };
    return e;
  }

  // Online, real-time: the game server runs the game; this page sends moves and gets the game back.
  function realtimeEngine() {
    let conn = null, why = "", connecting = false;
    const e = {
      snaps: [], status: "connecting", clockOff: null, feed: null,
      get me() { return seat.seat; },
      get seats() { return e.latest()?.here || []; },
      latest: () => e.snaps[e.snaps.length - 1] || null,
      view: () => e.latest()?.v ?? null, over: () => e.latest()?.over ?? null, turn: () => null,
      act(move) { return !!conn?.send({ t: "in", m: move }); },
      again() { conn?.send({ t: "again" }); },
      dev(m) { conn?.send({ t: "dev", m }); },
      frame() {},
      get why() { return why; },
      async connect() {
        if (conn || connecting) return;
        connecting = true;
        const server = await import("../shared/server.js").finally(() => { connecting = false; });
        if (engine !== e || conn) return;
        try {
          conn = server.connect(seat, room, {
            onState(msg) {
              const recv = Date.now(), off = recv - msg.at;
              e.clockOff = e.clockOff === null ? off : Math.min(off, e.clockOff + 2);
              const { f, ...rest } = msg;
              e.feed = feedJoin(e.feed, f);
              e.snaps.push({ ...rest, recv });
              if (e.snaps.length > 12) e.snaps.shift();
              changed();
            },
            onStatus(st, reason) {
              e.status = st; if (reason) why = reason;
              if (st === "refused") showHome(`Couldn't join the game: ${reason || "refused"}.`);
              renderChrome();
            },
          });
        } catch (err) { showHome(err.message); }
      },
      disconnect() { conn?.close(); conn = null; e.status = "offline"; },
      reconnect() { if (!conn) e.connect(); },
      leave() { conn?.close(); conn = null; },
    };
    return e;
  }

  // ---------- what the page gets ----------
  function info(now = Date.now(), dt = 0) {
    const e = engine;
    const over = e.over();
    const turn = e.turn();
    return {
      mode, kind: game.kind, me: e.me, seats: e.seats, view: e.view(), over, turn,
      myTurn: !over && turn === e.me, act: (m) => e.act(m), name, snaps: e.snaps, clockOff: e.clockOff ?? 0,
      status: e.status, now, dt, room, feed: e.feed ?? null,
    };
  }
  function name(s) {
    if (mode !== "online") return ui.seatName?.(s) || (mode === "solo" ? "You" : `Player ${s + 1}`);
    return s === seat.seat ? "You" : esc(rooms.nameOf(room, s));
  }

  // The view changed: tell the page (once per change), and redraw the kit's own parts.
  function changed() {
    if (!engine) return;
    const view = engine.view();
    const key = realtime ? engine.snaps[engine.snaps.length - 1]?.at : JSON.stringify(view) + (room?.status || "");
    if (key === lastKey && view === lastView) return;
    lastKey = key; lastView = view;
    if (view != null) ui.render?.(info());
    renderChrome();
  }

  // ---------- the kit's own screens ----------
  let chromeKey = "";
  function renderChrome() {
    if (!engine) return;
    const i = info();
    const waiting = mode === "online" && room?.status === "waiting";
    $("waiting").hidden = !waiting;
    stage.hidden = waiting;
    $("room-label").innerHTML = mode === "online" ? `Room <b>${seat.code}</b>` : mode === "solo" ? "Solo" : "Same phone";
    // Players: who's here, whose turn it is
    const seats = mode === "online" ? rooms.seatList(room).flatMap((u, s) => (u ? [s] : [])) : i.seats;
    const here = (s) => (mode !== "online" ? true : realtime ? i.seats.includes(s) : rooms.isOnline(room, s));
    const players = mode === "solo" ? "" : seats.map((s) => `<span class="chip${i.turn === s && !i.over ? " turn" : ""}${here(s) ? "" : " out"}" style="--pc: var(--p${s % 4})"><span class="disc"></span>${name(s)}${mode === "online" ? `<span class="dot${here(s) ? " on" : ""}"></span>` : ""}</span>`).join("");
    if ($("players").innerHTML !== players) $("players").innerHTML = players;
    if (waiting) { chromeKey = ""; return renderLobby(); }
    // The line above the board
    let status = ui.status?.(i);
    if (status === undefined) {
      if (mode === "online" && realtime && !i.view) status = "Connecting to the game server…";
      else if (i.over) status = "";
      else if (game.kind === "turns") status = i.myTurn ? (mode === "online" ? "Your turn" : `${name(i.turn)}'s turn`) : `${name(i.turn)}'s turn${mode === "online" && !here(i.turn) ? " (away)" : "…"}`;
      else status = "";
    }
    const hint = mode === "online" && realtime && i.status !== "connected" ? (i.view ? "Reconnecting…" : engine.why ? `(${engine.why})` : "") : "";
    const key = `${status}|${hint}|${JSON.stringify(i.over)}|${room?.again ? JSON.stringify(room.again) : ""}|${engine.latest?.()?.again || ""}`;
    if (key === chromeKey) return;
    chromeKey = key;
    $("status").textContent = status;
    $("hint").textContent = hint;
    renderOver(i);
  }

  function renderLobby() {
    const seats = rooms.seatList(room), count = rooms.playerCount(room), host = seat.seat === 0;
    $("waiting-code").textContent = seat.code;
    $("seated").innerHTML = seats.map((uid, s) => uid ? `<div><span class="chip" style="--pc: var(--p${s % 4})"><span class="disc"></span>${name(s)}${s === seat.seat && rooms.nameOf(room, s) !== `P${s + 1}` ? ` (${esc(rooms.nameOf(room, s))})` : ""}${s === 0 ? " (host)" : ""}</span></div>` : "").join("");
    const need = Math.max(2, minP);
    $("start-btn").hidden = !host;
    $("start-btn").disabled = count < need;
    $("start-btn").textContent = count < need ? "Waiting for friends…" : `Start with ${count} players`;
    $("waiting-note").textContent = `${count} of ${room.seats} here. ${host ? "Start when everyone's in." : "Waiting for the host to start…"}`;
    $("over").hidden = true;
  }

  let saved = false, savedFor = null;
  function renderOver(i) {
    const over = i.over;
    $("over").hidden = !over;
    if (!over) { savedFor = null; return; }
    const id = mode === "online" ? `${room.round}` : engine;
    if (savedFor !== id) { savedFor = id; saved = false; $("save-msg").textContent = ""; }
    const text = ui.resultText?.(over, i) || {
      title: over.winner === "draw" || over.winner == null ? (over.winner === "draw" ? "It's a draw!" : "Game over")
        : over.winner === i.me && mode !== "local" ? "You win! 🎉" : `${name(over.winner)} wins${mode === "local" ? "! 🎉" : ""}`,
      text: typeof over.left === "number" ? (over.left === i.me ? "You left this game." : `${name(over.left)} left the game.`)
        : typeof over.score === "number" ? `Score: ${ui.leaderboard?.format ? ui.leaderboard.format(over.score) : over.score}` : "",
    };
    $("over-title").textContent = text.title;
    $("over-text").textContent = text.text || "";
    const canSave = ui.leaderboard && typeof over.score === "number" && over.score > 0;
    $("save-form").hidden = !canSave || saved;
    if (canSave) $("save-btn").textContent = `Save ${ui.leaderboard.format ? ui.leaderboard.format(over.score) : over.score}`;
    if (!$("save-name").value) $("save-name").value = rooms.cleanName(rooms.myName());
    // Play again: everyone still here has to agree online
    let ready = [], waitingOn = [];
    if (mode === "online") {
      ready = realtime ? engine.latest()?.again || [] : rooms.seatList(room).flatMap((u, s) => (u && rooms.wantsAgain(room, s) ? [s] : []));
      const others = realtime ? i.seats : rooms.seatList(room).flatMap((u, s) => (u && rooms.isOnline(room, s) ? [s] : []));
      waitingOn = others.filter((s) => s !== i.me && !ready.includes(s)).map(name);
    }
    const mine = ready.includes(i.me);
    $("rematch").disabled = mine;
    $("rematch").textContent = mine ? `Waiting for ${waitingOn.join(", ") || "others"}…` : ready.length ? `Play again (${ready.map(name).join(", ")} ready)` : "Play again";
  }

  // ---------- moving between screens ----------
  let raf = 0, last = 0;
  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (!engine) return;
    const dt = Math.min(0.05, (t - (last || t)) / 1000);
    last = t;
    const now = Date.now();
    engine.frame(now, dt);
    if (ui.frame && (mode !== "online" || room?.status !== "waiting")) ui.frame(info(now, dt));
  }
  function enter(e) {
    engine = e; lastKey = ""; lastView = null; chromeKey = "";
    $("home").hidden = true;
    $("game").hidden = false;
    setBusy(false);
    stage.replaceChildren();
    ui.setup?.(stage, kit);
    if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
    changed();
    renderChrome();
  }
  function startLocal(players) {
    mode = players === 1 ? "solo" : "local";
    seat = room = null;
    enter(localEngine(players));
  }
  function startOnline(s) {
    mode = "online"; seat = s; room = null;
    let started = false;
    leaveRoom = rooms.enter(s, (value) => {
      room = value;
      if (!started) { started = true; enter(realtime ? realtimeEngine() : turnsEngine()); }
      if (realtime && room.status !== "waiting") engine.connect();
      changed();
      renderChrome();
    }, showHome);
  }
  function showHome(error = "") {
    engine?.leave();
    if (leaveRoom) leaveRoom();
    leaveRoom = null; engine = null; mode = null; seat = room = null;
    cancelAnimationFrame(raf); raf = 0;
    stage.replaceChildren();
    $("game").hidden = true;
    $("home").hidden = false;
    if ($("home-error")) $("home-error").textContent = error;
    setBusy(false);
  }
  function setBusy(b) { for (const id of ["create", "join", "local", "local-many"]) if ($(id)) $(id).disabled = b; }

  async function createRoom() {
    setBusy(true);
    $("home-error").textContent = "";
    await rooms.setMyName($("my-name").value);
    try {
      startOnline(await rooms.createRoom(game.id, { seats: maxP, min: Math.max(2, minP), auto: false, makeRoom: () => ({ state: { g: "null" } }) }));
    } catch (err) {
      console.error(err);
      showHome(err instanceof rooms.RoomError ? err.message : "Couldn't create a room. Check your connection and try again.");
    }
  }
  async function joinRoom(code) {
    setBusy(true);
    $("home-error").textContent = "";
    await rooms.setMyName($("my-name").value);
    try {
      startOnline(await rooms.joinRoom(game.id, code));
    } catch (err) {
      console.error(err);
      showHome(err instanceof rooms.RoomError ? err.message : "Couldn't join. Check your connection and try again.");
    }
  }
  async function startMatch() {
    $("start-btn").disabled = true;
    try {
      await rooms.startGame(seat, (r) => {
        if (realtime) return r;
        const s = newState(rooms.playerCount(r));
        return { ...r, turn: game.turn(s), state: { g: JSON.stringify(s) } };
      });
    } catch (err) {
      console.error(err);
      $("waiting-note").textContent = err instanceof rooms.RoomError ? err.message : "Couldn't start. Try again.";
      $("start-btn").disabled = false;
    }
  }

  // ---------- leaderboard ----------
  let sheet = null;
  if (ui.leaderboard) {
    sheet = topTen({ game: game.id, rooms: async () => rooms, button: $("trophy"), order: ui.leaderboard.order || "high", format: ui.leaderboard.format });
    $("save-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const n = engine?.over()?.score;
      const nm = rooms.cleanName($("save-name").value);
      if (!rooms.NAME_RE.test(nm)) { $("save-msg").textContent = "Pick a name of up to 12 letters, numbers or spaces."; return; }
      if (typeof n !== "number" || !(ui.leaderboard.valid ? ui.leaderboard.valid(n) : n > 0)) { $("save-msg").textContent = "Nothing to save."; return; }
      $("save-btn").disabled = true;
      $("save-msg").textContent = "Saving…";
      try {
        await rooms.saveScore(game.id, nm, n, { order: ui.leaderboard.order || "high" });
        saved = true;
        sheet.stale();
        $("save-msg").textContent = `Saved as ${nm}. Tap 🏆 to see the Top 10.`;
        $("save-form").hidden = true;
      } catch (err) {
        console.error(err);
        $("save-msg").textContent = err instanceof rooms.RoomError ? err.message : "Couldn't save: no connection?";
      } finally { $("save-btn").disabled = false; }
    });
  }

  // ---------- wiring ----------
  if ($("my-name")) {
    $("my-name").value = rooms.myName();
    $("my-name").addEventListener("change", () => { $("my-name").value = rooms.cleanName($("my-name").value); });
  }
  for (const b of document.querySelectorAll("#local-count button")) {
    b.addEventListener("click", () => {
      for (const o of document.querySelectorAll("#local-count button")) o.setAttribute("aria-pressed", String(o === b));
      const btn = $("local-many") || $("local");
      btn.dataset.players = b.dataset.n;
    });
  }
  for (const id of ["local", "local-many"]) $(id)?.addEventListener("click", () => {
    if ($("my-name")) rooms.setMyName($("my-name").value);
    startLocal(Number($(id).dataset.players));
  });
  if (online) {
    $("create").addEventListener("click", createRoom);
    $("join-form").addEventListener("submit", (ev) => { ev.preventDefault(); joinRoom($("join-code").value); });
    $("join-code").addEventListener("input", () => {
      $("join-code").value = $("join-code").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      $("home-error").textContent = "";
    });
  }
  $("start-btn").addEventListener("click", startMatch);
  $("rematch").addEventListener("click", () => { engine?.again(); if (mode === "online") $("rematch").disabled = true; });
  $("leave").addEventListener("click", async () => {
    if (mode === "online" && room) {
      const playing = room.status === "playing";
      // Turn-based: leaving mid-game ends it for the others (the room's rules: a forfeit). Real-time: the game goes
      // on without you on the server; only a host leaving the lobby closes the room.
      if (!realtime && playing && rooms.seatList(room).some((u, i) => u && i !== seat.seat && rooms.isOnline(room, i))
        && !confirm(rooms.playerCount(room) === 2 ? "Leave the game? Your friend wins this round." : "Leave the game? It ends in a draw for everyone.")) return;
      if (!realtime || room.status === "waiting") { $("leave").disabled = true; await rooms.quit(seat); $("leave").disabled = false; }
    }
    showHome();
  });
  $("share").addEventListener("click", async () => {
    if ((await rooms.share(seat.code, ui.title || game.id)) === "copied") $("share").textContent = "Link copied";
  });
  $("copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(seat.code); $("copy").textContent = "Copied"; } catch { prompt("Room code:", seat.code); }
    setTimeout(() => ($("copy").textContent = "Copy code"), 1500);
  });
  // Opening a shared link (?room=CODE) joins straight away.
  const linked = online && rooms.roomFromUrl();
  if (linked) { $("join-code").value = linked.toUpperCase(); joinRoom(linked); }

  // Hooks for automated tests.
  window.__kit = {
    rooms, game,
    get mode() { return mode; }, get room() { return room; }, get seat() { return seat; },
    get info() { return engine ? info() : null; }, get status() { return engine?.status; },
    get latest() { return engine?.latest?.() || engine?.snaps?.[engine.snaps.length - 1] || null; },
    get state() { return engine?.state; },
    act: (m) => engine?.act(m), dev: (m) => engine?.dev?.(m),
    disconnect: () => engine?.disconnect?.(), reconnect: () => engine?.reconnect?.(),
  };
  return kit;
}
