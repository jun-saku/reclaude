// Trip (see shared/trip.js for the data, apps/_trip-plan.md for the plan). One page, by its address:
//   ./                  your trips (and making one, with an account); what Trip is, for everyone else
//   ./?new              make a trip (accounts)
//   ./?t=<code>         the join link: who are you? (no account needed)
//   ./?id=<trip>        the trip's page: its sections (notes, itinerary…), added and changed by everyone on it
//   ./?id=<trip>&people the people on it and the join link (planners add, rename, free and remove names)
//   ./?id=<trip>&edit   the trip's details, archiving (planners)
//   ./?id=<trip>&log    every change (planners)
import * as tr from "../../shared/trip.js";
import { CoreError, localProfile } from "../../shared/core.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const keep = params.get("backend") === "fake" ? "&backend=fake" : ""; // (the UI tests' stand-in stays on)
const here = (query = "") => `./?${query}${keep}`.replace("?&", "?").replace(/\?$/, "");
const view = $("view");
const show = (...kids) => view.replaceChildren(...kids.flat().filter(Boolean));
const HANDOVERS = "trip-handovers"; // hand-over codes waiting for this device to sign in to its account

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (["hidden", "disabled", "checked", "selected", "open"].includes(k)) e[k] = !!v;
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
async function act(button, fn) {
  if (button) button.disabled = true;
  showError(null);
  try { await fn(); } catch (err) { showError(err); }
  if (button) button.disabled = false;
}
const card = (...kids) => el("section", { class: "card" }, ...kids);
const head = (title, ...right) => el("div", { class: "head" }, el("h2", {}, title), right.some(Boolean) && el("div", { class: "tools" }, ...right));
const empty = (text) => el("p", { class: "empty" }, text);
const field = (label, input) => el("label", { class: "field" }, el("span", {}, label), input);
const input = (attrs) => el("input", { autocomplete: "off", ...attrs });
const face = (p) => `${p?.icon || "👤"} ${p?.name || "Someone"}`;
function setBack(href, label) { $("back").href = href; $("back").setAttribute("aria-label", label); }
const local = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

// Dates: "Tue 1 Dec"; a trip's: "1–6 Dec 2026".
const asDate = (d) => new Date(`${d}T00:00:00`);
const day = (d) => asDate(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
function dates(from, to) {
  if (!from && !to) return "";
  if (!to || from === to) return asDate(from || to).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  if (!from) return `until ${asDate(to).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
  const a = asDate(from), b = asDate(to);
  const sameYear = a.getFullYear() === b.getFullYear();
  return `${a.toLocaleDateString(undefined, { day: "numeric", month: "short", year: sameYear ? undefined : "numeric" })} – ${
    b.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}
const money = (n, cur) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(n); }
  catch { return `${cur} ${n}`; }
};
const hhmm = (t) => (t ? t.slice(0, 5) : "");
const mapsLink = (place) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;

// The sheet: a dialog built by fill(close).
const sheet = $("sheet");
let sheetOpen = false;
function openSheet(title, fill) {
  const form = el("form", { method: "dialog" });
  const close = () => sheet.close();
  form.append(el("h2", {}, title), ...fill(close).flat().filter(Boolean));
  sheet.replaceChildren(form);
  if (!sheet.open) sheet.showModal();
  sheetOpen = true;
}
sheet.addEventListener("close", () => { sheetOpen = false; });
sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });
const action = (icon, label, onclick, attrs = {}) => el("button", { type: "button", class: "secondary", onclick, ...attrs },
  el("span", { class: "ic", "aria-hidden": "true" }, icon), label);
const actions = (...buttons) => el("div", { class: "actions" }, ...buttons.filter(Boolean));

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

// ---------- start ----------
let me;
(async () => {
  try {
    me = await tr.me();
    if (me.account) await takeOverPending();
    if (params.has("t")) await joinView(params.get("t"));
    else if (params.has("id")) {
      const id = params.get("id");
      if (params.has("people")) await peopleView(id);
      else if (params.has("edit")) await editView(id);
      else if (params.has("log")) await logView(id);
      else await tripView(id);
    } else if (params.has("new")) newView();
    else await homeView();
  } catch (err) {
    show(card(empty("Can't load this right now.")));
    showError(err);
  }
})();

// Signed in to an account now: link it to the names this device had (hand-over codes kept before signing in).
async function takeOverPending() {
  const codes = local.get(HANDOVERS, []);
  if (!codes.length) return;
  local.set(HANDOVERS, []);
  for (const code of codes) { try { await tr.takeOver(code); } catch {} }
}

