// Pickleball (see shared/pickleball.js for the data, ./rotation.js for who plays next). One page, by its address:
//   ./                 the website's home: what this is, how it works, how to install it
//   ./?dash            the app's home (where the installed app opens): start a session, live and past sessions, clubs
//   ./?players         every player;  ./?club=<id>: a club's players and managers;  ./?new[=<club>]: start a session
//   ./?s=<id>          run a session: its managers and helpers (courts, up next, the line and its overrides)
//   ./?s=<id>&h=<code> become a helper with the session's helper code (the QR its manager shows)
//   ./?w=<code>        the live view: anyone with the link, read only (an ended session: its results)
import * as pb from "../../shared/pickleball.js";
import { CoreError } from "../../shared/core.js";
import * as rot from "./rotation.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const keep = params.get("backend") === "fake" ? "&backend=fake" : ""; // (the UI tests' stand-in stays on)
const here = (query = "") => `./?${query}${keep}`.replace("?&", "?").replace(/\?$/, "");
const view = $("view");
const show = (...kids) => view.replaceChildren(...kids.flat().filter(Boolean));
// Opened as the installed Pickleball app (its manifest starts at ./?dash&app): no ‹ out of it from its home.
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
let noteTimer;
function note(text) { $("note").textContent = text; clearTimeout(noteTimer); noteTimer = setTimeout(() => { $("note").textContent = ""; }, 3000); }
// Runs an action from a button: disables it meanwhile, shows any error.
async function act(button, fn) {
  if (button) button.disabled = true;
  showError(null);
  try { await fn(); } catch (err) { showError(err); }
  if (button) button.disabled = false;
}
const minutes = (from, to = Date.now()) => Math.max(0, Math.floor((new Date(to) - new Date(from)) / 60000));
const ago = (iso) => { const m = minutes(iso); return m < 1 ? "just now" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const card = (...kids) => el("section", { class: "card" }, ...kids);
const head = (title, ...right) => el("div", { class: "head" }, el("h2", {}, title), ...right);
const empty = (text) => el("p", { class: "empty" }, text);
const face = (p) => `${p?.icon || "👤"} ${p?.name || "?"}`;
function setBack(href, label) { $("back").href = href; $("back").setAttribute("aria-label", label); $("back").hidden = false; }
function stats(items) {
  $("stats").hidden = !items;
  if (items) $("stats").replaceChildren(...items.map(([n, label]) => el("span", { class: "stat" }, el("b", {}, String(n)), label)));
}

// The sheet: a dialog for a choice, built by fill(close). Closes on Cancel or a done action.
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
    if (params.has("w")) await watchView(params.get("w"));
    else if (params.has("s") && params.has("h")) await joinAsHelper(params.get("s"), params.get("h"));
    else if (params.has("s")) await sessionView(params.get("s"));
    else if (["dash", "club", "new", "players"].some((k) => params.has(k))) {
      setBack(installed ? "" : here(), "About Pickleball");
      if (installed && params.has("dash")) $("back").hidden = true;
      if (!me.manager) notManager();
      else if (params.has("club")) await clubView(params.get("club"));
      else if (params.has("new")) await newSession(params.get("new"));
      else if (params.has("players")) await playersView();
      else await dashboard();
    } else landing();
  } catch (err) {
    show(card(empty("Can't load this right now.")));
    showError(err);
  }
})();

// ---------- the website's home ----------
let installPrompt = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; $("install-now")?.removeAttribute("hidden"); });

