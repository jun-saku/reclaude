// Pickleball (see shared/pickleball.js for the data, ./rotation.js for who plays next). One page, by its address:
//   ./                 managers: open sessions, clubs and players (everyone else: what this is, and who can use it)
//   ./?club=<id>       a club: its players and managers
//   ./?new[=<club>]    start a session (from a club)
//   ./?s=<id>          run a session: its managers and helpers (courts, next match, the line and its overrides)
//   ./?s=<id>&h=<code> become a helper with the session's helper code (the QR its manager shows)
//   ./?w=<code>        the live view: anyone with the link, read only
import * as pb from "../../shared/pickleball.js";
import { CoreError } from "../../shared/core.js";
import * as rot from "./rotation.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const keep = params.get("backend") === "fake" ? "&backend=fake" : ""; // (the UI tests' stand-in stays on)
const here = (query = "") => `./?${query}${keep}`.replace("?&", "?").replace(/\?$/, "");
const view = $("view");
// Opened as the installed Pickleball app (its manifest starts at ./?app): its home has no ‹ out to reclaude's.
const installed = (() => {
  try { if (params.has("app")) sessionStorage.setItem("pickleball-app", "1"); return sessionStorage.getItem("pickleball-app") === "1"; }
  catch { return params.has("app"); }
})();

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "hidden" || k === "disabled" || k === "checked" || k === "selected") e[k] = !!v;
    else if (k === "value") e.value = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  e.append(...kids.flat().filter((x) => x != null && x !== false));
  return e;
}
const message = (err) => (err instanceof CoreError ? err.message : "Something went wrong. Try again.");
function showError(err) { $("error").textContent = err ? message(err) : ""; if (err) console.warn(err); }
// Runs an action from a button: disables it meanwhile, shows any error.
async function act(button, fn) {
  if (button) button.disabled = true;
  showError(null);
  try { await fn(); } catch (err) { showError(err); }
  if (button) button.disabled = false;
}
const ago = (iso) => {
  const min = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 60000));
  return min < 1 ? "under a minute" : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};
const card = (...kids) => el("section", { class: "card" }, ...kids);
const head = (title, ...right) => el("div", { class: "head" }, el("h2", {}, title), ...right);
const empty = (text) => el("p", { class: "empty" }, text);
function setBack(href, label) { $("back").href = href; $("back").setAttribute("aria-label", label); $("back").hidden = false; }

// The sheet: a dialog for a choice, built by fill(form, close). Closes on Cancel or a done action.
const sheet = $("sheet");
function openSheet(title, fill) {
  const form = el("form", { method: "dialog" });
  const close = () => sheet.close();
  form.append(el("h2", {}, title), ...fill(close).flat().filter(Boolean),
    el("button", { type: "button", class: "secondary", onclick: close }, "Cancel"));
  sheet.replaceChildren(form);
  sheet.showModal();
}

// ---------- start ----------
let me;
(async () => {
  try {
    me = await pb.me();
    if (installed) $("back").hidden = true;
    if (params.has("w")) await watchView(params.get("w"));
    else if (params.has("s") && params.has("h")) await joinAsHelper(params.get("s"), params.get("h"));
    else if (params.has("s")) await sessionView(params.get("s"));
    else if (!me.manager) notManager();
    else if (params.has("club")) await clubView(params.get("club"));
    else if (params.has("new")) await newSession(params.get("new"));
    else await homeView();
  } catch (err) {
    view.replaceChildren(card(empty("Can't load this right now.")));
    showError(err);
  }
})();

function notManager() {
  view.replaceChildren(card(
    el("h2", {}, "Court rotation"),
    el("p", {}, "Who's on court and who's next, for your pickleball group."),
    el("p", { class: "muted" }, me.account
      ? "Only pickleball managers start sessions. Ask an admin for the manager role."
      : "Only pickleball managers start sessions, with an account. Players just open the link they're given."),
    !me.account && el("a", { class: "button", href: "../profile/" }, "Sign in")));
}