// ---------- home ----------
async function homeView() {
  const trips = await tr.myTrips();
  if (trips.length) local.set("trip-joined", true);
  const today = new Date().toISOString().slice(0, 10);
  const past = (t) => t.archived || (t.ends_on && t.ends_on < today);
  const row = (t) => el("a", { class: "item", href: here(`id=${t.id}`) },
    el("span", { class: "who" }, `${t.emoji} ${t.title}`),
    el("span", { class: "meta" }, t.planner ? "Planner" : dates(t.starts_on, t.ends_on) || ""));
  const upcoming = trips.filter((t) => !past(t)), done = trips.filter(past);
  show(
    !trips.length && el("section", { class: "card hero" },
      el("span", { class: "big", "aria-hidden": "true" }, "🧳"),
      el("h2", {}, "Plan a trip together"),
      el("p", {}, "One page for your group's trip: notes, the itinerary and more. Friends join with a link and pick their name: no accounts needed."),
      me.account ? el("a", { class: "button", href: here("new") }, "Make a trip")
        : el("a", { class: "button", href: "../profile/" }, "Sign in to make a trip")),
    trips.length > 0 && card(head("Your trips", me.account && el("a", { class: "button", href: here("new") }, "＋ New")),
      upcoming.length ? el("div", { class: "list" }, ...upcoming.map(row)) : empty("Nothing coming up.")),
    done.length > 0 && card(el("h2", {}, "Past trips"), el("div", { class: "list" }, ...done.map(row))),
    !trips.length && card(el("h2", {}, "Got a link?"), el("p", {}, "Open the trip link your planner sent you, then tap your name.")),
  );
}

function newView() {
  setBack(here(), "Your trips");
  if (!me.account) {
    show(card(el("h2", {}, "Accounts only"), el("p", {}, "Making a trip needs an account, so it's kept for you on every device. Joining one doesn't."),
      el("a", { class: "button", href: "../profile/" }, "Sign in")));
    return;
  }
  const title = input({ placeholder: "Tokyo in December", maxlength: 60 });
  const emoji = input({ value: "🧳", maxlength: 8, "aria-label": "Emoji", style: "text-align:center" });
  const myName = input({ value: localProfile()?.display_name || "", placeholder: "So friends know it's you", maxlength: 24 });
  const from = input({ type: "date" }), to = input({ type: "date" });
  const cur = input({ value: "PHP", maxlength: 3, class: "code-in", autocapitalize: "characters" });
  show(card(el("h2", {}, "New trip"),
    el("div", { class: "pair emoji-first" }, field("Icon", emoji), field("Trip name", title)),
    field("Your name on it", myName),
    el("div", { class: "pair" }, field("From", from), field("To", to)),
    field("Home currency", cur),
    el("button", { type: "button", onclick: (e) => act(e.target, async () => {
      const id = await tr.makeTrip({ title: title.value, myName: myName.value, emoji: emoji.value, startsOn: from.value, endsOn: to.value, homeCurrency: cur.value });
      location.replace(here(`id=${id}&people&new`));
    }) }, "Make trip")));
  title.focus();
}

// ---------- joining ----------
async function joinView(code) {
  setBack(here(), "Your trips");
  const info = await tr.joinInfo(code);
  if (!info) {
    show(card(el("h2", {}, "This link doesn't work"), el("p", {}, "It may be old. Ask the planner for a new one.")));
    return;
  }
  const mine = (await tr.myTrips()).find((t) => t.id === info.id);
  if (mine) { location.replace(here(`id=${info.id}`)); return; }
  const pick = (p) => el("button", { type: "button", class: "item", disabled: p.taken, onclick: (e) => act(e.target, async () => {
    if (!confirm(`Join as ${p.name}?`)) return;
    await tr.claim(code, p.id);
    local.set("trip-joined", true);
    location.replace(here(`id=${info.id}`));
  }) }, el("span", { class: "who" }, face(p)), p.taken && el("span", { class: "meta" }, "Taken"));
  show(
    el("section", { class: "card hero" }, el("span", { class: "big", "aria-hidden": "true" }, info.emoji), el("h2", {}, info.title),
      dates(info.starts_on, info.ends_on) && el("p", {}, dates(info.starts_on, info.ends_on))),
    card(el("h2", {}, "Who are you?"),
      info.people.length ? el("div", { class: "list" }, ...info.people.map(pick)) : empty("The planner hasn't added anyone yet."),
      el("p", { class: "empty" }, "Not on the list, or your name's taken? Ask the planner.")),
  );
}