function landing() {
  const open = me.manager ? el("a", { class: "button", href: here("dash") }, "Open Pickleball")
    : me.account ? el("p", {}, "You're signed in. Ask an admin for the manager role to run sessions.")
      : el("a", { class: "button", href: "../profile/" }, "Sign in to run sessions");
  const feature = (em, title, text) => el("div", { class: "feature" }, el("span", { class: "em", "aria-hidden": "true" }, em), el("b", {}, title), el("span", {}, text));
  show(
    el("section", { class: "card hero" },
      el("img", { src: "./icons/icon-192.png", alt: "" }),
      el("h2", {}, "Court rotation, sorted"),
      el("p", {}, "Who's on court, who's next and who's waiting, for your pickleball group. No more arguing over the paddle stack."),
      open),
    card(el("h2", {}, "How it works"),
      el("ol", { class: "steps" },
        el("li", {}, el("span", {}, el("b", {}, "Make a club. "), "Add the people you play with: a name and an emoji, no accounts needed.")),
        el("li", {}, el("span", {}, el("b", {}, "Start a session. "), "Pick the courts and the rotation, tick who's here and add any guests.")),
        el("li", {}, el("span", {}, el("b", {}, "Play. "), "When a court frees up, tap to put the next match on it. Everyone else waits in line.")),
        el("li", {}, el("span", {}, el("b", {}, "Share. "), "Send the live link so everyone sees who's next, and show the helper QR to whoever helps run the courts.")))),
    card(el("h2", {}, "Features"),
      el("div", { class: "features" },
        feature("⚖️", "Fair rotation", "Whoever's played least goes next, or a simple queue, or winners stay."),
        feature("🔁", "Your call", "Skip someone, give them a break, pair partners or swap anyone in."),
        feature("📺", "Live view", "Anyone with the link sees the courts and the line, updated by itself."),
        feature("🙋", "Helpers", "A QR lets someone else run the courts while you play."),
        feature("⏱️", "Times and scores", "Match times are kept; scores if you want them."),
        feature("🏆", "Results", "Each session ends with who played and who won."))),
    card(el("h2", {}, "Install it"),
      el("p", {}, "Pickleball works as its own app on your phone:"),
      el("ul", { class: "steps" },
        el("li", {}, el("span", {}, el("b", {}, "iPhone: "), "Open this page in Safari, tap Share, then Add to Home Screen.")),
        el("li", {}, el("span", {}, el("b", {}, "Android: "), "Open the browser menu and tap Install app."))),
      el("button", { type: "button", id: "install-now", hidden: !installPrompt, onclick: async () => {
        if (!installPrompt) return;
        installPrompt.prompt();
        installPrompt = null;
        $("install-now").hidden = true;
      } }, "Install Pickleball")),
    el("p", { class: "hint" }, "Players don't need anything: the manager shares a live link."));
}

function notManager() {
  show(card(el("h2", {}, "Managers only"),
    el("p", {}, me.account ? "Only pickleball managers run sessions. Ask an admin for the manager role."
      : "Only pickleball managers run sessions, signed in to their account. Players just open the live link they're given."),
    !me.account && el("a", { class: "button", href: "../profile/" }, "Sign in"),
    el("a", { class: "button secondary", href: here() }, "About Pickleball")));
}

// ---------- the app's home (managers) ----------
const runs = (s, clubs) => s.started_by === me.id || !!clubs.find((c) => c.id === s.club_id)?.managers.includes(me.id);

async function dashboard() {
  const [sessions, past, clubs, players] = await Promise.all([pb.sessions(), pb.pastSessions(), pb.clubs(), pb.players()]);
  const clubName = (id) => clubs.find((c) => c.id === id)?.name || "Pickup session";
  const mine = sessions.filter((s) => runs(s, clubs));
  const clubInput = el("input", { placeholder: "Club name", maxlength: 40, "aria-label": "New club's name" });
  stats([[mine.length, mine.length === 1 ? "live session" : "live sessions"], [clubs.length, clubs.length === 1 ? "club" : "clubs"], [players.length, players.length === 1 ? "player" : "players"]]);

  show(
    el("a", { class: "button big-start", href: here("new") }, "🏓 Start a session"),
    mine.length > 0 && card(head("Live now"),
      el("div", { class: "list" }, ...mine.map((s) => el("a", { class: "item", href: here(`s=${s.id}`) },
        el("span", { class: "who" }, el("span", { class: "live-dot", "aria-hidden": "true" }), clubName(s.club_id)),
        el("span", { class: "meta" }, `${s.courts} court${s.courts > 1 ? "s" : ""} · ${ago(s.started_at)}`))))),
    card(head("Clubs"),
      clubs.length ? el("div", { class: "list" }, ...clubs.map((c) => el("a", { class: "item", href: here(`club=${c.id}`) },
        el("span", { class: "who" }, c.name), el("span", { class: "meta" }, `${c.players.length} player${c.players.length === 1 ? "" : "s"}`))))
        : empty("No clubs yet. A club is the list of people you play with."),
      el("div", { class: "form" }, clubInput, el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, async () => {
        const id = await pb.makeClub(clubInput.value);
        location.assign(here(`club=${id}`));
      }) }, "Add"))),
    card(head("Past sessions"),
      past.length ? el("div", { class: "list" }, ...past.slice(0, 10).map((s) => el("a", { class: "item", href: here(`w=${s.watch_code}`) },
        el("span", { class: "who" }, clubName(s.club_id)), el("span", { class: "meta" }, day(s.started_at)))))
        : empty("Finished sessions and their results show up here.")),
    el("a", { class: "button secondary", href: here("players") }, `All players (${players.length})`));
}

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
const newPlayerForm = (label, onAdd) => {
  const name = el("input", { placeholder: "Name", maxlength: 24, "aria-label": `${label}'s name` });
  const icon = el("input", { class: "emoji", placeholder: "👤", maxlength: 8, "aria-label": `${label}'s icon (an emoji)` });
  return el("div", { class: "form" }, icon, name, el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, async () => {
    const id = await pb.makePlayer(name.value, icon.value);
    await onAdd(id, { id, name: name.value.trim(), icon: icon.value.trim() || "👤" });
    name.value = ""; icon.value = "";
  }) }, "Add"));
};