// ---------- managers: home ----------
async function homeView() {
  const [sessions, clubs, players] = await Promise.all([pb.sessions(), pb.clubs(), pb.players()]);
  const clubName = (id) => clubs.find((c) => c.id === id)?.name || "Session";
  const mine = sessions.filter((s) => runs(s, clubs));

  const playerName = el("input", { placeholder: "Name", maxlength: 24, "aria-label": "New player's name" });
  const playerIcon = el("input", { class: "emoji", placeholder: "👤", maxlength: 8, "aria-label": "New player's icon (an emoji)" });
  const clubInput = el("input", { placeholder: "Club name", maxlength: 40, "aria-label": "New club's name" });

  view.replaceChildren(
    card(head("Sessions"),
      mine.length ? el("div", { class: "list" }, ...mine.map((s) => el("a", { class: "item", href: here(`s=${s.id}`) },
        el("span", { class: "who" }, clubName(s.club_id)), el("span", { class: "meta" }, `${s.courts} court${s.courts > 1 ? "s" : ""} · ${ago(s.started_at)}`))))
        : empty("No session running."),
      el("a", { class: "button", href: here("new") }, "Start a session")),
    card(head("Clubs"),
      clubs.length ? el("div", { class: "list" }, ...clubs.map((c) => el("a", { class: "item", href: here(`club=${c.id}`) },
        el("span", { class: "who" }, c.name), el("span", { class: "meta" }, `${c.players.length} player${c.players.length === 1 ? "" : "s"}`))))
        : empty("No clubs yet. A club is a list of players you play with."),
      el("div", { class: "form" }, clubInput, el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, async () => {
        const id = await pb.makeClub(clubInput.value);
        location.assign(here(`club=${id}`));
      }) }, "Add"))),
    card(head(`Players (${players.length})`),
      players.length ? el("div", { class: "list" }, ...players.map((p) => playerRow(p, () => homeView())))
        : empty("No players yet."),
      el("div", { class: "form" }, playerIcon, playerName, el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, async () => {
        await pb.makePlayer(playerName.value, playerIcon.value);
        await homeView();
      }) }, "Add"))));
}

const runs = (s, clubs) => s.started_by === me.id || !!clubs.find((c) => c.id === s.club_id)?.managers.includes(me.id);
const face = (p) => `${p?.icon || "👤"} ${p?.name || "?"}`;

// A player in a list, with Edit (and whatever else `extra` adds).
function playerRow(p, done, ...extra) {
  const edit = el("button", { type: "button", class: "icon-btn", "aria-label": `Edit ${p.name}`, onclick: () => openSheet(`Edit ${p.name}`, (close) => {
    const name = el("input", { value: p.name, maxlength: 24, "aria-label": "Name" });
    const icon = el("input", { class: "emoji", value: p.icon, maxlength: 8, "aria-label": "Icon (an emoji)" });
    return [el("div", { class: "form" }, icon, name),
      el("button", { type: "button", onclick: (e) => act(e.target, async () => { await pb.editPlayer(p.id, name.value, icon.value); close(); await done(); }) }, "Save")];
  }) }, "✏️");
  return el("div", { class: "item" }, el("span", { class: "who" }, face(p)), ...extra, edit);
}