// ---------- the trip ----------
let data = null, tripId = null, lastVersion = null, editing = 0;
const person = (id) => data.people.find((p) => p.id === id);
const canEdit = (section) => !data.trip.archived_at && (!section?.locked || data.planner);

async function loadTrip(id) {
  tripId = id;
  data = await tr.load(id);
  if (data) lastVersion = data.trip.version;
  return data;
}
function notOnTrip() {
  setBack(here(), "Your trips");
  show(card(el("h2", {}, "You're not on this trip"),
    el("p", {}, me.id ? "Open the trip link from the planner and pick your name. Signed in to an account on it? Sign in on this device too."
      : "Open the trip link from the planner and pick your name."),
    el("a", { class: "button secondary", href: "../profile/" }, "Sign in")));
}

// Refresh when anything changes (checked every 15 s while the page shows and nothing is being edited).
let poller;
function watchTrip(redraw) {
  clearInterval(poller);
  poller = setInterval(async () => {
    if (document.hidden || sheetOpen || editing) return;
    try {
      const v = await tr.version(tripId);
      if (v != null && v !== lastVersion) { await loadTrip(tripId); if (data) redraw(); }
    } catch {}
  }, 15000);
}
async function after(fn, redraw) { await fn(); await loadTrip(tripId); if (data) redraw(); else notOnTrip(); }

async function tripView(id) {
  setBack(here(), "Your trips");
  if (!(await loadTrip(id))) { notOnTrip(); return; }
  drawTrip();
  watchTrip(drawTrip);
}

function drawTrip() {
  const t = data.trip;
  document.title = `${t.title} · Trip`;
  const mine = person(data.me);
  const sections = [...data.sections].sort((a, b) => a.position - b.position);
  show(
    el("section", { class: "card hero" },
      el("span", { class: "big", "aria-hidden": "true" }, t.emoji),
      el("h2", {}, t.title),
      el("p", {}, [dates(t.starts_on, t.ends_on), `You're ${mine?.name || "here"}`].filter(Boolean).join(" · ")),
      el("div", { class: "buttons" },
        el("a", { class: "button", href: here(`id=${t.id}&people`), "aria-label": `People (${data.people.filter((p) => !p.removed_at).length})` }, "👥 People"),
        data.planner && el("a", { class: "button", href: here(`id=${t.id}&log`) }, "📜 Log"),
        data.planner && el("a", { class: "button", href: here(`id=${t.id}&edit`) }, "⚙️ Trip"))),
    t.archived_at && el("p", { class: "banner" }, "This trip is archived: read only."),
    ...sections.map((s, n) => sectionCard(s, n, sections)),
    !t.archived_at && el("button", { type: "button", class: "secondary", onclick: addSectionSheet }, "＋ Add a section"),
    !sections.length && empty("Nothing here yet. Add notes for ideas and an itinerary for the plan."),
  );
}

function addSectionSheet() {
  openSheet("Add a section", (close) => [actions(...Object.entries(tr.KINDS).map(([kind, k]) =>
    action(k.icon, k.title, (e) => act(e.target, async () => {
      close();
      await after(() => tr.addSection(tripId, kind, k.title), drawTrip);
      view.lastElementChild?.previousElementSibling?.scrollIntoView({ behavior: "smooth", block: "center" });
    })))),
    el("p", { class: "empty" }, "Chat, budget, expenses, checklists and polls are on their way.")]);
}

function sectionCard(s, n, all) {
  const box = card();
  const menu = el("button", { type: "button", class: "icon-btn", "aria-label": `Options for ${s.title}`, onclick: () => sectionMenu(s, n, all) }, "⋯");
  box.append(head(el("span", {}, `${tr.KINDS[s.kind]?.icon || ""} ${s.title}`), s.locked && el("span", { class: "tag", title: "Locked by a planner" }, "🔒"),
    !data.trip.archived_at && (canEdit(s) || data.planner) && menu));
  if (s.kind === "notes") notesBody(s, box);
  else if (s.kind === "itinerary") itineraryBody(s, box);
  return box;
}

