// Pickleball (see shared/pickleball.js for the data, ./rotation.js for who plays next). One page, by its address:
//   ./                 the website's home: what this is, how it works, how to install it
//   ./?dash            the app's home (where the installed app opens): start a session, live and past sessions, clubs
//   ./?players         every player;  ./?club=<id>: a club's players and managers;  ./?new[=<club>]: start a session
//   ./?s=<id>          run a session: its managers and helpers (courts, up next, the line and its overrides)
//   ./?s=<id>&h=<code> become a helper with the session's helper code (the QR its manager shows)
//   ./?w=<code>        the live view: anyone with the link, read only (an ended session: its results)
//   ./?link=<code>     link your account to a player (the QR a manager shows)
//   ./?me              your games: your linked players, their numbers and sessions (accounts; the app home for non-managers)
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
const head = (title, ...right) => el("div", { class: "head" }, el("h2", {}, title), right.some(Boolean) && el("div", { class: "tools" }, ...right));
const empty = (text) => el("p", { class: "empty" }, text);
const face = (p) => `${p?.icon || "👤"} ${p?.name || "?"}`;
// A session's title: its name, else its club's, else "Pickup session".
const sessionTitle = (name, club) => name || club || "Pickup session";
// Guests (made for one session) stay out of the player lists and pickers until kept.
const regular = (players) => players.filter((p) => !p.guest);
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
  form.append(el("h2", {}, title), ...fill(close).flat().filter(Boolean));
  sheet.replaceChildren(form);
  if (!sheet.open) sheet.showModal();
}
// Tapping outside the sheet (its backdrop) closes it.
sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });
// A row of options in a sheet: icon over a short label.
const action = (icon, label, onclick, attrs = {}) => el("button", { type: "button", class: "secondary", onclick, ...attrs },
  el("span", { class: "ic", "aria-hidden": "true" }, icon), label);
const actions = (...buttons) => el("div", { class: "actions" }, ...buttons);
// Picks someone from a list, in the same sheet.
function choose(title, ids, label, onPick) {
  openSheet(title, (close) => [ids.length
    ? el("div", { class: "list" }, ...ids.map((x) => el("button", { type: "button", class: "item", onclick: (e) => act(e.target, async () => { close(); await onPick(x); }) },
      el("span", { class: "who" }, label(x)))))
    : empty("Nobody to pick.")]);
}