// ---------- managers: a club ----------
async function clubView(id) {
  setBack(here(), "Pickleball");
  const [clubs, players, managers] = await Promise.all([pb.clubs(), pb.players(), pb.managers()]);
  const club = clubs.find((c) => c.id === id);
  if (!club) { view.replaceChildren(card(empty("There's no such club."))); return; }
  const mine = club.managers.includes(me.id);
  const reload = () => clubView(id);
  const members = players.filter((p) => club.players.includes(p.id));
  const others = players.filter((p) => !club.players.includes(p.id));
  const manager = (uid) => managers.find((m) => m.id === uid);
  const managerName = (m) => (m ? `${m.avatar || "👤"} ${m.display_name || m.username} (@${m.username})` : "Someone");

  const pickPlayer = el("select", { "aria-label": "Player to add" }, ...others.map((p) => el("option", { value: p.id }, face(p))));
  const newName = el("input", { placeholder: "Name", maxlength: 24, "aria-label": "New player's name" });
  const newIcon = el("input", { class: "emoji", placeholder: "👤", maxlength: 8, "aria-label": "New player's icon (an emoji)" });
  const pickManager = el("select", { "aria-label": "Manager to add" },
    ...managers.filter((m) => !club.managers.includes(m.id)).map((m) => el("option", { value: m.id }, managerName(m))));

  view.replaceChildren(
    card(head(club.name, mine && el("button", { type: "button", class: "secondary", onclick: () => openSheet("Rename the club", (close) => {
      const name = el("input", { value: club.name, maxlength: 40, "aria-label": "Club name" });
      return [el("div", { class: "form" }, name),
        el("button", { type: "button", onclick: (e) => act(e.target, async () => { await pb.renameClub(id, name.value); close(); await reload(); }) }, "Save")];
    }) }, "Rename")),
      mine ? el("a", { class: "button", href: here(`new=${id}`) }, "Start a session")
        : empty("Only this club's managers can change it or start its sessions.")),
    card(head(`Players (${members.length})`),
      members.length ? el("div", { class: "list" }, ...members.map((p) => playerRow(p, reload,
        mine && el("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${p.name} from the club`, onclick: (e) => act(e.target, async () => {
          await pb.removeClubPlayer(id, p.id); await reload();
        }) }, "🗑")))) : empty("No players yet."),
      mine && others.length > 0 && el("div", { class: "form" }, pickPlayer, el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, async () => {
        await pb.addClubPlayer(id, pickPlayer.value); await reload();
      }) }, "Add")),
      mine && el("div", { class: "form" }, newIcon, newName, el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, async () => {
        const pid = await pb.makePlayer(newName.value, newIcon.value);
        await pb.addClubPlayer(id, pid); await reload();
      }) }, "New"))),
    card(head("Managers"),
      el("div", { class: "list" }, ...club.managers.map((uid) => el("div", { class: "item" },
        el("span", { class: "who" }, managerName(manager(uid))),
        mine && club.managers.length > 1 && el("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${manager(uid)?.username || "this manager"}`,
          onclick: (e) => { if (uid !== me.id || confirm("Stop managing this club?")) act(e.target, async () => { await pb.removeClubManager(id, uid); await reload(); }); } }, "🗑")))),
      mine && pickManager.options.length > 0 && el("div", { class: "form" }, pickManager, el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, async () => {
        await pb.addClubManager(id, pickManager.value); await reload();
      }) }, "Add")),
      el("p", { class: "hint" }, "Managers are accounts with the pickleball manager role.")));
}