function sectionMenu(s, n, all) {
  const order = all.map((x) => x.id);
  const move = (step) => async () => {
    const ids = [...order];
    ids.splice(n, 1);
    ids.splice(n + step, 0, s.id);
    await after(() => tr.orderSections(tripId, ids), drawTrip);
  };
  openSheet(s.title, (close) => {
    const title = input({ value: s.title, maxlength: 60 });
    const byDay = el("input", { type: "checkbox", checked: s.by_day });
    const go = (fn) => (e) => act(e.target, async () => { close(); await fn(); });
    return [
      canEdit(s) && field("Title", title),
      canEdit(s) && s.kind === "itinerary" && el("label", { class: "check" }, byDay, "Group by day"),
      canEdit(s) && el("button", { type: "button", onclick: go(() => after(() => tr.editSection(s.id, title.value, byDay.checked), drawTrip)) }, "Save"),
      actions(
        n > 0 && action("⬆️", "Move up", go(move(-1))),
        n < all.length - 1 && action("⬇️", "Move down", go(move(1))),
        data.planner && action(s.locked ? "🔓" : "🔒", s.locked ? "Unlock" : "Lock", go(() => after(() => tr.lockSection(s.id, !s.locked), drawTrip))),
        canEdit(s) && action("🗑️", "Delete", go(async () => {
          if (!confirm(`Delete ${s.title} and everything in it? Planners can still see it in the log.`)) return;
          await after(() => tr.deleteSection(s.id), drawTrip);
        }), { class: "secondary danger" })),
      data.planner && el("p", { class: "empty" }, s.locked ? "Locked: only planners change it." : "Lock it so only planners can change it."),
    ];
  });
}

// ---------- notes ----------
// Draws the notes' simple formatting as elements (never as HTML): # headings, - or * lists, 1. lists, **bold**, links.
function inline(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"]+)/g;
  let at = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > at) out.push(text.slice(at, m.index));
    if (m[1]) out.push(el("strong", {}, m[1]));
    else out.push(el("a", { href: m[3] || m[4], target: "_blank", rel: "noopener noreferrer" }, m[2] || m[4]));
    at = re.lastIndex;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
function drawNotes(body) {
  const out = [];
  let list = null, para = null;
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.*)$/), ul = line.match(/^\s*[-*•]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== tag) { list = el(tag); out.push(list); }
      list.append(el("li", {}, ...inline((ul || ol)[1])));
      para = null;
      continue;
    }
    list = null;
    if (h) { out.push(el(`h${h[1].length + 2}`, {}, ...inline(h[2]))); para = null; }
    else if (!line.trim()) para = null;
    else if (para) para.append(el("br"), ...inline(line));
    else { para = el("p", {}, ...inline(line)); out.push(para); }
  }
  return el("div", { class: "notes" }, ...out);
}
function notesBody(s, box) {
  const read = () => {
    box.replaceChildren(...[box.firstChild, s.body ? drawNotes(s.body) : empty(canEdit(s) ? "Nothing written yet." : "Nothing written."),
      canEdit(s) && el("button", { type: "button", class: "secondary", onclick: write }, s.body ? "✏️ Edit" : "✏️ Write")].filter(Boolean));
  };
  const write = () => {
    editing++;
    const area = el("textarea", { class: "notes-edit", "aria-label": s.title, maxlength: 20000 });
    area.value = s.body;
    const done = () => { editing = Math.max(0, editing - 1); };
    box.replaceChildren(box.firstChild, area,
      el("p", { class: "format-help" }, "# Heading · - list · **bold** · links as they are"),
      el("div", { class: "buttons" },
        el("button", { type: "button", class: "secondary", onclick: () => { done(); read(); } }, "Cancel"),
        el("button", { type: "button", onclick: (e) => act(e.target, async () => {
          try { await tr.saveNote(s.id, s.version, area.value); }
          catch (err) {
            if (err instanceof CoreError && /saved this meanwhile/.test(err.message)) {
              const mineText = area.value;
              done(); await loadTrip(tripId); drawTrip();
              try { await navigator.clipboard.writeText(mineText); } catch {}
              throw new CoreError(`${err.message} (Yours is copied.)`);
            }
            throw err;
          }
          done();
          await after(() => {}, drawTrip);
          note("Saved.");
        }) }, "Save")));
    area.focus();
  };
  read();
}