// ---------- start ----------
let me;
(async () => {
  try {
    me = await pb.me();
    if (params.has("w")) await watchView(params.get("w"));
    else if (params.has("s") && params.has("h")) await joinAsHelper(params.get("s"), params.get("h"));
    else if (params.has("s")) await sessionView(params.get("s"));
    else if (params.has("link")) await linkView(params.get("link"));
    else if (["dash", "club", "new", "players", "me"].some((k) => params.has(k))) {
      setBack(installed ? "" : here(), "About Pickleball");
      if (installed && params.has("dash")) $("back").hidden = true;
      if (params.has("me") || (params.has("dash") && !me.manager && me.account)) await myView();
      else if (!me.manager) notManager();
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
  const open = me.account ? el("a", { class: "button", href: here("dash") }, "Open Pickleball")
    : el("a", { class: "button", href: "../profile/" }, "Sign in");
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
  );
}

function notManager() {
  show(card(el("h2", {}, "Managers only"),
    el("p", {}, me.account ? "Only pickleball managers run sessions. Ask an admin for the manager role."
      : "Only pickleball managers run sessions, signed in to their account. Players just open the live link they're given."),
    !me.account && el("a", { class: "button", href: "../profile/" }, "Sign in"),
    el("a", { class: "button secondary", href: here() }, "About Pickleball")));
}

// ---------- players with an account ----------
// The QR a manager shows: link this account to that player.
async function linkView(code) {
  $("back").hidden = !me.account;
  setBack(here("me"), "My games");
  if (!me.account) {
    show(el("section", { class: "card hero" }, el("img", { src: "./icons/icon-192.png", alt: "" }), el("h2", {}, "Is this you?"),
      el("p", {}, "Sign in to your account, then open this link again to see your games."),
      el("a", { class: "button", href: "../profile/" }, "Sign in")));
    return;
  }
  show(el("section", { class: "card hero" }, el("img", { src: "./icons/icon-192.png", alt: "" }), el("h2", {}, "Is this you?"),
    el("p", {}, `Link this player to @${me.account.username} to see your matches and numbers.`),
    el("button", { type: "button", class: "big-start", onclick: (e) => act(e.target, async () => {
      const p = await pb.linkPlayer(code);
      location.replace(here(`me&linked=${encodeURIComponent(p.name)}`));
    }) }, "🔗 Link my account")));
}

// Your games: your linked players (you, in each club), their numbers, the sessions they played in.
async function myView() {
  if (me.manager) setBack(here("dash"), "Pickleball home");
  if (!me.account) { notManager(); return; }
  if (params.has("linked")) note(`Linked: ${params.get("linked")}.`);
  const games = await pb.myGames();
  const sum = (k) => games.players.reduce((n, p) => n + (p[k] || 0), 0);
  const hours = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`);
  stats(games.players.length ? [[sum("matches"), "matches"], [sum("wins"), "wins"], [hours(sum("minutes")), "played"]] : null);
  const codeInput = el("input", { class: "code-in", placeholder: "XXXX-XXXX-XXXX-XXXX", maxlength: 19, autocapitalize: "characters", "aria-label": "Link code" });
  const player = (p) => el("div", { class: "me-player" },
    el("div", { class: "me-head" }, el("span", { class: "me-icon", "aria-hidden": "true" }, p.icon || "👤"), el("b", { class: "who" }, p.name),
      el("button", { type: "button", class: "icon-btn", "aria-label": `Unlink ${p.name}`, onclick: (e) => {
        if (confirm(`Unlink ${p.name} from your account?`)) act(e.target, async () => { await pb.unlinkPlayer(p.id); await myView(); });
      } }, "✕")),
    el("div", { class: "me-nums" },
      ...[[p.sessions, "sessions"], [p.matches, "matches"], [p.wins, "wins"], [p.matches ? `${Math.round((100 * p.wins) / p.matches)}%` : "–", "won"]]
        .map(([n, label]) => el("span", {}, el("b", {}, String(n)), label))));
  show(
    games.players.length ? card(head("You play as"), ...games.players.map(player))
      : el("section", { class: "card hero" }, el("img", { src: "./icons/icon-192.png", alt: "" }), el("h2", {}, "Your games"),
        el("p", {}, me.manager ? "Link your account to your player to see your own matches." : "Ask a manager for your link QR to see your matches here.")),
    games.sessions.length > 0 && card(head("Sessions"), el("div", { class: "list" }, ...games.sessions.map((x) => el("a", { class: "item", href: here(`w=${x.watch_code}`) },
      el("span", { class: "who" }, !x.ended_at && el("span", { class: "live-dot", "aria-hidden": "true" }), sessionTitle(x.name, x.club)),
      el("span", { class: "meta" }, `${x.matches} match${x.matches === 1 ? "" : "es"} · ${day(x.started_at)}`))))),
    card(head("Have a code?"), el("div", { class: "form" }, codeInput, el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, async () => {
      const p = await pb.linkPlayer(codeInput.value);
      note(`Linked: ${p.name}.`);
      await myView();
    }) }, "Link"))));
}

// ---------- the app's home (managers) ----------
const runs = (s, clubs) => s.started_by === me.id || !!clubs.find((c) => c.id === s.club_id)?.managers.includes(me.id);

async function dashboard() {
  const [sessions, past, clubs, allPlayers] = await Promise.all([pb.sessions(), pb.pastSessions(), pb.clubs(), pb.players()]);
  const players = regular(allPlayers);
  const clubName = (id) => clubs.find((c) => c.id === id)?.name || null;
  const mine = sessions.filter((s) => runs(s, clubs));
  const clubInput = el("input", { placeholder: "Club name", maxlength: 40, "aria-label": "New club's name" });
  stats([[mine.length, mine.length === 1 ? "live session" : "live sessions"], [clubs.length, clubs.length === 1 ? "club" : "clubs"], [players.length, players.length === 1 ? "player" : "players"]]);

  show(
    el("a", { class: "button big-start", href: here("new") }, "🏓 Start a session"),
    mine.length > 0 && card(head("Live now"),
      el("div", { class: "list" }, ...mine.map((s) => el("a", { class: "item", href: here(`s=${s.id}`) },
        el("span", { class: "who" }, el("span", { class: "live-dot", "aria-hidden": "true" }), sessionTitle(s.name, clubName(s.club_id))),
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
        el("span", { class: "who" }, sessionTitle(s.name, clubName(s.club_id))), el("span", { class: "meta" }, day(s.started_at)))))
        : empty("Finished sessions and their results show up here.")),
    el("div", { class: "row" },
      el("a", { class: "button secondary", href: here("players") }, `👥 All players (${players.length})`),
      el("a", { class: "button secondary", href: here("me") }, "🏅 My games")));
}

// A player in a list, with Edit (and whatever else `extra` adds).
// Who each player is linked to (pb.links(), by player id), for the player rows; loaded by the views that show them.
let linked = {};
const loadLinks = async () => { linked = Object.fromEntries((await pb.links()).map((l) => [l.player_id, l])); };
function playerRow(p, done, ...extra) {
  const link = linked[p.id];
  const edit = el("button", { type: "button", class: "icon-btn", "aria-label": `Edit ${p.name}`, onclick: () => openSheet(`Edit ${p.name}`, (close) => {
    const name = el("input", { value: p.name, maxlength: 24, "aria-label": "Name" });
    const icon = el("input", { class: "emoji", value: p.icon, maxlength: 8, "aria-label": "Icon (an emoji)" });
    return [el("div", { class: "form" }, icon, name),
      el("button", { type: "button", onclick: (e) => act(e.target, async () => { await pb.editPlayer(p.id, name.value, icon.value); close(); await done(); }) }, "Save"),
      link ? el("div", { class: "item" }, el("span", { class: "who" }, `🔗 ${link.avatar || "👤"} @${link.username}`),
        el("button", { type: "button", class: "secondary", onclick: (e) => {
          if (confirm(`Unlink ${p.name} from @${link.username}?`)) act(e.target, async () => { await pb.unlinkPlayer(p.id); close(); await done(); });
        } }, "Unlink"))
        : el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, () => linkSheet(p)) }, "🔗 Link an account")];
  }) }, "✏️");
  return el("div", { class: "item" }, el("span", { class: "who" }, face(p)),
    link && el("span", { class: "tag", title: `Linked to @${link.username}` }, "🔗"), ...extra, edit);
}
// A QR code of a link, as an SVG (only its dark squares), or nothing if it can't be made.
async function qrBox(url, label) {
  const box = el("div", { class: "qr" });
  try {
    const { qrcode } = await import("../../shared/qrcode.js");
    const qr = qrcode(0, "M"); qr.addData(url); qr.make();
    const n = qr.getModuleCount(), q = 4;
    let d = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + q} ${y + q}h1v1h-1z`;
    box.innerHTML = `<svg viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" role="img" aria-label="${label}"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
  } catch {}
  return box;
}
async function shareLink(url, title) {
  if (navigator.share) { try { await navigator.share({ title, url }); return; } catch (err) { if (err?.name === "AbortError") return; } }
  await navigator.clipboard.writeText(url);
  note("Link copied.");
}
// A one-time code (and QR) that links someone's account to this player.
async function linkSheet(p) {
  const code = await pb.linkCode(p.id);
  const url = new URL(here(`link=${code.replace(/-/g, "")}`), location.href).href;
  const box = await qrBox(url, `QR code: scan to link your account to ${p.name}`);
  openSheet(`Link ${face(p)}`, () => [el("p", { class: "muted" }, "Scan with the account to link. Works once, for 7 days."), box,
    el("p", { class: "bigcode" }, code),
    el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, () => shareLink(url, `You on Pickleball: ${p.name}`)) }, "Share link")]);
}
const newPlayerForm = (label, onAdd, guest = false) => {
  const name = el("input", { placeholder: "Name", maxlength: 24, "aria-label": `${label}'s name` });
  const icon = el("input", { class: "emoji", placeholder: "👤", maxlength: 8, "aria-label": `${label}'s icon (an emoji)` });
  return el("div", { class: "form" }, icon, name, el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, async () => {
    const id = await pb.makePlayer(name.value, icon.value, guest);
    await onAdd(id, { id, name: name.value.trim(), icon: icon.value.trim() || "👤", guest });
    name.value = ""; icon.value = "";
  }) }, "Add"));
};