// ---------- managers: start a session ----------
async function newSession(clubId) {
  setBack(clubId ? here(`club=${clubId}`) : here(), clubId ? "Club" : "Pickleball");
  const [clubs, players] = await Promise.all([pb.clubs(), pb.players()]);
  const mine = clubs.filter((c) => c.managers.includes(me.id));
  let club = mine.find((c) => c.id === clubId) || null;
  let courts = 2, algorithm = "fair";
  const chosen = new Set(club ? club.players : []);
  const guests = [];

  const clubSelect = el("select", { "aria-label": "Club", onchange: () => {
    club = mine.find((c) => c.id === clubSelect.value) || null;
    chosen.clear();
    for (const p of club?.players || []) chosen.add(p);
    for (const g of guests) chosen.add(g);
    drawPlayers();
  } }, el("option", { value: "" }, "No club"), ...mine.map((c) => el("option", { value: c.id, selected: c.id === club?.id }, c.name)));
  const courtSelect = el("select", { "aria-label": "Courts", onchange: () => { courts = Number(courtSelect.value); } },
    ...Array.from({ length: 12 }, (_, i) => el("option", { value: i + 1, selected: i + 1 === courts }, String(i + 1))));
  const algoHint = el("p", { class: "hint" });
  const algoSeg = el("div", { class: "seg", role: "group", "aria-label": "Rotation" });
  const drawAlgo = () => {
    algoSeg.replaceChildren(...rot.ALGORITHMS.map((a) => el("button", { type: "button", "aria-pressed": String(a.id === algorithm),
      onclick: () => { algorithm = a.id; drawAlgo(); } }, a.title)));
    algoHint.textContent = rot.ALGORITHMS.find((a) => a.id === algorithm).hint;
  };
  drawAlgo();

  const list = el("div", { class: "list" });
  const count = el("h2");
  const drawPlayers = () => {
    const inClub = club ? players.filter((p) => club.players.includes(p.id) || guests.includes(p.id)) : players.filter((p) => chosen.has(p.id) || guests.includes(p.id));
    const rest = players.filter((p) => !inClub.includes(p));
    const row = (p) => el("label", { class: "check" }, el("input", { type: "checkbox", checked: chosen.has(p.id),
      onchange: (e) => { if (e.target.checked) chosen.add(p.id); else chosen.delete(p.id); count.textContent = `Who's playing (${chosen.size})`; } }),
    el("span", { class: "who" }, face(p)));
    list.replaceChildren(...(inClub.length ? inClub.map(row) : [empty(club ? "This club has no players yet." : "Tick who's playing, or add guests.")]),
      ...(rest.length ? [el("details", {}, el("summary", { class: "check" }, `Other players (${rest.length})`), el("div", { class: "list" }, ...rest.map(row)))] : []));
    count.textContent = `Who's playing (${chosen.size})`;
  };
  drawPlayers();
  const guestName = el("input", { placeholder: "Guest's name", maxlength: 24, "aria-label": "Guest's name" });
  const guestIcon = el("input", { class: "emoji", placeholder: "👤", maxlength: 8, "aria-label": "Guest's icon (an emoji)" });

  view.replaceChildren(
    card(head("Start a session"),
      el("label", { class: "field" }, "Club", clubSelect),
      el("label", { class: "field" }, "Courts", courtSelect),
      algoSeg, algoHint),
    card(count, list,
      el("div", { class: "form" }, guestIcon, guestName, el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, async () => {
        const id = await pb.makePlayer(guestName.value, guestIcon.value);
        players.push({ id, name: guestName.value.trim(), icon: guestIcon.value.trim() || "👤" });
        guests.push(id); chosen.add(id);
        guestName.value = ""; guestIcon.value = "";
        drawPlayers();
      }) }, "Add guest"))),
    el("button", { type: "button", onclick: (e) => act(e.target, async () => {
      const id = await pb.startSession({ club: club?.id || null, courts, algorithm, players: [...chosen] });
      location.assign(here(`s=${id}`));
    }) }, "Start session"));
}

// ---------- a session: run it (managers, helpers) or watch it ----------
const helperKey = (id) => `pickleball-help-${id}`;
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

async function joinAsHelper(id, code) {
  view.replaceChildren(card(el("p", { class: "hint" }, "Joining as a helper…")));
  const watchCode = await pb.becomeHelper(id, code);
  store.set(helperKey(id), watchCode);
  location.replace(here(`s=${id}`));
}

async function sessionView(id) {
  setBack(here(), "Pickleball");
  let watchCode = null, runner = false;
  if (me.manager) {
    const [sessions, clubs] = await Promise.all([pb.sessions(), pb.clubs()]);
    const s = sessions.find((x) => x.id === id);
    if (s && runs(s, clubs)) { watchCode = s.watch_code; runner = true; }
  }
  watchCode ||= store.get(helperKey(id));
  if (!watchCode) {
    view.replaceChildren(card(el("h2", {}, "Helping out?"), el("p", {}, "Scan the helper QR on the manager's phone to run the courts and the line.")));
    return;
  }
  await live(watchCode, { id, runner, helper: true });
}