// ---------- itinerary ----------
function itineraryBody(s, box) {
  const items = data.items.filter((i) => i.section_id === s.id);
  const byTime = (a, b) => (a.starts_at || "99").localeCompare(b.starts_at || "99") || a.position - b.position || a.id.localeCompare(b.id);
  const byPos = (a, b) => a.position - b.position || a.id.localeCompare(b.id);
  const rows = [];
  if (s.by_day) {
    const days = new Set(items.map((i) => i.day).filter(Boolean));
    const { starts_on: a, ends_on: b } = data.trip;
    if (a && b) for (let d = asDate(a); d <= asDate(b); d.setDate(d.getDate() + 1)) days.add(d.toLocaleDateString("sv"));
    for (const d of [...days].sort()) {
      const on = items.filter((i) => i.day === d).sort(byTime);
      rows.push(el("p", { class: "day" }, day(d)), on.length ? el("div", { class: "stop-wrap" }, ...on.map((i) => stop(i, s))) : empty("Free day."));
    }
    const loose = items.filter((i) => !i.day).sort(byPos);
    if (loose.length) rows.push(el("p", { class: "day" }, "Unscheduled"), el("div", { class: "stop-wrap" }, ...loose.map((i) => stop(i, s))));
  } else {
    const sorted = [...items].sort((x, y) => (x.day || "9999").localeCompare(y.day || "9999") || byTime(x, y));
    if (sorted.length) rows.push(el("div", { class: "stop-wrap" }, ...sorted.map((i) => stop(i, s, true))));
  }
  box.append(...[...rows, !items.length && empty("Nothing planned yet."),
    canEdit(s) && el("button", { type: "button", class: "secondary", onclick: () => itemSheet(s, null) }, "＋ Add to the plan")].filter(Boolean));
}
function stop(i, s, showDay = false) {
  const outs = data.optouts.filter((o) => o.item_id === i.id);
  const mineOut = outs.find((o) => o.person_id === data.me);
  const going = i.going?.map(person).filter(Boolean) || [];
  const time = i.starts_at ? `${hhmm(i.starts_at)}${i.ends_at ? `–${hhmm(i.ends_at)}` : ""}` : "";
  const tags = [
    showDay && i.day && el("span", { class: "tag sea" }, day(i.day)),
    i.cost != null && el("span", { class: "tag" }, `≈ ${money(Number(i.cost), i.cost_currency)}`),
    going.length > 0 && el("span", { class: "tag" }, `👥 ${going.map((p) => p.name).join(", ")}`),
    ...Object.entries(tr.OPT_OUTS).map(([k, label]) => {
      const n = outs.filter((o) => o.kind === k).length;
      return n > 0 && el("span", { class: "tag", title: outs.filter((o) => o.kind === k).map((o) => person(o.person_id)?.name).join(", ") },
        `${label}: ${n}`);
    }),
  ].filter(Boolean);
  return el("button", { type: "button", class: `stop${mineOut ? " out" : ""}`, onclick: () => itemSheet(s, i) },
    el("span", { class: "time" }, time.length > 5 ? el("span", {}, hhmm(i.starts_at), el("br"), hhmm(i.ends_at)) : time),
    el("span", { class: "what" }, el("span", { class: "title" }, i.title), i.place && el("span", { class: "place" }, `📍 ${i.place}`),
      tags.length > 0 && el("span", { class: "tags" }, ...tags)));
}