async function playersView() {
  setBack(here("dash"), "Pickleball home");
  const players = await pb.players();
  show(card(head(`Players (${players.length})`),
    players.length ? el("div", { class: "list" }, ...players.map((p) => playerRow(p, playersView))) : empty("No players yet."),
    newPlayerForm("New player", () => playersView()),
    el("p", { class: "hint" }, "Players don't need an account: a name and an emoji is enough.")));
}

// ---------- a club ----------
async function clubView(id) {
  setBack(here("dash"), "Pickleball home");
  const [clubs, players, managers] = await Promise.all([pb.clubs(), pb.players(), pb.managers()]);
  const club = clubs.find((c) => c.id === id);
  if (!club) { show(card(empty("There's no such club."))); return; }
  const mine = club.managers.includes(me.id);
  const reload = () => clubView(id);
  const members = players.filter((p) => club.players.includes(p.id));
  const others = players.filter((p) => !club.players.includes(p.id));
  const manager = (uid) => managers.find((m) => m.id === uid);
  const managerName = (m) => (m ? `${m.avatar || "👤"} ${m.display_name || m.username} (@${m.username})` : "Someone");
  const pickPlayer = el("select", { "aria-label": "Player to add" }, ...others.map((p) => el("option", { value: p.id }, face(p))));
  const pickManager = el("select", { "aria-label": "Manager to add" },
    ...managers.filter((m) => !club.managers.includes(m.id)).map((m) => el("option", { value: m.id }, managerName(m))));
  stats([[members.length, members.length === 1 ? "player" : "players"], [club.managers.length, club.managers.length === 1 ? "manager" : "managers"]]);

  show(
    card(head(club.name, mine && el("button", { type: "button", class: "secondary", onclick: () => openSheet("Rename the club", (close) => {
      const name = el("input", { value: club.name, maxlength: 40, "aria-label": "Club name" });
      return [el("div", { class: "form" }, name),
        el("button", { type: "button", onclick: (e) => act(e.target, async () => { await pb.renameClub(id, name.value); close(); await reload(); }) }, "Save")];
    }) }, "Rename")),
    mine ? el("a", { class: "button big-start", href: here(`new=${id}`) }, "🏓 Start a session")
      : empty("Only this club's managers can change it or start its sessions.")),
    card(head("Players"),
      members.length ? el("div", { class: "list" }, ...members.map((p) => playerRow(p, reload,
        mine && el("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${p.name} from the club`, onclick: (e) => act(e.target, async () => {
          await pb.removeClubPlayer(id, p.id); await reload();
        }) }, "🗑")))) : empty("No players yet."),
      mine && others.length > 0 && el("div", { class: "form" }, pickPlayer, el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, async () => {
        await pb.addClubPlayer(id, pickPlayer.value); await reload();
      }) }, "Add")),
      mine && newPlayerForm("New player", async (pid) => { await pb.addClubPlayer(id, pid); await reload(); })),
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