async function watchView(code) {
  if (me?.manager) setBack(here(), "Pickleball");
  await live(code, { helper: false, runner: false });
}

// Shows the session for its watch code, refreshing every few seconds; helpers and runners also get the controls.
async function live(code, role) {
  let v = null;
  let busy = false;
  async function load() {
    const next = await pb.watch(code);
    if (!next) { view.replaceChildren(card(empty("This link doesn't work. Ask for a new one."))); return false; }
    v = next;
    draw();
    return true;
  }
  async function poll() {
    if (busy || sheet.open || document.hidden) return;
    try { const before = v?.version; const now = await pb.watch(code); if (now && (now.version !== before || !v)) { v = now; draw(); } else if (now) draw(); } catch {}
  }

  // The queue state as the page sees it now: who's here and on a court, then the next match picked.
  const herePlayers = () => v.players.filter((p) => p.here).map((p) => p.id);
  const open = () => v.matches.filter((m) => !m.ended_at);
  const onCourt = () => open().flatMap((m) => [...m.side_a, ...m.side_b]);
  const state = () => rot.refresh(rot.tidy(v.state, herePlayers(), onCourt()), v.algorithm);
  const person = (pid) => v.players.find((p) => p.id === pid);
  const names = (ids) => ids.map((pid) => face(person(pid))).join(" & ");
  const canEdit = () => role.helper && !v.ended_at;

  // Saves a change to the line on the latest version (`change` gets the state and returns the new one).
  async function save(change, action, detail = null) {
    busy = true;
    try {
      await load();
      await pb.saveState(v.id, v.version, change(state()), action, detail);
      await load();
    } finally { busy = false; }
  }
  async function startOn(court, button) {
    await act(button, async () => {
      busy = true;
      try {
        await load();
        const before = state();
        const { state: after, match } = rot.startNext(before, v.algorithm);
        if (!match) return;
        await pb.saveState(v.id, v.version, after, "started match", { court });
        try { await pb.startMatch(v.id, court, match.a, match.b); } catch (err) {
          await load();
          await pb.saveState(v.id, v.version, before, "undid start");
          throw err;
        }
        await load();
      } finally { busy = false; }
    });
  }
  function endMatchSheet(m) {
    openSheet(`End court ${m.court}`, (close) => {
      let winner = null;
      const a = el("input", { type: "number", inputmode: "numeric", min: 0, max: 99, "aria-label": "Score, side 1" });
      const b = el("input", { type: "number", inputmode: "numeric", min: 0, max: 99, "aria-label": "Score, side 2" });
      const seg = el("div", { class: "seg", role: "group", "aria-label": "Who won?" });
      const drawSeg = () => seg.replaceChildren(...[["a", names(m.side_a)], ["b", names(m.side_b)], [null, "Skip"]].map(([k, text]) =>
        el("button", { type: "button", "aria-pressed": String(winner === k), onclick: () => { winner = k; drawSeg(); } }, text)));
      drawSeg();
      const sync = () => { const x = a.value, y = b.value; if (x !== "" && y !== "" && x !== y) { winner = Number(x) > Number(y) ? "a" : "b"; drawSeg(); } };
      a.addEventListener("input", sync); b.addEventListener("input", sync);
      return [el("p", { class: "muted" }, "Who won? (optional)"), seg,
        el("div", { class: "scores" }, el("label", {}, "Side 1", a), el("label", {}, "Side 2", b)),
        el("button", { type: "button", onclick: (e) => act(e.target, async () => {
          busy = true;
          try {
            await pb.endMatch(m.id, a.value, b.value);
            close();
            await save((s) => rot.finish(s, v.algorithm, { a: m.side_a, b: m.side_b }, winner), "ended match", { match: m.id, winner });
          } finally { busy = false; }
        }) }, "End match")];
    });
  }
  function playerSheet(pid, s) {
    const p = person(pid);
    const partner = s.pairs.find((x) => x.includes(pid))?.find((x) => x !== pid);
    const away = s.away.includes(pid);
    const others = s.order.filter((x) => x !== pid && x !== partner);
    openSheet(face(p), (close) => {
      const run = (fn, action) => (e) => act(e.target, async () => { close(); await save(fn, action, { player: pid }); });
      const mate = el("select", { "aria-label": "Play with" }, ...others.map((x) => el("option", { value: x }, face(person(x)))));
      return [
        !away && el("button", { type: "button", class: "secondary", onclick: run((st) => rot.skip(st, v.algorithm, pid), "skipped") }, "Skip the next match"),
        el("button", { type: "button", class: "secondary", onclick: run((st) => rot.setAway(st, v.algorithm, pid, !away), away ? "back" : "on a break") },
          away ? "Back from a break" : "Take a break"),
        partner ? el("button", { type: "button", class: "secondary", onclick: run((st) => rot.unpair(st, v.algorithm, pid), "unpaired") },
          `Stop pairing with ${person(partner)?.name}`)
          : others.length > 0 && el("div", { class: "form" }, mate, el("button", { type: "button", class: "secondary",
            onclick: (e) => act(e.target, async () => { const x = mate.value; close(); await save((st) => rot.pair(st, v.algorithm, pid, x), "paired", { player: pid, with: x }); }) }, "Pair")),
        role.runner && el("button", { type: "button", class: "secondary", onclick: (e) => {
          if (!confirm(`${p.name} leaves the session?`)) return;
          act(e.target, async () => { close(); busy = true; try { await pb.setHere(v.id, pid, false); await load(); } finally { busy = false; } });
        } }, "Leaves the session"),
      ];
    });
  }
  function swapSheet(pid, s) {
    const inNext = [...s.next.a, ...s.next.b];
    const choices = [...s.order.filter((x) => !inNext.includes(x) && !s.away.includes(x)), ...inNext.filter((x) => x !== pid)];
    openSheet(`Instead of ${person(pid)?.name}`, (close) => {
      const pick = el("select", { "aria-label": "Who plays instead" }, ...choices.map((x) => el("option", { value: x }, face(person(x)))));
      return [choices.length ? el("div", { class: "form" }, pick, el("button", { type: "button", onclick: (e) => act(e.target, async () => {
        const x = pick.value; close(); await save((st) => rot.swap(st, v.algorithm, pid, x), "swapped", { out: pid, in: x });
      }) }, "Swap")) : empty("Nobody else is waiting.")];
    });
  }
  function sessionSheet() {
    openSheet("Session", (close) => {
      const courts = el("select", { "aria-label": "Courts" }, ...Array.from({ length: 12 }, (_, i) => el("option", { value: i + 1, selected: i + 1 === v.courts }, String(i + 1))));
      let algorithm = v.algorithm;
      const seg = el("div", { class: "seg", role: "group", "aria-label": "Rotation" });
      const drawSeg = () => seg.replaceChildren(...rot.ALGORITHMS.map((a) => el("button", { type: "button", "aria-pressed": String(a.id === algorithm),
        onclick: () => { algorithm = a.id; drawSeg(); } }, a.title)));
      drawSeg();
      return [el("label", { class: "field" }, "Courts", courts), seg,
        el("button", { type: "button", onclick: (e) => act(e.target, async () => {
          await pb.setSession(v.id, Number(courts.value), algorithm); close(); await load();
        }) }, "Save")];
    });
  }
  async function addPlayersSheet() {
    const all = await pb.players();
    const ids = new Set(v.players.filter((p) => p.here).map((p) => p.id));
    const rest = all.filter((p) => !ids.has(p.id));
    openSheet("Add players", (close) => {
      const name = el("input", { placeholder: "Guest's name", maxlength: 24, "aria-label": "Guest's name" });
      const icon = el("input", { class: "emoji", placeholder: "👤", maxlength: 8, "aria-label": "Guest's icon (an emoji)" });
      const add = (pid) => act(null, async () => { close(); busy = true; try { await pb.setHere(v.id, pid, true); await load(); } finally { busy = false; } });
      return [rest.length > 0 && el("div", { class: "list" }, ...rest.map((p) => el("button", { type: "button", class: "item", onclick: () => add(p.id) },
        el("span", { class: "who" }, face(p)), el("span", { class: "meta" }, "Add")))),
      el("div", { class: "form" }, icon, name, el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, async () => {
        const pid = await pb.makePlayer(name.value, icon.value); await add(pid);
      }) }, "Add guest"))];
    });
  }
  async function helperSheet() {
    const code = await pb.helperCode(v.id);
    const link = new URL(here(`s=${v.id}&h=${code.replace(/-/g, "")}`), location.href).href;
    const box = el("div", { class: "qr" });
    try {
      const { qrcode } = await import("../../shared/qrcode.js");
      const qr = qrcode(0, "M"); qr.addData(link); qr.make();
      const n = qr.getModuleCount(), q = 4;
      let d = "";
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + q} ${y + q}h1v1h-1z`;
      box.innerHTML = `<svg viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" role="img" aria-label="QR code: scan to help run this session"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
    } catch {}
    openSheet("Helper QR", () => [
      el("p", {}, "Whoever scans this can run the courts and the line for this session. A new QR stops the old one."), box,
      el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, () => share(link, "Help run the courts")) }, "Share link")]);
  }
  async function share(url, title) {
    if (navigator.share) { try { await navigator.share({ title, url }); return; } catch (err) { if (err?.name === "AbortError") return; } }
    await navigator.clipboard.writeText(url);
    showError(new CoreError("Link copied."));
  }

  function draw() {
    const s = state();
    const status = $("status");
    status.hidden = false;
    status.textContent = (v.club && !role.runner ? `${v.club}: ` : "") + (v.ended_at ? "This session has ended"
      : `${onCourt().length} playing · ${s.order.filter((x) => !s.away.includes(x)).length} waiting`);
    const sections = [];

    // Courts
    for (let c = 1; c <= v.courts; c++) {
      const m = open().find((x) => x.court === c);
      sections.push(el("section", { class: "card court" },
        head(`Court ${c}`, el("span", { class: "meta muted" }, m ? ago(m.started_at) : "")),
        m ? el("div", { class: "vs" }, el("div", { class: "side" }, ...m.side_a.map((x) => el("span", {}, face(person(x))))),
          el("span", { class: "muted" }, "vs"), el("div", { class: "side" }, ...m.side_b.map((x) => el("span", {}, face(person(x))))))
          : el("p", { class: "free" }, v.ended_at ? "—" : "Free"),
        canEdit() && (m ? el("button", { type: "button", class: "secondary", onclick: () => endMatchSheet(m) }, "End match")
          : s.next && el("button", { type: "button", onclick: (e) => startOn(c, e.target) }, "Start next match here"))));
    }

    // Next match
    if (!v.ended_at) {
      const nextSide = (ids, side) => el("div", { class: "side" }, ...ids.map((x) => canEdit()
        ? el("button", { type: "button", "aria-label": `Swap ${person(x)?.name}`, onclick: () => swapSheet(x, s) }, face(person(x)))
        : el("span", {}, face(person(x)))),
      canEdit() && el("button", { type: "button", class: "secondary", "aria-label": ids.length === 2 ? `Side ${side === "a" ? 1 : 2}: one player` : `Side ${side === "a" ? 1 : 2}: two players`,
        onclick: (e) => act(e.target, () => save((st) => rot.setSize(st, v.algorithm, side, ids.length === 2 ? 1 : 2), "changed sides")) },
      ids.length === 2 ? "Make single" : "Make double"));
      sections.push(card(head("Next match", s.next?.manual ? el("span", { class: "tag" }, "Changed") : null),
        s.next ? el("div", { class: "vs" }, nextSide(s.next.a, "a"), el("span", { class: "muted" }, "vs"), nextSide(s.next.b, "b"))
          : empty("Waiting for at least two players."),
        canEdit() && s.next && el("p", { class: "hint" }, "Tap a name to swap someone in."),
        canEdit() && s.next?.manual && el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, () => save((st) => rot.repick(st, v.algorithm), "picked again")) }, "Pick again")));
    }

    // The line
    const line = s.order;
    const partner = (x) => s.pairs.find((p) => p.includes(x))?.find((y) => y !== x);
    const row = (x, i) => {
      const tags = [s.away.includes(x) && "Break", s.skipped.includes(x) && "Skips next", partner(x) && `With ${person(partner(x))?.name}`,
        s.next && [...s.next.a, ...s.next.b].includes(x) && "Next"].filter(Boolean);
      const inner = [el("span", { class: "line-no" }, String(i + 1)), el("span", { class: "who" }, face(person(x))),
        ...tags.map((t) => el("span", { class: "tag" }, t)), el("span", { class: "meta" }, `${s.games[x] || 0} played`)];
      return canEdit() ? el("button", { type: "button", class: `item${s.away.includes(x) ? " away" : ""}`, onclick: () => playerSheet(x, s) }, ...inner)
        : el("div", { class: `item${s.away.includes(x) ? " away" : ""}` }, ...inner);
    };
    if (!v.ended_at) {
      sections.push(card(head(`In line (${line.length})`, role.runner && el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, addPlayersSheet) }, "Add")),
        line.length ? el("div", { class: "list" }, ...line.map(row)) : empty("Nobody waiting."),
        canEdit() && line.length > 0 && el("p", { class: "hint" }, "Tap someone to skip them, give them a break or pair them.")));
    }

    // Recent results
    const done = v.matches.filter((m) => m.ended_at).slice(-5).reverse();
    if (done.length) {
      sections.push(card(head("Last matches"), el("div", { class: "list" }, ...done.map((m) => el("div", { class: "item wrap" },
        el("span", { class: "who" }, `${names(m.side_a)} vs ${names(m.side_b)}`),
        el("span", { class: "meta" }, m.score_a != null ? `${m.score_a}–${m.score_b}` : `Court ${m.court}`))))));
    }

    // Runners: the session's links and settings
    if (role.runner && !v.ended_at) {
      const watchLink = new URL(here(`w=${code}`), location.href).href;
      sections.push(card(head(v.club || "Session"),
        el("p", { class: "muted" }, `${rot.ALGORITHMS.find((a) => a.id === v.algorithm)?.title || v.algorithm} · ${v.courts} court${v.courts > 1 ? "s" : ""} · started ${ago(v.started_at)} ago`),
        el("div", { class: "row" },
          el("button", { type: "button", onclick: (e) => act(e.target, () => share(watchLink, "Who's playing")) }, "Share live view"),
          el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, helperSheet) }, "Helper QR")),
        el("div", { class: "row" },
          el("button", { type: "button", class: "secondary", onclick: sessionSheet }, "Settings"),
          el("button", { type: "button", class: "secondary", onclick: (e) => {
            if (confirm("End the session? Matches on court end too.")) act(e.target, async () => { await pb.endSession(v.id); await load(); });
          } }, "End session"))));
    } else if (!role.helper && !v.ended_at) {
      sections.push(el("p", { class: "hint" }, "Updates by itself."));
    }
    view.replaceChildren(...sections);
  }

  if (!(await load())) return;
  if (!v.ended_at) setInterval(poll, 4000);
}