// One item: its details, and (for those who may) the form to change it. New when i is null.
function itemSheet(s, i) {
  const can = canEdit(s);
  const t = data.trip;
  const v = (k) => (i?.[k] ?? "");
  const title = input({ value: v("title"), maxlength: 120, placeholder: "Flight to Narita", disabled: !can });
  const dayIn = input({ type: "date", value: v("day"), min: t.starts_on || null, disabled: !can });
  const from = input({ type: "time", value: hhmm(i?.starts_at), disabled: !can }), to = input({ type: "time", value: hhmm(i?.ends_at), disabled: !can });
  const place = input({ value: v("place"), maxlength: 200, placeholder: "Address or name", disabled: !can });
  const linkIn = input({ value: v("link"), maxlength: 500, placeholder: "https://…", inputmode: "url", disabled: !can });
  const noteIn = el("textarea", { maxlength: 2000, disabled: !can }); noteIn.value = v("note");
  const people = data.people.filter((p) => !p.removed_at);
  const checks = people.map((p) => el("input", { type: "checkbox", value: p.id, checked: !!i?.going?.includes(p.id), disabled: !can }));
  const cost = input({ type: "number", min: 0, step: "any", inputmode: "decimal", value: v("cost"), placeholder: "0", disabled: !can });
  const curs = [t.home_currency, t.local_currency].filter(Boolean);
  const cur = el("select", { disabled: !can, "aria-label": "Currency" }, ...curs.map((c) => el("option", { value: c, selected: c === (i?.cost_currency || t.home_currency) }, c)));
  const hasMore = !!(i?.going?.length || i?.cost != null);
  const fields = () => ({ title: title.value, day: dayIn.value, starts_at: from.value, ends_at: to.value, place: place.value, link: linkIn.value,
    note: noteIn.value, going: checks.filter((c) => c.checked).map((c) => c.value).length === people.length ? [] : checks.filter((c) => c.checked).map((c) => c.value),
    cost: cost.value, cost_currency: cur.value });
  const myOut = i && data.optouts.find((o) => o.item_id === i.id && o.person_id === data.me);
  openSheet(i ? (can ? "Edit" : i.title) : "Add to the plan", (close) => {
    const go = (fn) => (e) => act(e.target, async () => { await fn(); close(); });
    return [
      field("What", title),
      el("div", { class: "pair" }, field("Day", dayIn), el("span")),
      el("div", { class: "pair" }, field("From", from), field("To", to)),
      field("Place", place),
      i?.place && el("a", { class: "button secondary", href: mapsLink(i.place), target: "_blank", rel: "noopener noreferrer" }, "📍 Open in Maps"),
      field("Link", linkIn),
      i?.link && el("a", { class: "button secondary", href: i.link, target: "_blank", rel: "noopener noreferrer" }, "🔗 Open the link"),
      field("Note", noteIn),
      el("details", { class: "more", open: hasMore },
        el("summary", {}, "More: who's going, cost"),
        el("fieldset", { style: "border:0;padding:0;margin:0" }, el("legend", { style: "font-weight:650;font-size:0.9rem" }, "Who's going (none ticked: everyone)"),
          ...people.map((p, n) => el("label", { class: "check" }, checks[n], face(p)))),
        el("div", { class: "pair" }, field("Cost estimate", cost), field("Currency", cur))),
      can && el("button", { type: "button", onclick: go(() => after(() => (i ? tr.editItem(i.id, fields()) : tr.addItem(s.id, fields())), drawTrip)) }, i ? "Save" : "Add"),
      i && actions(
        ...Object.entries(tr.OPT_OUTS).map(([k, label]) => action(myOut?.kind === k ? "↩️" : k === "not_going" ? "🙅" : "😐",
          myOut?.kind === k ? `I'm in after all` : label, go(() => after(() => tr.optOut(i.id, myOut?.kind === k ? null : k), drawTrip)))),
        can && action("⬆️", "Earlier", go(() => after(() => tr.moveItem(i.id, -1), drawTrip))),
        can && action("⬇️", "Later", go(() => after(() => tr.moveItem(i.id, 1), drawTrip))),
        can && action("🗑️", "Delete", go(async () => { if (confirm(`Delete ${i.title}?`)) await after(() => tr.deleteItem(i.id), drawTrip); }), { class: "secondary danger" })),
    ];
  });
}