async function playersView() {
  setBack(here("dash"), "Pickleball home");
  const [all] = await Promise.all([pb.players(), loadLinks()]);
  const players = regular(all);
  show(card(head(`Players (${players.length})`),
    players.length ? el("div", { class: "list" }, ...players.map((p) => playerRow(p, playersView))) : empty("No players yet."),
    newPlayerForm("New player", () => playersView())));
}

// ---------- a club ----------
async function clubView(id) {
  setBack(here("dash"), "Pickleball home");
  const [clubs, players, managers] = await Promise.all([pb.clubs(), pb.players(), pb.managers(), loadLinks()]);
  const club = clubs.find((c) => c.id === id);
  if (!club) { show(card(empty("There's no such club."))); return; }
  const mine = club.managers.includes(me.id);
  const reload = () => clubView(id);
  const members = players.filter((p) => club.players.includes(p.id));
  const others = regular(players).filter((p) => !club.players.includes(p.id));
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
      }) }, "Add"))));
}

// ---------- start a session ----------
async function newSession(clubId) {
  setBack(clubId ? here(`club=${clubId}`) : here("dash"), clubId ? "Club" : "Pickleball home");
  const [clubs, all] = await Promise.all([pb.clubs(), pb.players()]);
  const players = regular(all);
  const mine = clubs.filter((c) => c.managers.includes(me.id));
  let club = mine.find((c) => c.id === clubId) || null;
  let courts = 2, algorithm = "fair";
  const nameInput = el("input", { placeholder: "Optional", maxlength: 40, "aria-label": "Session name" });
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
      el("label", { class: "field" }, "Name", nameInput),
      el("label", { class: "field" }, "Club", clubSelect),
      el("label", { class: "field" }, "Courts", courtSelect),
      algoSeg, algoHint),
    card(count, list, el("p", { class: "muted" }, "Guests"),
      newPlayerForm("Guest", async (id, p) => { players.push(p); guests.push(id); chosen.add(id); drawPlayers(); }, true)),
    el("button", { type: "button", class: "big-start", onclick: (e) => act(e.target, async () => {
      const id = await pb.startSession({ club: club?.id || null, courts, algorithm, players: [...chosen], name: nameInput.value });
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
  let watchCode = null, runner = false, clubId = null;
  if (me.manager) {
    const [sessions, clubs] = await Promise.all([pb.sessions(), pb.clubs()]);
    const s = sessions.find((x) => x.id === id);
    if (s && runs(s, clubs)) { watchCode = s.watch_code; runner = true; clubId = s.club_id; }
  }
  watchCode ||= store.get(helperKey(id));
  if (!watchCode) {
    show(card(el("h2", {}, "Helping out?"), el("p", {}, "Scan the helper QR on the manager's phone to run the courts and the line.")));
    return;
  }
  await live(watchCode, { runner, helper: true, clubId });
}

async function watchView(code) {
  if (me?.manager) setBack(here("dash"), "Pickleball home");
  else $("back").hidden = true; // the public live view: nowhere to go back to
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
      return [el("p", { class: "muted" }, "Who won?"), seg,
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
  // Managers, from the Players list: link an account to a player (or see and undo it), and keep a guest (made for
  // this session) as a regular player, in the session's club if it has one.
  function manageSheet(p) {
    const link = linked[p.id];
    openSheet(face(p), (close) => [
      link ? el("div", { class: "item" }, el("span", { class: "who" }, `🔗 ${link.avatar || "👤"} @${link.username}`),
        el("button", { type: "button", class: "secondary", onclick: (e) => {
          if (confirm(`Unlink ${p.name} from @${link.username}?`)) act(e.target, async () => { await pb.unlinkPlayer(p.id); close(); await loadLinks(); draw(); });
        } }, "Unlink")) : null,
      actions(
        !link && action("🔗", "Link account", (e) => act(e.target, () => linkSheet(p))),
        p.guest && action("⭐", role.clubId ? "Add to club" : "Keep", (e) => act(e.target, async () => {
          close();
          if (role.clubId) await pb.addClubPlayer(role.clubId, p.id); else await pb.keepPlayer(p.id);
          note(`${p.name} is a regular player now.`);
          await load();
        })))]);
  }

  // Someone in line: skip, break, pair, leave.
  function playerSheet(pid, s) {
    const p = person(pid);
    const partner = s.pairs.find((x) => x.includes(pid))?.find((x) => x !== pid);
    const away = s.away.includes(pid);
    const others = s.order.filter((x) => x !== pid);
    openSheet(face(p), (close) => {
      const run = (fn, what) => (e) => act(e.target, async () => { close(); await save(fn, what, { player: pid }); });
      return [actions(
        !away && action("⏭", "Skip", run((st) => rot.skip(st, v.algorithm, pid), "skipped")),
        action(away ? "▶️" : "☕", away ? "Back" : "Break", run((st) => rot.setAway(st, v.algorithm, pid, !away), away ? "back" : "on a break")),
        partner ? action("🔗", "Unpair", run((st) => rot.unpair(st, v.algorithm, pid), "unpaired"))
          : others.length > 0 && action("🔗", "Pair", () => choose(`${p.name} plays with`, others, (x) => face(person(x)),
            (x) => save((st) => rot.pair(st, v.algorithm, pid, x), "paired", { player: pid, with: x }))),
        role.runner && action("👋", "Leave", (e) => {
          if (!confirm(`${p.name} leaves the session?`)) return;
          act(e.target, async () => { close(); busy = true; try { await pb.setHere(v.id, pid, false); await load(); } finally { busy = false; } });
        }))];
    });
  }
  // Someone up next: swap, skip, break, or leave their spot empty.
  function nextSheet(pid, s) {
    const inNext = [...s.next.a, ...s.next.b];
    const choices = [...s.order.filter((x) => !inNext.includes(x) && !s.away.includes(x)), ...inNext.filter((x) => x !== pid)];
    const p = person(pid);
    openSheet(face(p), (close) => {
      const run = (fn, what) => (e) => act(e.target, async () => { close(); await save(fn, what, { player: pid }); });
      return [actions(
        choices.length > 0 && action("⇄", "Swap", () => choose(`Instead of ${p.name}`, choices, (x) => face(person(x)),
          (x) => save((st) => rot.swap(st, v.algorithm, pid, x), "swapped", { out: pid, in: x }))),
        action("⏭", "Skip", run((st) => rot.skip(st, v.algorithm, pid), "skipped")),
        action("☕", "Break", run((st) => rot.setAway(st, v.algorithm, pid, true), "on a break")),
        action("✕", "Remove", run((st) => rot.removeFromNext(st, v.algorithm, pid), "took out")))];
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
      const name = el("input", { value: v.name || "", placeholder: v.club || "Optional", maxlength: 40, "aria-label": "Session name" });
      return [el("label", { class: "field" }, "Name", name), el("label", { class: "field" }, "Courts", courts), seg,
        el("button", { type: "button", onclick: (e) => act(e.target, async () => {
          if (name.value.trim() !== (v.name || "")) await pb.renameSession(v.id, name.value);
          if (Number(courts.value) !== v.courts || algorithm !== v.algorithm) await pb.setSession(v.id, Number(courts.value), algorithm);
          close(); await load();
        }) }, "Save")];
    });
  }
  async function addPlayersSheet() {
    const all = await pb.players();
    const ids = new Set(v.players.filter((p) => p.here).map((p) => p.id));
    const rest = regular(all).filter((p) => !ids.has(p.id));
    const add = (pid) => act(null, async () => { busy = true; try { await pb.setHere(v.id, pid, true); await load(); } finally { busy = false; } });
    openSheet("Add players", (close) => [rest.length > 0 && el("div", { class: "list" }, ...rest.map((p) => el("button", { type: "button", class: "item", onclick: () => { close(); add(p.id); } },
      el("span", { class: "who" }, face(p)), el("span", { class: "meta" }, "Add")))),
    el("p", { class: "muted" }, "Or a guest:"),
    newPlayerForm("Guest", async (pid) => { close(); await add(pid); }, true)]);
  }
  async function helperSheet() {
    const code = await pb.helperCode(v.id);
    const link = new URL(here(`s=${v.id}&h=${code.replace(/-/g, "")}`), location.href).href;
    const box = await qrBox(link, "QR code: scan to help run this session");
    openSheet("Helper QR", () => [
      el("p", { class: "muted" }, "Scan to help run the courts."), box,
      el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, () => share(link, "Help run the courts")) }, "Share link")]);
  }
  async function share(url, title) {
    if (navigator.share) { try { await navigator.share({ title, url }); return; } catch (err) { if (err?.name === "AbortError") return; } }
    await navigator.clipboard.writeText(url);
    note("Link copied.");
  }

  // A court: two halves, players (or slots) on each.
  function court(left, right, { next = false, freeText = null, court: number = null } = {}) {
    const drop = (side) => (next && canEdit() ? { "data-drop": "side", "data-side": side } : {});
    // The next match drags as a whole (held anywhere but on a player) onto a free court, to start it there.
    const whole = next && canEdit() && state().next?.a.length && state().next?.b.length ? { "data-drag": "match" } : {};
    const free = number && canEdit() ? { "data-drop": "court", "data-court": number } : {};
    return el("div", { class: `court${next ? " next" : ""}`, ...whole, ...free },
      el("div", { class: "half a", ...drop("a") }, ...left), el("div", { class: "net", "aria-hidden": "true" }), el("div", { class: "half b", ...drop("b") }, ...right),
      freeText && el("div", { class: "free" }, el("span", {}, freeText)),
      whole["data-drag"] && el("span", { class: "court-grip", "aria-hidden": "true" }, "⠿"));
  }

  // Hold and drag (managers and helpers): hold someone for a moment, then drag them onto a spot in the next match
  // (or onto someone there: they swap), onto someone in line (they go before them), to the end of the line or to a
  // break. A short tap still opens their options; moving straight away still scrolls.
  let drag = null, pending = null, swallowClick = false;
  const dropAt = (x, y) => document.elementFromPoint(x, y)?.closest("[data-drop]") || null;
  function endPending() { if (pending) clearTimeout(pending.timer); pending = null; }
  view.addEventListener("pointerdown", (e) => {
    const src = e.target.closest("[data-drag]");
    if (!src || !canEdit() || e.button > 0 || busy) return;
    endPending();
    pending = { src, x: e.clientX, y: e.clientY, timer: setTimeout(() => {
      const { src: from, x, y } = pending;
      pending = null;
      const box = from.getBoundingClientRect();
      const ghost = from.cloneNode(true);
      ghost.classList.add("ghost");
      Object.assign(ghost.style, { width: `${box.width}px`, left: `${box.left}px`, top: `${box.top}px` });
      document.body.append(ghost);
      from.classList.add("lifted");
      document.body.classList.add(from.dataset.drag === "match" ? "dragging-match" : "dragging");
      drag = { pid: from.dataset.drag, from, ghost, dx: x - box.left, dy: y - box.top, over: null };
      busy = true;
      navigator.vibrate?.(15);
    }, 300) };
  });
  addEventListener("pointermove", (e) => {
    if (pending && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > 8) endPending();
    if (!drag) return;
    drag.ghost.style.left = `${e.clientX - drag.dx}px`;
    drag.ghost.style.top = `${e.clientY - drag.dy}px`;
    const over = dropAt(e.clientX, e.clientY);
    if (over !== drag.over) { drag.over?.classList.remove("over"); over?.classList.add("over"); drag.over = over; }
  });
  // Once dragging, the page doesn't scroll under the finger.
  document.addEventListener("touchmove", (e) => { if (drag) e.preventDefault(); }, { passive: false });
  document.addEventListener("contextmenu", (e) => { if (drag || pending) e.preventDefault(); });
  async function finishDrag(e) {
    endPending();
    if (!drag) return;
    const { pid, from, ghost, over } = drag;
    drag = null;
    ghost.remove();
    from.classList.remove("lifted");
    over?.classList.remove("over");
    document.body.classList.remove("dragging", "dragging-match");
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 400);
    busy = false;
    const target = e.type === "pointercancel" ? null : over;
    if (!target) return;
    const kind = target.dataset.drop, other = target.dataset.pid, side = target.dataset.side;
    if (pid === "match") { if (kind === "court") await startOn(Number(target.dataset.court), null); return; }
    if (kind === "court") return;
    const s = state();
    const inNext = (x) => !!s.next && [...s.next.a, ...s.next.b].includes(x);
    let change = null;
    if (kind === "chip" && other !== pid) change = (st) => rot.swap(st, v.algorithm, pid, other);
    else if (kind === "side") change = (st) => rot.addToNext(st, v.algorithm, side, pid);
    else if (kind === "row" && other !== pid) {
      if (s.away.includes(other)) change = (st) => rot.setAway(st, v.algorithm, pid, true);
      else if (inNext(pid)) change = (st) => rot.swap(st, v.algorithm, pid, other);
      else change = (st) => rot.moveInLine(st, v.algorithm, pid, other);
    } else if (kind === "end") change = (st) => rot.moveInLine(inNext(pid) ? rot.removeFromNext(st, v.algorithm, pid) : st, v.algorithm, pid, null);
    else if (kind === "break") change = (st) => rot.setAway(st, v.algorithm, pid, true);
    if (change) await act(null, () => save(change, "moved", { player: pid, to: kind }));
  }
  addEventListener("pointerup", finishDrag);
  addEventListener("pointercancel", finishDrag);
  view.addEventListener("click", (e) => { if (swallowClick) { e.stopPropagation(); e.preventDefault(); swallowClick = false; } }, true);

  // Everyone in the session with their numbers so far (most wins first); managers manage each (⋯: link, keep).
  function tallies() {
    const tally = Object.fromEntries(v.players.map((p) => [p.id, { played: 0, won: 0 }]));
    for (const m of v.matches.filter((x) => x.ended_at)) {
      for (const [side, ids] of [["a", m.side_a], ["b", m.side_b]]) {
        for (const x of ids) {
          const t = (tally[x] ||= { played: 0, won: 0 });
          t.played++;
          if (m.score_a != null && m.score_a !== m.score_b && (side === "a") === (m.score_a > m.score_b)) t.won++;
        }
      }
    }
    return tally;
  }
  function playersCard(title, onlyPlayed = false) {
    const tally = tallies();
    const rows = Object.entries(tally).filter(([x, t]) => person(x) && (!onlyPlayed || t.played))
      .sort(([a, x], [b, y]) => y.won - x.won || y.played - x.played || person(a).name.localeCompare(person(b).name));
    if (!rows.length) return null;
    return card(head(title),
      el("table", { class: "board" },
        el("thead", {}, el("tr", {}, el("th", {}, "Player"), el("th", {}, "Played"), el("th", {}, "Won"), me.manager && el("th", {}, el("span", { class: "sr-only" }, "Manage")))),
        el("tbody", {}, ...rows.map(([x, t]) => {
          const p = person(x);
          return el("tr", { class: p.here === false ? "left" : null },
            el("td", {}, face(p), p.guest && el("span", { class: "tag" }, "Guest"), linked[x] && el("span", { class: "tag", title: `Linked to @${linked[x].username}` }, "🔗")),
            el("td", {}, String(t.played)), el("td", {}, String(t.won)),
            me.manager && el("td", {}, el("button", { type: "button", class: "icon-btn", "aria-label": `Manage ${p.name}`, onclick: () => manageSheet(p) }, "⋯")));
        }))));
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
      card(head(sessionTitle(v.name, v.club)), el("p", { class: "muted" }, `${v.name && v.club ? `${v.club} · ` : ""}${day(v.started_at)} · ${rot.ALGORITHMS.find((a) => a.id === v.algorithm)?.title || ""} rotation · ${v.courts} court${v.courts > 1 ? "s" : ""}`)),
      playersCard("🏆 Results", true),
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
    const sections = [el("h2", { class: "session-title" }, sessionTitle(v.name, v.club))];

    // Courts
    for (let c = 1; c <= v.courts; c++) {
      const m = open().find((x) => x.court === c);
      sections.push(card(
        el("div", { class: "court-head" }, el("h2", {}, "Court", el("span", { class: "court-no" }, String(c))),
          m && el("span", { class: "timer" }, el("span", { class: "live-dot", "aria-hidden": "true" }), ago(m.started_at))),
        m ? court(m.side_a.map((x) => chip(x)), m.side_b.map((x) => chip(x))) : court([], [], { freeText: "Free", court: c }),
        canEdit() && (m ? el("button", { type: "button", class: "secondary", onclick: () => endMatchSheet(m) }, "End match")
          : s.next?.a.length && s.next?.b.length && el("button", { type: "button", onclick: (e) => startOn(c, e.target) }, "Start next match here"))));
    }

    // The queue: the next match (on a dashed court: tap a player for options, an empty spot to add someone), then
    // everyone else waiting in order, then whoever's on a break (☕) at the bottom. ⋯ opens a person's options.
    const sideOf = (side) => {
      const ids = s.next?.[side] || [];
      const chips = ids.map((x) => (canEdit() ? chip(x, { type: "button", "aria-label": `Options for ${person(x)?.name}`, onclick: () => nextSheet(x, s),
        "data-drag": x, "data-drop": "chip", "data-pid": x }, "button", el("span", { class: "x", "aria-hidden": "true" }, "⋯"))
        : chip(x)));
      const slots = canEdit() ? Array.from({ length: 2 - ids.length }, () => el("button", { type: "button", class: "slot", "aria-label": "Add a player here", onclick: () => slotSheet(side, s), "data-drop": "side", "data-side": side }, "+")) : [];
      return [...chips, ...slots];
    };
    const partner = (x) => s.pairs.find((p) => p.includes(x))?.find((y) => y !== x);
    const inNext = s.next ? [...s.next.a, ...s.next.b] : [];
    const waitingList = s.order.filter((x) => !inNext.includes(x) && !s.away.includes(x));
    const onBreak = s.order.filter((x) => s.away.includes(x));
    const row = (x, mark) => el("div", { class: `item${s.away.includes(x) ? " away" : ""}`, ...(canEdit() ? { "data-drag": x, "data-drop": "row", "data-pid": x } : {}) },
      canEdit() && el("span", { class: "grip", "aria-hidden": "true" }, "⠿"),
      el("span", { class: "line-no", "aria-label": s.away.includes(x) ? "On a break" : `Number ${mark}` }, String(mark)),
      el("span", { class: "who" }, face(person(x))),
      partner(x) && el("span", { class: "tag", title: `Plays with ${person(partner(x))?.name}` }, `🔗 ${person(partner(x))?.icon || "👤"}`),
      s.skipped.includes(x) && el("span", { class: "tag", title: "Skips the next match" }, "⏭"),
      person(x)?.guest && el("span", { class: "tag", title: "Guest: this session only" }, "Guest"),
      el("span", { class: "meta", title: "Matches played" }, `🏓 ${s.games[x] || 0}`),
      canEdit() && el("button", { type: "button", class: "icon-btn", "aria-label": `Options for ${person(x)?.name}`, onclick: () => playerSheet(x, s) }, "⋯"));
    sections.push(el("section", { class: "card upnext" },
      head("Queue",
        canEdit() && s.next?.manual && el("button", { type: "button", class: "icon-btn", "aria-label": "Pick the next match again", onclick: (e) => act(e.target, () => save((st) => rot.repick(st, v.algorithm), "picked again")) }, "↻"),
        role.runner && el("button", { type: "button", class: "icon-btn", "aria-label": "Add players", onclick: (e) => act(e.target, addPlayersSheet) }, "+")),
      (s.next || canEdit()) && court(sideOf("a"), sideOf("b"), { next: true }),
      waitingList.length || onBreak.length ? el("div", { class: "list" }, ...waitingList.map((x, i) => row(x, i + 1)), ...onBreak.map((x) => row(x, "☕")))
        : !s.next && empty("Nobody waiting."),
      canEdit() && el("div", { class: "dropzones" },
        el("div", { class: "dropzone", "data-drop": "end" }, "⤵ End of line"),
        el("div", { class: "dropzone", "data-drop": "break" }, "☕ Break"))));

    sections.push(matchList(v.matches.filter((m) => m.ended_at).slice(-5).reverse(), "Last matches"));

    // Runners: the session's links and settings
    if (role.runner) {
      const watchLink = new URL(here(`w=${code}`), location.href).href;
      sections.push(card(head("Session"),
        el("p", { class: "muted" }, `${rot.ALGORITHMS.find((a) => a.id === v.algorithm)?.title || v.algorithm} rotation · started ${ago(v.started_at)}${minutes(v.started_at) >= 1 ? " ago" : ""}`),
        el("button", { type: "button", onclick: (e) => act(e.target, () => share(watchLink, "Who's playing")) }, "📺 Share live view"),
        el("div", { class: "row" },
          el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, helperSheet) }, "🙋 Helper QR"),
          el("button", { type: "button", class: "secondary", onclick: sessionSheet }, "⚙️ Settings")),
        el("button", { type: "button", class: "secondary", onclick: (e) => {
          if (confirm("End the session? Matches on court end too.")) act(e.target, async () => { await pb.endSession(v.id); await load(); });
        } }, "End session")));
    }
    sections.push(playersCard("Players"));
    show(...sections);
  }

  if (me.manager) await loadLinks().catch(() => {});
  if (!(await load())) return;
  if (!v.ended_at) setInterval(poll, 4000);
}