// ---------- start a session ----------
async function newSession(clubId) {
  setBack(clubId ? here(`club=${clubId}`) : here("dash"), clubId ? "Club" : "Pickleball home");
  const [clubs, players] = await Promise.all([pb.clubs(), pb.players()]);
  const mine = clubs.filter((c) => c.managers.includes(me.id));
  let club = mine.find((c) => c.id === clubId) || null;
  let courts = 2, algorithm = "fair";
  const chosen = new Set(club ? club.players : []);
  const guests = [];

  const clubSelect = el("select", { "aria-label": "Club", onchange: () => {
    club = mine.find((c) => c.id === clubSelect.value) || null;
    chosen.clear();
    for (const p of [...(club?.players || []), ...guests]) chosen.add(p);
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
    const shown = players.filter((p) => (club ? club.players.includes(p.id) : chosen.has(p.id)) || guests.includes(p.id));
    const rest = players.filter((p) => !shown.includes(p));
    const row = (p) => el("label", { class: "check" }, el("input", { type: "checkbox", checked: chosen.has(p.id),
      onchange: (e) => { if (e.target.checked) chosen.add(p.id); else chosen.delete(p.id); count.textContent = `Who's playing (${chosen.size})`; } }),
    el("span", { class: "who" }, face(p)));
    list.replaceChildren(...(shown.length ? shown.map(row) : [empty(club ? "This club has no players yet." : "Tick who's playing, or add guests.")]),
      ...(rest.length ? [el("details", {}, el("summary", { class: "check" }, `Other players (${rest.length})`), el("div", { class: "list" }, ...rest.map(row)))] : []));
    count.textContent = `Who's playing (${chosen.size})`;
  };
  drawPlayers();

  show(
    card(head("Start a session"),
      el("label", { class: "field" }, "Club", clubSelect),
      el("label", { class: "field" }, "Courts", courtSelect),
      algoSeg, algoHint),
    card(count, list, el("p", { class: "muted" }, "A guest plays today without joining the club:"),
      newPlayerForm("Guest", async (id, p) => { players.push(p); guests.push(id); chosen.add(id); drawPlayers(); })),
    el("button", { type: "button", class: "big-start", onclick: (e) => act(e.target, async () => {
      const id = await pb.startSession({ club: club?.id || null, courts, algorithm, players: [...chosen] });
      location.assign(here(`s=${id}`));
    }) }, "🏓 Start session"));
}

// ---------- a session: run it (managers, helpers) or watch it ----------
const helperKey = (id) => `pickleball-help-${id}`;
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

async function joinAsHelper(id, code) {
  show(card(el("p", { class: "hint" }, "Joining as a helper…")));
  const watchCode = await pb.becomeHelper(id, code);
  store.set(helperKey(id), watchCode);
  location.replace(here(`s=${id}`));
}

async function sessionView(id) {
  setBack(me.manager ? here("dash") : here(), me.manager ? "Pickleball home" : "About Pickleball");
  let watchCode = null, runner = false;
  if (me.manager) {
    const [sessions, clubs] = await Promise.all([pb.sessions(), pb.clubs()]);
    const s = sessions.find((x) => x.id === id);
    if (s && runs(s, clubs)) { watchCode = s.watch_code; runner = true; }
  }
  watchCode ||= store.get(helperKey(id));
  if (!watchCode) {
    show(card(el("h2", {}, "Helping out?"), el("p", {}, "Scan the helper QR on the manager's phone to run the courts and the line.")));
    return;
  }
  await live(watchCode, { runner, helper: true });
}

async function watchView(code) {
  setBack(me?.manager ? here("dash") : here(), me?.manager ? "Pickleball home" : "About Pickleball");
  await live(code, { helper: false, runner: false });
}

// The session for its watch code, refreshed every few seconds; helpers and runners also get the controls.
async function live(code, role) {
  let v = null;
  let busy = false;
  async function load() {
    const next = await pb.watch(code);
    if (!next) { show(card(empty("This link doesn't work. Ask for a new one."))); return false; }
    v = next;
    draw();
    return true;
  }
  async function poll() {
    if (busy || sheet.open || document.hidden) return;
    try { const now = await pb.watch(code); if (now) { v = now; draw(); } } catch {}
  }

  // The line as the page sees it now: who's here and on a court, then up next.
  const herePlayers = () => v.players.filter((p) => p.here).map((p) => p.id);
  const open = () => v.matches.filter((m) => !m.ended_at);
  const onCourt = () => open().flatMap((m) => [...m.side_a, ...m.side_b]);
  const state = () => rot.refresh(rot.tidy(v.state, herePlayers(), onCourt()), v.algorithm);
  const person = (pid) => v.players.find((p) => p.id === pid);
  const canEdit = () => role.helper && !v.ended_at;
  const chip = (pid, attrs = {}, tag = "span", ...extra) => el(tag, { class: "pchip", ...attrs },
    el("span", { "aria-hidden": "true" }, person(pid)?.icon || "👤"), el("span", { class: "name" }, person(pid)?.name || "?"), ...extra);

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
        if (!match) throw new CoreError("Each side needs at least one player.");
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
  const sideLines = (ids) => ids.map((x) => el("span", { class: "who" }, face(person(x))));
  function endMatchSheet(m) {
    openSheet(`End court ${m.court}`, (close) => {
      let winner = null;
      const a = el("input", { type: "number", inputmode: "numeric", min: 0, max: 99, placeholder: "–", "aria-label": "Score, left side" });
      const b = el("input", { type: "number", inputmode: "numeric", min: 0, max: 99, placeholder: "–", "aria-label": "Score, right side" });
      const seg = el("div", { class: "seg", role: "group", "aria-label": "Who won?" });
      const drawSeg = () => seg.replaceChildren(...[["a", m.side_a], ["b", m.side_b]].map(([k, ids]) =>
        el("button", { type: "button", "aria-pressed": String(winner === k), onclick: () => { winner = winner === k ? null : k; drawSeg(); } },
          el("span", { class: "list" }, ...sideLines(ids)))));
      drawSeg();
      const sync = () => { const x = a.value, y = b.value; if (x !== "" && y !== "" && x !== y) { winner = Number(x) > Number(y) ? "a" : "b"; drawSeg(); } };
      a.addEventListener("input", sync); b.addEventListener("input", sync);
      return [el("p", { class: "muted" }, "Who won? Both optional: tap the winners, or enter the score."), seg,
        el("div", { class: "scores" },
          el("label", {}, el("span", {}, "Left"), a),
          el("label", {}, el("span", {}, "Right"), b)),
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
  // Someone in line: skip, break, pair, put up next, leave.
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
  // Someone up next: swap them for someone, or take them out.
  function nextSheet(pid, s) {
    const inNext = [...s.next.a, ...s.next.b];
    const choices = [...s.order.filter((x) => !inNext.includes(x) && !s.away.includes(x)), ...inNext.filter((x) => x !== pid)];
    openSheet(face(person(pid)), (close) => {
      const pick = el("select", { "aria-label": "Who plays instead" }, ...choices.map((x) => el("option", { value: x }, face(person(x)))));
      return [choices.length > 0 && el("div", { class: "form" }, pick, el("button", { type: "button", onclick: (e) => act(e.target, async () => {
        const x = pick.value; close(); await save((st) => rot.swap(st, v.algorithm, pid, x), "swapped", { out: pid, in: x });
      }) }, "Swap")),
      el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, async () => {
        close(); await save((st) => rot.removeFromNext(st, v.algorithm, pid), "took out", { player: pid });
      }) }, "Take out of this match")];
    });
  }
  // An empty spot up next: whoever's waiting.
  function slotSheet(side, s) {
    const inNext = s.next ? [...s.next.a, ...s.next.b] : [];
    const choices = s.order.filter((x) => !s.away.includes(x) && !inNext.includes(x));
    openSheet("Who plays here?", (close) => [choices.length
      ? el("div", { class: "list" }, ...choices.map((x) => el("button", { type: "button", class: "item", onclick: (e) => act(e.target, async () => {
        close(); await save((st) => rot.addToNext(st, v.algorithm, side, x), "put in", { player: x, side });
      }) }, el("span", { class: "who" }, face(person(x))), el("span", { class: "meta" }, `${s.games[x] || 0} played`))))
      : empty("Nobody else is waiting.")]);
  }
  function sessionSheet() {
    openSheet("Settings", (close) => {
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
    const add = (pid) => act(null, async () => { busy = true; try { await pb.setHere(v.id, pid, true); await load(); } finally { busy = false; } });
    openSheet("Add players", (close) => [rest.length > 0 && el("div", { class: "list" }, ...rest.map((p) => el("button", { type: "button", class: "item", onclick: () => { close(); add(p.id); } },
      el("span", { class: "who" }, face(p)), el("span", { class: "meta" }, "Add")))),
    el("p", { class: "muted" }, "Or a guest:"),
    newPlayerForm("Guest", async (pid) => { close(); await add(pid); })]);
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
    note("Link copied.");
  }

  // A court: two halves, players (or slots) on each.
  function court(left, right, { next = false, freeText = null } = {}) {
    return el("div", { class: `court${next ? " next" : ""}` },
      el("div", { class: "half a" }, ...left), el("div", { class: "net", "aria-hidden": "true" }), el("div", { class: "half b" }, ...right),
      freeText && el("div", { class: "free" }, el("span", {}, freeText)));
  }

  function results() {
    const done = v.matches.filter((m) => m.ended_at);
    const tally = {};
    for (const m of done) {
      for (const [side, ids] of [["a", m.side_a], ["b", m.side_b]]) {
        for (const x of ids) {
          const t = (tally[x] ||= { played: 0, won: 0 });
          t.played++;
          if (m.score_a != null && m.score_a !== m.score_b && (side === "a") === (m.score_a > m.score_b)) t.won++;
        }
      }
    }
    const rows = Object.entries(tally).sort(([, x], [, y]) => y.won - x.won || y.played - x.played);
    const minutesPlayed = done.reduce((n, m) => n + minutes(m.started_at, m.ended_at), 0);
    stats([[done.length, done.length === 1 ? "match" : "matches"], [rows.length, "players"], [minutesPlayed, "min played"]]);
    return [
      card(head(v.club || "Pickup session"), el("p", { class: "muted" }, `${day(v.started_at)} · ${rot.ALGORITHMS.find((a) => a.id === v.algorithm)?.title || ""} rotation · ${v.courts} court${v.courts > 1 ? "s" : ""}`)),
      rows.length > 0 && card(head("🏆 Results"),
        el("table", { class: "board" },
          el("thead", {}, el("tr", {}, el("th", {}, "Player"), el("th", {}, "Played"), el("th", {}, "Won"))),
          el("tbody", {}, ...rows.map(([x, t]) => el("tr", {}, el("td", {}, face(person(x))), el("td", {}, String(t.played)), el("td", {}, String(t.won)))))),
        el("p", { class: "hint" }, "Wins count matches with a score.")),
      matchList(done.slice().reverse(), "Matches")];
  }
  function matchList(list, title) {
    if (!list.length) return null;
    return card(head(title), el("div", { class: "results" }, ...list.flatMap((m, i) => {
      const scored = m.score_a != null;
      const winA = scored && m.score_a > m.score_b, winB = scored && m.score_b > m.score_a;
      return [i > 0 && el("div", { class: "divider" }),
        el("div", { class: `sideList${winA ? " won" : ""}` }, ...m.side_a.map((x) => el("span", {}, face(person(x))))),
        el("div", { class: "score" }, scored ? `${m.score_a}–${m.score_b}` : "vs"),
        el("div", { class: `sideList right${winB ? " won" : ""}` }, ...m.side_b.map((x) => el("span", {}, face(person(x)))))].filter(Boolean);
    })));
  }

  function draw() {
    if (v.ended_at) { show(...results()); return; }
    const s = state();
    const waiting = s.order.filter((x) => !s.away.includes(x)).length;
    stats([[onCourt().length, "playing"], [waiting, "waiting"], [v.courts, v.courts === 1 ? "court" : "courts"]]);
    const sections = [];

    // Courts
    for (let c = 1; c <= v.courts; c++) {
      const m = open().find((x) => x.court === c);
      sections.push(card(
        el("div", { class: "court-head" }, el("h2", {}, "Court", el("span", { class: "court-no" }, String(c))),
          m && el("span", { class: "timer" }, el("span", { class: "live-dot", "aria-hidden": "true" }), ago(m.started_at))),
        m ? court(m.side_a.map((x) => chip(x)), m.side_b.map((x) => chip(x))) : court([], [], { freeText: "Free" }),
        canEdit() && (m ? el("button", { type: "button", class: "secondary", onclick: () => endMatchSheet(m) }, "End match")
          : s.next?.a.length && s.next?.b.length && el("button", { type: "button", onclick: (e) => startOn(c, e.target) }, "Start next match here"))));
    }

    // Up next: tap someone to swap or take them out; tap an empty spot to put someone in (1 or 2 a side).
    const sideOf = (side) => {
      const ids = s.next?.[side] || [];
      const chips = ids.map((x) => (canEdit() ? chip(x, { type: "button", "aria-label": `${person(x)?.name}: swap or take out`, onclick: () => nextSheet(x, s) }, "button", el("span", { class: "x", "aria-hidden": "true" }, "⇄"))
        : chip(x)));
      const slots = canEdit() ? Array.from({ length: 2 - ids.length }, () => el("button", { type: "button", class: "slot", onclick: () => slotSheet(side, s) }, "+ Add")) : [];
      return [...chips, ...slots];
    };
    sections.push(el("section", { class: "card upnext" },
      el("div", { class: "head" }, el("h2", {}, "Up next"), s.next?.manual && el("span", { class: "tag" }, "Changed by hand")),
      s.next || canEdit() ? court(sideOf("a"), sideOf("b"), { next: true }) : empty("Waiting for at least two players."),
      canEdit() && el("p", { class: "hint" }, "Tap a player to swap them, or an empty spot to add someone."),
      canEdit() && s.next?.manual && el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, () => save((st) => rot.repick(st, v.algorithm), "picked again")) }, "Pick again")));

    // The line
    const partner = (x) => s.pairs.find((p) => p.includes(x))?.find((y) => y !== x);
    const inNext = s.next ? [...s.next.a, ...s.next.b] : [];
    const row = (x, i) => {
      const tags = [s.away.includes(x) && "Break", s.skipped.includes(x) && "Skips next", partner(x) && `With ${person(partner(x))?.name}`,
        inNext.includes(x) && "Up next"].filter(Boolean);
      const inner = [el("span", { class: "line-no" }, String(i + 1)), el("span", { class: "who" }, face(person(x))),
        ...tags.map((t) => el("span", { class: "tag" }, t)), el("span", { class: "meta" }, `${s.games[x] || 0} played`)];
      return canEdit() ? el("button", { type: "button", class: `item${s.away.includes(x) ? " away" : ""}`, onclick: () => playerSheet(x, s) }, ...inner)
        : el("div", { class: `item${s.away.includes(x) ? " away" : ""}` }, ...inner);
    };
    sections.push(card(head("In line", role.runner && el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, addPlayersSheet) }, "Add")),
      s.order.length ? el("div", { class: "list" }, ...s.order.map(row)) : empty("Nobody waiting."),
      canEdit() && s.order.length > 0 && el("p", { class: "hint" }, "Tap someone to skip them, give them a break or pair them.")));

    sections.push(matchList(v.matches.filter((m) => m.ended_at).slice(-5).reverse(), "Last matches"));

    // Runners: the session's links and settings
    if (role.runner) {
      const watchLink = new URL(here(`w=${code}`), location.href).href;
      sections.push(card(head(v.club || "Pickup session"),
        el("p", { class: "muted" }, `${rot.ALGORITHMS.find((a) => a.id === v.algorithm)?.title || v.algorithm} rotation · started ${ago(v.started_at)}${minutes(v.started_at) >= 1 ? " ago" : ""}`),
        el("button", { type: "button", onclick: (e) => act(e.target, () => share(watchLink, "Who's playing")) }, "📺 Share live view"),
        el("div", { class: "row" },
          el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, helperSheet) }, "🙋 Helper QR"),
          el("button", { type: "button", class: "secondary", onclick: sessionSheet }, "⚙️ Settings")),
        el("button", { type: "button", class: "secondary", onclick: (e) => {
          if (confirm("End the session? Matches on court end too.")) act(e.target, async () => { await pb.endSession(v.id); await load(); });
        } }, "End session")));
    } else if (!role.helper) {
      sections.push(el("p", { class: "hint" }, `${v.club ? `${v.club} · ` : ""}updates by itself.`));
    }
    show(...sections);
  }

  if (!(await load())) return;
  if (!v.ended_at) setInterval(poll, 4000);
}