// ---------- people ----------
async function peopleView(id) {
  setBack(here(`id=${id}`), "Back to the trip");
  if (!(await loadTrip(id))) { notOnTrip(); return; }
  if (params.has("new")) note("Trip made. Add your friends, then send them the link.");
  await drawPeople();
  watchTrip(drawPeople);
}
async function drawPeople() {
  const t = data.trip;
  const all = data.people;
  const on = all.filter((p) => !p.removed_at), off = all.filter((p) => p.removed_at);
  const row = (p) => el("button", { type: "button", class: "item", onclick: () => personSheet(p) },
    el("span", { class: "who" }, face(p)),
    p.id === data.me && el("span", { class: "tag sea" }, "You"),
    p.planner && el("span", { class: "tag" }, "Planner"),
    !p.removed_at && !p.taken && el("span", { class: "meta" }, "Not joined"));
  let linkCard = null;
  if (data.planner) {
    const code = await tr.joinLink(t.id);
    const url = new URL(here(`t=${code}`), location.href).href;
    linkCard = card(el("h2", {}, "Join link"),
      el("p", {}, "Send it to the group. They open it, tap their name and they're in: no account needed."),
      await qrBox(url, "QR code of the join link"),
      el("p", { class: "linkbox" }, url),
      el("div", { class: "buttons" },
        el("button", { type: "button", onclick: (e) => act(e.target, () => shareLink(url, t.title)) }, "Share link"),
        el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, async () => {
          if (!confirm("Make a new link? The old one stops working (everyone who joined stays).")) return;
          await tr.newJoinCode(t.id);
          await drawPeople();
          note("New link made.");
        }) }, "New link")));
  }
  const name = input({ placeholder: "Name", maxlength: 24, "aria-label": "Name" });
  const icon = input({ value: "👤", maxlength: 8, "aria-label": "Emoji", style: "text-align:center" });
  show(
    card(head(`People (${on.length})`), el("div", { class: "list" }, ...on.map(row)),
      data.planner && !t.archived_at && el("div", { class: "pair emoji-first" }, icon, name),
      data.planner && !t.archived_at && el("button", { type: "button", onclick: (e) => act(e.target, async () => {
        await tr.addPerson(t.id, name.value, icon.value);
        await loadTrip(t.id); await drawPeople();
        note("Added.");
        document.querySelector("input[aria-label=Name]")?.focus();
      }) }, "＋ Add person")),
    linkCard,
    off.length > 0 && card(el("h2", {}, "Removed"), el("div", { class: "list" }, ...off.map(row))),
    !data.planner && el("p", { class: "empty" }, "Only planners add people. Tap your own name to change it."),
  );
}
function personSheet(p) {
  const mine = p.id === data.me;
  const planner = data.planner;
  const archived = !!data.trip.archived_at;
  if (!mine && !planner) return;
  const redraw = async () => { await loadTrip(tripId); if (data) await drawPeople(); else notOnTrip(); };
  openSheet(face(p), (close) => {
    const name = input({ value: p.name, maxlength: 24, "aria-label": "Name" });
    const icon = input({ value: p.icon, maxlength: 8, "aria-label": "Emoji", style: "text-align:center" });
    const go = (fn) => (e) => act(e.target, async () => { close(); await fn(); await redraw(); });
    return [
      !p.removed_at && !archived && el("div", { class: "pair emoji-first" }, icon, name),
      !p.removed_at && !archived && el("button", { type: "button", onclick: go(() => tr.editPerson(p.id, name.value, icon.value)) }, "Save"),
      actions(
        planner && !p.removed_at && p.taken && !mine && action("🔓", "Free name", go(async () => {
          if (confirm(`Free ${p.name}? Their phone lets go, and they (or anyone with the link) can pick the name again.`)) await tr.freePerson(p.id);
        })),
        planner && !p.removed_at && action(p.planner ? "👤" : "⭐", p.planner ? "Not planner" : "Make planner", go(() => tr.setPlanner(p.id, !p.planner))),
        planner && !archived && !mine && action(p.removed_at ? "↩️" : "🚪", p.removed_at ? "Bring back" : "Remove", go(async () => {
          if (p.removed_at || confirm(`Remove ${p.name} from the trip? What they added stays.`)) await tr.removePerson(p.id, !p.removed_at);
        })),
        mine && !me.account && action("🔗", "Link account", go(async () => {
          const code = await tr.handoverCode(tripId);
          local.set(HANDOVERS, [...local.get(HANDOVERS, []), code]);
          location.href = "../profile/";
        })),
        mine && action("👋", "Not me", go(async () => {
          if (!confirm(`Stop being ${p.name} on this trip? You can open the link again to pick your name.`)) return;
          await tr.release(tripId);
          location.replace(here());
        }))),
      planner && !p.taken && !p.removed_at && el("p", { class: "empty" }, "Planners need an account: they link one by joining signed in."),
    ];
  });
}

// ---------- the trip's details (planners) ----------
async function editView(id) {
  setBack(here(`id=${id}`), "Back to the trip");
  if (!(await loadTrip(id))) { notOnTrip(); return; }
  const t = data.trip;
  if (!data.planner) { show(card(el("h2", {}, "Planners only"), el("p", {}, "Only the trip's planners change its details."))); return; }
  const title = input({ value: t.title, maxlength: 60 });
  const emoji = input({ value: t.emoji, maxlength: 8, style: "text-align:center" });
  const from = input({ type: "date", value: t.starts_on || "" }), to = input({ type: "date", value: t.ends_on || "" });
  const home = input({ value: t.home_currency, maxlength: 3, class: "code-in", autocapitalize: "characters" });
  const localCur = input({ value: t.local_currency || "", maxlength: 3, class: "code-in", autocapitalize: "characters", placeholder: "JPY" });
  const rate = input({ type: "number", min: 0, step: "any", inputmode: "decimal", value: t.local_rate ?? "" });
  const rateLabel = el("span");
  const label = () => { rateLabel.textContent = `${(home.value || "PHP").toUpperCase()} for 1 ${(localCur.value || "local").toUpperCase()}`; };
  home.addEventListener("input", label); localCur.addEventListener("input", label); label();
  show(
    card(el("h2", {}, "Trip details"),
      el("div", { class: "pair emoji-first" }, field("Icon", emoji), field("Trip name", title)),
      el("div", { class: "pair" }, field("From", from), field("To", to)),
      el("div", { class: "pair" }, field("Home currency", home), field("Local currency", localCur)),
      el("label", { class: "field" }, rateLabel, rate),
      !t.archived_at && el("button", { type: "button", onclick: (e) => act(e.target, async () => {
        await tr.editTrip(t.id, { title: title.value, emoji: emoji.value, startsOn: from.value, endsOn: to.value, homeCurrency: home.value,
          localCurrency: localCur.value, localRate: rate.value });
        location.replace(here(`id=${t.id}`));
      }) }, "Save")),
    card(el("h2", {}, t.archived_at ? "Archived" : "Archive"),
      el("p", {}, t.archived_at ? "Everyone can still read it. Bring it back to change things again."
        : "Once everything's settled: the trip stays readable, and nothing changes any more."),
      el("button", { type: "button", class: "secondary", onclick: (e) => act(e.target, async () => {
        if (!t.archived_at && !confirm("Archive this trip? It becomes read only (you can bring it back).")) return;
        await tr.archiveTrip(t.id, !t.archived_at);
        location.replace(here(`id=${t.id}`));
      }) }, t.archived_at ? "Bring it back" : "Archive trip")),
  );
}

// ---------- the log (planners) ----------
const ACTIONS = {
  "trip.make": "made the trip", "trip.edit": "changed the trip's details", "trip.archive": "archived the trip",
  "trip.unarchive": "brought the trip back", "trip.new_join_code": "made a new join link",
  "person.add": "added", "person.edit": "renamed", "person.remove": "removed", "person.restore": "brought back",
  "person.free": "freed the name", "person.planner": "made a planner:", "person.not_planner": "made not a planner:",
  "person.claim": "joined", "person.release": "let go of the name", "person.link": "linked an account to",
  "section.add": "added the section", "section.edit": "changed the section", "section.order": "reordered the sections",
  "section.lock": "locked", "section.unlock": "unlocked", "section.delete": "deleted the section", "note.save": "edited the notes",
  "item.add": "added", "item.edit": "changed", "item.move": "moved", "item.delete": "deleted", "item.opt_out": "changed going for",
};
async function logView(id) {
  setBack(here(`id=${id}`), "Back to the trip");
  if (!(await loadTrip(id))) { notOnTrip(); return; }
  if (!data.planner) { show(card(el("h2", {}, "Planners only"), el("p", {}, "Only the trip's planners see the log."))); return; }
  const list = el("div", { class: "list" });
  const more = el("button", { type: "button", class: "secondary" }, "Show older");
  const sections = Object.fromEntries(data.sections.map((s) => [s.id, s.title]));
  const items = Object.fromEntries(data.items.map((i) => [i.id, i.title]));
  const shown = (v) => (v == null || v === "" ? "–" : v === true ? "yes" : v === false ? "no" : typeof v === "string" && v.length > 60 ? `${v.slice(0, 60)}…` : v);
  const describe = (r) => {
    const d = r.detail || {};
    if (r.target === r.person_id && r.action.startsWith("person.")) return { what: "", changes: "" };
    const what = d.new?.title || d.old?.title || d.new?.name || d.old?.name || person(r.target)?.name || sections[r.target] || items[r.target] || "";
    const changes = d.old && d.new && typeof d.old === "object"
      ? Object.keys({ ...d.old, ...d.new }).filter((k) => JSON.stringify(d.old[k]) !== JSON.stringify(d.new[k]) && k !== "going")
        .map((k) => `${k.replace("_", " ")}: ${shown(d.old[k])} → ${shown(d.new[k])}`).join(" · ")
      : r.action === "item.opt_out" ? (tr.OPT_OUTS[d.kind] || "going again") : "";
    return { what, changes };
  };
  let oldest = null;
  const loadMore = async () => {
    const rows = await tr.log(id, oldest);
    for (const r of rows) {
      const { what, changes } = describe(r);
      list.append(el("div", { class: "entry" },
        el("span", { class: "when" }, new Date(r.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })),
        el("span", {}, el("b", {}, person(r.person_id)?.name || "Someone"), ` ${ACTIONS[r.action] || r.action} `, what && el("b", {}, what)),
        changes && el("span", { class: "change" }, changes)));
      oldest = r.id;
    }
    more.hidden = rows.length < 50;
    if (!list.children.length) list.append(empty("Nothing yet."));
  };
  more.addEventListener("click", (e) => act(e.target, loadMore));
  show(card(head("Log"), el("p", { class: "empty" }, "Every change on the trip. Only planners see this."), list, more));
  await loadMore();
}
