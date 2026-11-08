// Trip's client (apps/trip/, its database in supabase/migrations/…_trip*.sql, the plan in apps/_trip-plan.md), built
// on core.app("trip"). Everything that changes something is a database function, which checks who may do it and writes
// the log; these only fetch and send, and throw a CoreError with a message to show. With ?backend=fake: this browser only.
//   await trip.me()                      { id, account }: this device's sign-in (no sign-up) and account, or nulls
//   await trip.myTrips()                 [{ id, title, emoji, starts_on, ends_on, archived, me, planner }]
//   await trip.makeTrip({ title, myName, emoji, startsOn, endsOn, homeCurrency })   the new trip's id (accounts only)
//   await trip.load(id)                  { trip, people, sections, items, optouts, me, planner } or null (not on it)
//   await trip.version(id)               a number that changes whenever anything on the trip does (to refresh)
//   await trip.editTrip(id, { title, emoji, startsOn, endsOn, homeCurrency, localCurrency, localRate })
//   await trip.archiveTrip(id, archived) / joinLink(id) / newJoinCode(id)   – / – / the code for the link
//   await trip.addPerson(id, name, icon) / editPerson(person, name, icon) / removePerson(person, removed)
//   await trip.freePerson(person, unlink) / setPlanner(person, planner)
//   await trip.joinInfo(code)            { id, title, emoji, starts_on, ends_on, archived, people: [{ id, name, icon, taken }] }
//                                        or null (no sign-in needed)
//   await trip.claim(code, person)       signs this device in (anonymously, if it isn't) and becomes that name: the trip id
//   await trip.release(id)               stops being your name on the trip
//   await trip.handoverCode(id) / takeOver(code)   on the claimed phone / signed in to the account: links the account
//   await trip.addSection(id, kind, title) / editSection(section, title, byDay) / orderSections(id, ids)
//   await trip.lockSection(section, locked) / deleteSection(section)
//   await trip.saveNote(section, version, body)   the new version (refused if someone saved since `version`)
//   await trip.addItem(section, fields) / editItem(item, fields) / moveItem(item, step) / deleteItem(item)
//     fields: { title, day, starts_at, ends_at, place, link, note, going, cost, cost_currency } (null clears one)
//   await trip.optOut(item, kind)        'not_going', 'not_interested' or null, for yourself
//   await trip.log(id, before)           planners: the 50 log rows before id `before` (newest first)
// The chat (…_trip_chat.sql): one per trip, and a thread per itinerary item (`about`):
//   await trip.messages(id, { about, before, limit })   { messages: [{ id, person_id, about, reply_to, body, mentions, at,
//                                        edited_at, deleted_at }] (oldest first), reactions: [{ message_id, person_id, emoji }] }
//   await trip.threadCounts(id)          { [item id]: number of comments }
//   await trip.latestMessage(id)         the chat's newest message id (for "new" marks), or 0
//   await trip.sendMessage(id, body, { replyTo, about, mentions }) / editMessage(message, body) / deleteMessage(message)
//   await trip.react(message, emoji, on)
// Push notifications (…_trip_push.sql, sent by the game server, worker/src/push.js):
//   trip.pushSupport()                   "ok", "install" (an iPhone, not from the home screen yet) or "no"
//   await trip.pushState(id)             { support, permission, on, settings: { mentions, replies, comments, all_messages } }
//   await trip.enablePush(id) / disablePush()   asks permission and subscribes this phone / unsubscribes it
//   await trip.setPushSettings(id, settings)
//   trip.follow(id, onChange)            follows the trip (its changes, messages and reactions) live; returns stop()
import * as core from "../shared/core.js";

const app = core.app("trip");
const { CoreError } = core;
const rpc = (fn, args) => app.run(app.db.rpc(fn, args));
const rows = (query) => app.run(query);

export const KINDS = { notes: { icon: "📝", title: "Notes" }, itinerary: { icon: "🗓️", title: "Itinerary" } };
export const OPT_OUTS = { not_going: "Not going", not_interested: "Not interested" };

// ---------- checks (as the database makes them, so the page can say so before sending) ----------
const BAD = /[<>&\p{Cc}­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]/u;
const len = (s) => [...s].length;
function text(value, max, what) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!s || len(s) > max || BAD.test(s)) throw new CoreError(`${what} is 1 to ${max} characters, without < > &.`);
  return s;
}
const optional = (value, fn) => (String(value ?? "").trim() ? fn(value) : null);
const emoji = (value, fallback) => {
  const s = String(value ?? "").trim();
  return s && len(s) <= 16 && !BAD.test(s) ? s : fallback;
};
const personName = (name) => {
  const s = core.cleanName(name);
  if (!s) throw new CoreError("A name is 1 to 24 letters, numbers or emoji.");
  return s;
};
const currency = (value, what = "A currency") => {
  const s = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) throw new CoreError(`${what} is a 3-letter code, like PHP or JPY.`);
  return s;
};
const date = (value) => {
  const s = String(value ?? "").trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new CoreError("Pick a date.");
  return s;
};
const time = (value) => {
  const s = String(value ?? "").trim();
  if (!s) return null;
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(s)) throw new CoreError("Pick a time.");
  return s.slice(0, 5);
};
const link = (value) => {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const url = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  if (len(url) > 500 || !/^https?:\/\/[^\s<>"]+$/i.test(url)) throw new CoreError("That link doesn't look right.");
  return url;
};
function tripFields(t) {
  const startsOn = date(t.startsOn), endsOn = date(t.endsOn);
  if (startsOn && endsOn && endsOn < startsOn) throw new CoreError("The trip can't end before it starts.");
  const home = currency(t.homeCurrency || "PHP", "The home currency");
  const local = optional(t.localCurrency, (v) => currency(v, "The local currency"));
  if (local && local === home) throw new CoreError("The local currency is a different one from home.");
  const rate = local ? Number(t.localRate) : null;
  if (local && !(rate > 0)) throw new CoreError(`Give the rate: how many ${home} for 1 ${local}.`);
  return { title: text(t.title, 60, "A title"), emoji: emoji(t.emoji, "🧳"), starts_on: startsOn, ends_on: endsOn,
    home_currency: home, local_currency: local, local_rate: rate };
}
// Item fields: only those given are sent (and checked); "" clears one.
function itemFields(f) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(f, k);
  if (has("title")) out.title = text(f.title, 120, "A title");
  if (has("day")) out.day = date(f.day);
  if (has("starts_at")) out.starts_at = time(f.starts_at);
  if (has("ends_at")) out.ends_at = time(f.ends_at);
  if (out.ends_at && !(has("starts_at") ? out.starts_at : true)) throw new CoreError("Give a start time with the end time.");
  if (has("place")) out.place = optional(f.place, (v) => {
    const s = String(v).replace(/\s+/g, " ").trim();
    if (len(s) > 200 || /[<>\p{Cc}]/u.test(s)) throw new CoreError("A place is up to 200 characters, without < >.");
    return s;
  });
  if (has("link")) out.link = link(f.link);
  if (has("note")) out.note = optional(f.note, (v) => {
    const s = String(v).trim();
    if (len(s) > 2000) throw new CoreError("A note is up to 2000 characters.");
    return s;
  });
  if (has("going")) out.going = f.going?.length ? [...new Set(f.going)] : null;
  if (has("cost")) {
    const v = String(f.cost ?? "").trim();
    out.cost = v === "" ? null : Number(v);
    if (out.cost != null && !(out.cost >= 0 && out.cost < 1e12)) throw new CoreError("A cost is a number.");
    out.cost_currency = out.cost == null ? null : currency(f.cost_currency);
  }
  return out;
}

// ---------- live (Supabase) ----------
const live = {
  myTrips: () => rpc("my_trips"),
  makeTrip: (t, myName) => rpc("make_trip", { title: t.title, my_name: myName, emoji: t.emoji, starts_on: t.starts_on,
    ends_on: t.ends_on, home_currency: t.home_currency }),
  async load(id) {
    const [me, planner, trips, people, sections, items, optouts] = await Promise.all([
      rpc("me", { trip: id }), rpc("is_planner", { trip: id }),
      rows(app.db.from("trips").select("id, title, emoji, starts_on, ends_on, home_currency, local_currency, local_rate, archived_at, version").eq("id", id)),
      rows(app.db.from("people").select("id, name, icon, taken, planner, removed_at").eq("trip_id", id).order("added_at")),
      rows(app.db.from("sections").select("id, kind, title, position, locked, by_day, body, version, updated_at").eq("trip_id", id).order("position")),
      rows(app.db.from("items").select("id, section_id, title, day, starts_at, ends_at, place, link, note, going, cost, cost_currency, position").eq("trip_id", id)),
      rows(app.db.from("optouts").select("item_id, person_id, kind").eq("trip_id", id)),
    ]);
    if (!me || !trips[0]) return null;
    return { trip: trips[0], people, sections, items, optouts, me, planner };
  },
  async version(id) { return (await rows(app.db.from("trips").select("version").eq("id", id)))[0]?.version ?? null; },
  editTrip: (id, t) => rpc("edit_trip", { trip: id, title: t.title, emoji: t.emoji, starts_on: t.starts_on, ends_on: t.ends_on,
    home_currency: t.home_currency, local_currency: t.local_currency, local_rate: t.local_rate }),
  archiveTrip: (id, archived) => rpc("archive_trip", { trip: id, archived }),
  joinLink: (id) => rpc("join_link", { trip: id }),
  newJoinCode: (id) => rpc("new_join_code", { trip: id }),
  addPerson: (id, name, icon) => rpc("add_person", { trip: id, name, icon }),
  editPerson: (person, name, icon) => rpc("edit_person", { person, name, icon }),
  removePerson: (person, removed) => rpc("remove_person", { person, removed }),
  freePerson: (person, unlink) => rpc("free_person", { person, unlink }),
  setPlanner: (person, planner) => rpc("set_planner", { person, planner }),
  joinInfo: (code) => rpc("join_info", { code }),
  claim: (code, person) => rpc("claim", { code, person }),
  release: (id) => rpc("release", { trip: id }),
  handoverCode: (id) => rpc("handover_code", { trip: id }),
  takeOver: (code) => rpc("take_over", { code }),
  addSection: (id, kind, title) => rpc("add_section", { trip: id, kind, title }),
  editSection: (section, title, byDay) => rpc("edit_section", { section, title, by_day: byDay }),
  orderSections: (id, ids) => rpc("order_sections", { trip: id, sections: ids }),
  lockSection: (section, locked) => rpc("lock_section", { section, locked }),
  deleteSection: (section) => rpc("delete_section", { section }),
  saveNote: (section, version, body) => rpc("save_note", { section, version, body }),
  addItem: (section, fields) => rpc("add_item", { section, fields }),
  editItem: (item, fields) => rpc("edit_item", { item, fields }),
  moveItem: (item, step) => rpc("move_item", { item, step }),
  deleteItem: (item) => rpc("delete_item", { item }),
  optOut: (item, kind) => rpc("opt_out", { item, kind }),
  log(id, before) {
    let q = app.db.from("log").select("id, person_id, action, target, detail, at").eq("trip_id", id).order("id", { ascending: false }).limit(50);
    if (before) q = q.lt("id", before);
    return rows(q);
  },
};

live.messages = async (id, about, before, limit) => {
  let q = app.db.from("messages").select("id, person_id, about, reply_to, body, mentions, at, edited_at, deleted_at")
    .eq("trip_id", id).order("id", { ascending: false }).limit(limit);
  q = about ? q.eq("about", about) : q.is("about", null);
  if (before) q = q.lt("id", before);
  const messages = (await rows(q)).reverse();
  const reactions = messages.length ? await rows(app.db.from("reactions").select("message_id, person_id, emoji")
    .in("message_id", messages.map((m) => m.id))) : [];
  return { messages, reactions };
};
live.threadCounts = async (id) => {
  const list = await rows(app.db.from("messages").select("about").eq("trip_id", id).not("about", "is", null).is("deleted_at", null));
  const counts = {};
  for (const m of list) counts[m.about] = (counts[m.about] || 0) + 1;
  return counts;
};
live.latestMessage = async (id) => (await rows(app.db.from("messages").select("id").eq("trip_id", id).is("about", null)
  .order("id", { ascending: false }).limit(1)))[0]?.id || 0;
live.sendMessage = (id, body, replyTo, about, mentions) => rpc("send_message", { trip: id, body, reply_to: replyTo, about, mentions });
live.editMessage = (message, body) => rpc("edit_message", { message, body });
live.deleteMessage = (message) => rpc("delete_message", { message });
live.react = (message, emoji, on) => rpc("react", { message, emoji, on_off: on });

// ---------- ?backend=fake: this browser only (the same checks, roughly) ----------
const no = (message) => { throw new CoreError(message); };
const newId = () => crypto.randomUUID();
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[b % 32]).join("");
const now = () => new Date().toISOString();
function db() {
  const d = app.read();
  for (const k of ["trips", "people", "sections", "items", "optouts", "log", "handovers", "messages", "reactions"]) d[k] ||= [];
  return d;
}
const uid = async () => (await core.signedIn())?.id || null;
const accountId = async () => ((await core.account())?.active ? uid() : null);
async function fakeMe(d, trip) {
  const me = await uid();
  if (!me) return null;
  const mine = d.people.filter((p) => p.trip_id === trip && !p.removed_at && (p.user_id === me || p.account_id === me));
  return (mine.find((p) => p.account_id === me) || mine[0])?.id || null;
}
async function fakePlanner(d, trip) {
  const me = await accountId();
  return !!me && d.people.some((p) => p.trip_id === trip && !p.removed_at && p.planner && p.account_id === me);
}
const archived = (d, trip) => !!d.trips.find((t) => t.id === trip)?.archived_at;
async function needPlanner(d, trip, archivedOk = false) {
  if (!(await fakePlanner(d, trip))) no("Only the trip's planners can do that.");
  if (!archivedOk && archived(d, trip)) no("This trip is archived. A planner can bring it back first.");
}
async function needEditor(d, trip) {
  const me = await fakeMe(d, trip);
  if (!me) no("Only people on this trip can do that.");
  if (archived(d, trip)) no("This trip is archived. A planner can bring it back first.");
  return me;
}
async function needSection(d, section) {
  const s = d.sections.find((x) => x.id === section);
  if (!s) no("That section isn't there any more.");
  await needEditor(d, s.trip_id);
  if (s.locked && !(await fakePlanner(d, s.trip_id))) no("A planner locked this section. Ask them to unlock it.");
  return s;
}
async function logged(d, trip, action, target = null, detail = null) {
  d.log.push({ id: d.log.length + 1, trip_id: trip, person_id: await fakeMe(d, trip), action, target, detail, at: now() });
  const t = d.trips.find((x) => x.id === trip);
  if (t) t.version = (t.version || 0) + 1;
}
const person = (d, id) => d.people.find((p) => p.id === id) || no("There's no such person on this trip.");
const nameTaken = (d, trip, name, except) => d.people.some((p) => p.trip_id === trip && !p.removed_at && p.id !== except
  && p.name.toLowerCase() === name.toLowerCase());
const item = (d, id) => d.items.find((i) => i.id === id) || no("That item isn't there any more.");
const ITEM_KEYS = ["title", "day", "starts_at", "ends_at", "place", "link", "note", "going", "cost", "cost_currency"];
const pick = (i) => Object.fromEntries(ITEM_KEYS.filter((k) => i[k] != null).map((k) => [k, i[k]]));
function checkItem(d, trip, i) {
  const t = d.trips.find((x) => x.id === trip);
  if (i.cost_currency && ![t.home_currency, t.local_currency].includes(i.cost_currency)) no("Use the trip's own currency for costs.");
  if (i.going?.some((g) => !d.people.some((p) => p.trip_id === trip && p.id === g))) no("Only people on the trip can be going.");
  if (i.ends_at && !i.starts_at) no("Give a start time with the end time.");
}
const fake = {
  async myTrips() {
    const d = db();
    const out = [];
    for (const t of d.trips) {
      const me = await fakeMe(d, t.id);
      if (me) out.push({ id: t.id, title: t.title, emoji: t.emoji, starts_on: t.starts_on, ends_on: t.ends_on, archived: !!t.archived_at,
        me, planner: await fakePlanner(d, t.id) });
    }
    return out.sort((a, b) => String(b.starts_on || "9").localeCompare(String(a.starts_on || "9")));
  },
  async makeTrip(t, myName) {
    const me = await accountId();
    if (!me) no("Sign in to your account to make a trip.");
    const d = db();
    const id = newId();
    d.trips.push({ id, ...t, join_code: newCode(), made_at: now(), archived_at: null, version: 0 });
    d.people.push({ id: newId(), trip_id: id, name: myName, icon: "👤", user_id: me, account_id: me, planner: true, removed_at: null });
    await logged(d, id, "trip.make", id, { new: t });
    app.write(d);
    return id;
  },
  async load(id) {
    const d = db();
    const me = await fakeMe(d, id);
    const t = d.trips.find((x) => x.id === id);
    if (!me || !t) return null;
    const { join_code, ...trip } = t;
    return {
      trip, me, planner: await fakePlanner(d, id),
      people: d.people.filter((p) => p.trip_id === id).map(({ id: pid, name, icon, user_id, account_id, planner, removed_at }) =>
        ({ id: pid, name, icon, taken: !!(user_id || account_id), planner, removed_at })),
      sections: d.sections.filter((s) => s.trip_id === id).sort((a, b) => a.position - b.position),
      items: d.items.filter((i) => i.trip_id === id),
      optouts: d.optouts.filter((o) => o.trip_id === id),
    };
  },
  async version(id) { return db().trips.find((t) => t.id === id)?.version ?? null; },
  async editTrip(id, t) {
    const d = db();
    await needPlanner(d, id);
    const x = d.trips.find((y) => y.id === id);
    const old = { ...x };
    Object.assign(x, t);
    await logged(d, id, "trip.edit", id, { old: { title: old.title }, new: { title: x.title } });
    app.write(d);
  },
  async archiveTrip(id, on) {
    const d = db();
    await needPlanner(d, id, true);
    d.trips.find((t) => t.id === id).archived_at = on ? now() : null;
    await logged(d, id, on ? "trip.archive" : "trip.unarchive", id);
    app.write(d);
  },
  async joinLink(id) { const d = db(); await needPlanner(d, id, true); return d.trips.find((t) => t.id === id).join_code; },
  async newJoinCode(id) {
    const d = db();
    await needPlanner(d, id, true);
    const code = newCode();
    d.trips.find((t) => t.id === id).join_code = code;
    await logged(d, id, "trip.new_join_code", id);
    app.write(d);
    return code;
  },
  async addPerson(id, name, icon) {
    const d = db();
    await needPlanner(d, id);
    if (nameTaken(d, id, name)) no("There's already someone with that name on this trip.");
    const pid = newId();
    d.people.push({ id: pid, trip_id: id, name, icon, user_id: null, account_id: null, planner: false, removed_at: null });
    await logged(d, id, "person.add", pid, { new: { name, icon } });
    app.write(d);
    return pid;
  },
  async editPerson(pid, name, icon) {
    const d = db();
    const p = person(d, pid);
    if ((await fakeMe(d, p.trip_id)) !== pid) await needPlanner(d, p.trip_id);
    else if (archived(d, p.trip_id)) no("This trip is archived. A planner can bring it back first.");
    if (nameTaken(d, p.trip_id, name, pid)) no("There's already someone with that name on this trip.");
    const old = { name: p.name, icon: p.icon };
    Object.assign(p, { name, icon });
    await logged(d, p.trip_id, "person.edit", pid, { old, new: { name, icon } });
    app.write(d);
  },
  async removePerson(pid, removed) {
    const d = db();
    const p = person(d, pid);
    await needPlanner(d, p.trip_id);
    if (removed && p.planner) no("Make them not a planner first.");
    p.removed_at = removed ? now() : null;
    await logged(d, p.trip_id, removed ? "person.remove" : "person.restore", pid);
    app.write(d);
  },
  async freePerson(pid, unlink) {
    const d = db();
    const p = person(d, pid);
    await needPlanner(d, p.trip_id, true);
    if (unlink && p.planner) no("Make them not a planner first.");
    p.user_id = null;
    if (unlink) p.account_id = null;
    await logged(d, p.trip_id, "person.free", pid);
    app.write(d);
  },
  async setPlanner(pid, on) {
    const d = db();
    const p = person(d, pid);
    await needPlanner(d, p.trip_id, true);
    if (on && !p.account_id) no("Only someone with an account linked can be a planner.");
    if (!on && !d.people.some((x) => x.trip_id === p.trip_id && x.id !== pid && x.planner && !x.removed_at)) no("A trip needs at least one planner.");
    p.planner = on;
    await logged(d, p.trip_id, on ? "person.planner" : "person.not_planner", pid);
    app.write(d);
  },
  async joinInfo(code) {
    const d = db();
    const t = d.trips.find((x) => x.join_code === code);
    if (!t) return null;
    return { id: t.id, title: t.title, emoji: t.emoji, starts_on: t.starts_on, ends_on: t.ends_on, archived: !!t.archived_at,
      people: d.people.filter((p) => p.trip_id === t.id && !p.removed_at).map((p) => ({ id: p.id, name: p.name, icon: p.icon, taken: !!(p.user_id || p.account_id) })) };
  },
  async claim(code, pid) {
    const d = db();
    const me = await uid();
    const acc = await accountId();
    const t = d.trips.find((x) => x.join_code === code) || no("That link doesn't work any more. Ask the planner for a new one.");
    const p = d.people.find((x) => x.id === pid && x.trip_id === t.id && !x.removed_at) || no("There's no such person on this trip.");
    const mine = await fakeMe(d, t.id);
    if (mine === pid) return t.id;
    if (mine) no("You're already someone else on this trip. Let that name go first.");
    if (p.user_id || (p.account_id && p.account_id !== me)) no("Someone already took that name. If it's you, ask a planner to free it.");
    p.user_id = me;
    if (acc) p.account_id = acc;
    await logged(d, t.id, "person.claim", pid, { account: !!acc });
    app.write(d);
    return t.id;
  },
  async release(id) {
    const d = db();
    const me = await uid();
    const pid = await fakeMe(d, id);
    if (!pid) return;
    const p = person(d, pid);
    if (p.account_id === me && p.planner) no("Stop being a planner first.");
    await logged(d, id, "person.release", pid);
    if (p.user_id === me) p.user_id = null;
    if (p.account_id === me) p.account_id = null;
    app.write(d);
  },
  async handoverCode(id) {
    const d = db();
    const pid = (await fakeMe(d, id)) || no("Only people on this trip can do that.");
    const code = newCode();
    d.handovers = d.handovers.filter((h) => h.person_id !== pid).concat({ person_id: pid, code });
    app.write(d);
    return code;
  },
  async takeOver(code) {
    const d = db();
    const acc = (await accountId()) || no("Sign in to your account first.");
    const h = d.handovers.find((x) => x.code === code) || no("That code doesn't work any more.");
    d.handovers = d.handovers.filter((x) => x !== h);
    const p = person(d, h.person_id);
    const mine = await fakeMe(d, p.trip_id);
    if (mine && mine !== p.id) no("Your account is already someone else on this trip.");
    if (p.account_id && p.account_id !== acc) no("Another account is already linked to that name.");
    p.account_id = acc;
    await logged(d, p.trip_id, "person.link", p.id);
    app.write(d);
    return p.trip_id;
  },
  async addSection(id, kind, title) {
    const d = db();
    const me = await needEditor(d, id);
    if (!KINDS[kind]) no("Something went wrong. Try again.");
    const sid = newId();
    const mine = d.sections.filter((s) => s.trip_id === id);
    d.sections.push({ id: sid, trip_id: id, kind, title, position: mine.length ? Math.max(...mine.map((s) => s.position)) + 1 : 0,
      locked: false, by_day: false, body: "", version: 0, made_by: me, updated_at: now() });
    await logged(d, id, "section.add", sid, { new: { kind, title } });
    app.write(d);
    return sid;
  },
  async editSection(section, title, byDay) {
    const d = db();
    const s = await needSection(d, section);
    const old = { title: s.title, by_day: s.by_day };
    Object.assign(s, { title, by_day: !!byDay, updated_at: now() });
    await logged(d, s.trip_id, "section.edit", section, { old, new: { title, by_day: !!byDay } });
    app.write(d);
  },
  async orderSections(id, ids) {
    const d = db();
    await needEditor(d, id);
    const mine = d.sections.filter((s) => s.trip_id === id);
    if (mine.length !== ids.length || !mine.every((s) => ids.includes(s.id))) no("The page changed meanwhile. Showing the latest.");
    ids.forEach((sid, n) => { d.sections.find((s) => s.id === sid).position = n + 1; });
    await logged(d, id, "section.order", null, { order: ids });
    app.write(d);
  },
  async lockSection(section, locked) {
    const d = db();
    const s = d.sections.find((x) => x.id === section) || no("That section isn't there any more.");
    await needPlanner(d, s.trip_id);
    s.locked = !!locked;
    await logged(d, s.trip_id, locked ? "section.lock" : "section.unlock", section);
    app.write(d);
  },
  async deleteSection(section) {
    const d = db();
    const s = await needSection(d, section);
    await logged(d, s.trip_id, "section.delete", section, { old: { kind: s.kind, title: s.title, body: s.body || undefined,
      items: d.items.filter((i) => i.section_id === section).map(pick) } });
    const gone = new Set(d.items.filter((i) => i.section_id === section).map((i) => i.id));
    d.items = d.items.filter((i) => !gone.has(i.id));
    d.optouts = d.optouts.filter((o) => !gone.has(o.item_id));
    d.sections = d.sections.filter((x) => x.id !== section);
    app.write(d);
  },
  async saveNote(section, version, body) {
    const d = db();
    const s = await needSection(d, section);
    if (s.kind !== "notes") no("That isn't a notes section.");
    if (s.version !== version) no("Someone else saved this meanwhile. Showing theirs; copy yours back in if you need to.");
    if (s.body === body) return s.version;
    const old = s.body;
    Object.assign(s, { body, version: s.version + 1, updated_at: now() });
    await logged(d, s.trip_id, "note.save", section, { old, new: body });
    app.write(d);
    return s.version;
  },
  async addItem(section, fields) {
    const d = db();
    const s = await needSection(d, section);
    if (s.kind !== "itinerary") no("That isn't an itinerary.");
    checkItem(d, s.trip_id, fields);
    const id = newId();
    const sameDay = d.items.filter((i) => i.section_id === section && (i.day || null) === (fields.day || null));
    d.items.push({ ...Object.fromEntries(ITEM_KEYS.map((k) => [k, null])), ...fields, id, section_id: section, trip_id: s.trip_id,
      position: sameDay.length ? Math.max(...sameDay.map((i) => i.position)) + 1 : 0 });
    await logged(d, s.trip_id, "item.add", id, { section, new: pick(fields) });
    app.write(d);
    return id;
  },
  async editItem(id, fields) {
    const d = db();
    const i = item(d, id);
    await needSection(d, i.section_id);
    const next = { ...i, ...fields };
    checkItem(d, i.trip_id, next);
    if ((next.day || null) !== (i.day || null)) {
      const sameDay = d.items.filter((x) => x.section_id === i.section_id && (x.day || null) === (next.day || null));
      next.position = sameDay.length ? Math.max(...sameDay.map((x) => x.position)) + 1 : 0;
    }
    const old = pick(i);
    Object.assign(i, next);
    await logged(d, i.trip_id, "item.edit", id, { section: i.section_id, old, new: pick(i) });
    app.write(d);
  },
  async moveItem(id, step) {
    const d = db();
    const i = item(d, id);
    await needSection(d, i.section_id);
    const day = d.items.filter((x) => x.section_id === i.section_id && (x.day || null) === (i.day || null))
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const n = day.indexOf(i), other = day[n + (step < 0 ? -1 : 1)];
    if (!other) return;
    day.splice(n, 1);
    day.splice(n + (step < 0 ? -1 : 1), 0, i);
    day.forEach((x, k) => { x.position = k; });
    await logged(d, i.trip_id, "item.move", id, { section: i.section_id, step });
    app.write(d);
  },
  async deleteItem(id) {
    const d = db();
    const i = d.items.find((x) => x.id === id);
    if (!i) return;
    await needSection(d, i.section_id);
    await logged(d, i.trip_id, "item.delete", id, { section: i.section_id, old: pick(i) });
    d.items = d.items.filter((x) => x.id !== id);
    d.optouts = d.optouts.filter((o) => o.item_id !== id);
    app.write(d);
  },
  async optOut(id, kind) {
    const d = db();
    const i = item(d, id);
    const me = (await fakeMe(d, i.trip_id)) || no("Only people on this trip can do that.");
    d.optouts = d.optouts.filter((o) => !(o.item_id === id && o.person_id === me));
    if (kind) d.optouts.push({ item_id: id, person_id: me, trip_id: i.trip_id, kind });
    await logged(d, i.trip_id, "item.opt_out", id, { kind });
    app.write(d);
  },
  async log(id, before) {
    const d = db();
    if (!(await fakePlanner(d, id))) return [];
    return d.log.filter((r) => r.trip_id === id && (!before || r.id < before)).reverse().slice(0, 50);
  },
};

Object.assign(fake, {
  async messages(id, about, before, limit) {
    const d = db();
    if (!(await fakeMe(d, id))) return { messages: [], reactions: [] };
    const messages = d.messages.filter((m) => m.trip_id === id && (m.about || null) === (about || null) && (!before || m.id < before)).slice(-limit);
    const ids = new Set(messages.map((m) => m.id));
    return { messages, reactions: d.reactions.filter((r) => ids.has(r.message_id)) };
  },
  async threadCounts(id) {
    const counts = {};
    for (const m of db().messages) if (m.trip_id === id && m.about && !m.deleted_at) counts[m.about] = (counts[m.about] || 0) + 1;
    return counts;
  },
  async latestMessage(id) { return db().messages.filter((m) => m.trip_id === id && !m.about).at(-1)?.id || 0; },
  async sendMessage(id, body, replyTo, about, mentions) {
    const d = db();
    const me = await needEditor(d, id);
    if (about && !d.items.some((i) => i.id === about && i.trip_id === id)) no("That item isn't there any more.");
    const mid = (d.messages.at(-1)?.id || 0) + 1;
    d.messages.push({ id: mid, trip_id: id, person_id: me, about: about || null, reply_to: replyTo || null, body,
      mentions: (mentions || []).filter((p) => d.people.some((x) => x.id === p && x.trip_id === id)), at: now(), edited_at: null, deleted_at: null });
    app.write(d);
    return mid;
  },
  async editMessage(message, body) {
    const d = db();
    const m = d.messages.find((x) => x.id === message && !x.deleted_at) || no("That message isn't there any more.");
    if ((await needEditor(d, m.trip_id)) !== m.person_id) no("Only whoever wrote it can change it.");
    if (m.body === body) return;
    await logged(d, m.trip_id, "message.edit", m.about, { message, old: m.body, new: body });
    Object.assign(m, { body, edited_at: now() });
    app.write(d);
  },
  async deleteMessage(message) {
    const d = db();
    const m = d.messages.find((x) => x.id === message && !x.deleted_at);
    if (!m) return;
    if ((await needEditor(d, m.trip_id)) !== m.person_id && !(await fakePlanner(d, m.trip_id))) no("Only whoever wrote it, or a planner, can delete it.");
    await logged(d, m.trip_id, "message.delete", m.about, { message, by: m.person_id, old: m.body });
    Object.assign(m, { body: "", mentions: [], deleted_at: now() });
    d.reactions = d.reactions.filter((r) => r.message_id !== message);
    app.write(d);
  },
  async react(message, emoji, on) {
    const d = db();
    const m = d.messages.find((x) => x.id === message && !x.deleted_at) || no("That message isn't there any more.");
    const me = await needEditor(d, m.trip_id);
    d.reactions = d.reactions.filter((r) => !(r.message_id === message && r.person_id === me && r.emoji === emoji));
    if (on) d.reactions.push({ message_id: message, person_id: me, trip_id: m.trip_id, emoji });
    app.write(d);
  },
});

live.savePush = (s) => rpc("save_push", s);
live.dropPush = (endpoint) => rpc("drop_push", { endpoint });
live.pushSettings = (id) => rpc("push_settings", { trip: id });
live.setPushSettings = (id, s) => rpc("set_push_settings", { trip: id, mentions: s.mentions, replies: s.replies, comments: s.comments, all_messages: s.all_messages });
Object.assign(fake, {
  async savePush(s) { const d = db(); d.push = s.endpoint; app.write(d); },
  async dropPush() { const d = db(); delete d.push; app.write(d); },
  async pushSettings(id) {
    const d = db();
    const me = (await fakeMe(d, id)) || no("Only people on this trip can do that.");
    return { mentions: true, replies: true, comments: true, all_messages: false, ...(d.pushPrefs?.[me] || {}), phones: d.push ? 1 : 0 };
  },
  async setPushSettings(id, s) {
    const d = db();
    const me = (await fakeMe(d, id)) || no("Only people on this trip can do that.");
    (d.pushPrefs ||= {})[me] = { mentions: !!s.mentions, replies: !!s.replies, comments: !!s.comments, all_messages: !!s.all_messages };
    app.write(d);
  },
});

const backend = () => (app.fake ? fake : live);

// ---------- API ----------
export async function me() {
  const signed = await core.signedIn();
  return { id: signed?.id || null, account: signed ? await core.account() : null };
}
export async function myTrips() {
  if (!(await core.signedIn())) return [];
  return backend().myTrips();
}
export function makeTrip({ title, myName, emoji: em, startsOn, endsOn, homeCurrency }) {
  const t = tripFields({ title, emoji: em, startsOn, endsOn, homeCurrency });
  return backend().makeTrip(t, personName(myName));
}
export async function load(id) {
  if (!(await core.signedIn())) return null;
  return backend().load(id);
}
export const version = (id) => backend().version(id);
export const editTrip = (id, t) => backend().editTrip(id, tripFields(t));
export const archiveTrip = (id, archived) => backend().archiveTrip(id, !!archived);
export const joinLink = (id) => backend().joinLink(id);
export const newJoinCode = (id) => backend().newJoinCode(id);
export const addPerson = (id, name, icon) => backend().addPerson(id, personName(name), emoji(icon, "👤"));
export const editPerson = (person, name, icon) => backend().editPerson(person, personName(name), emoji(icon, "👤"));
export const removePerson = (person, removed = true) => backend().removePerson(person, !!removed);
export const freePerson = (person, unlink = false) => backend().freePerson(person, !!unlink);
export const setPlanner = (person, planner) => backend().setPlanner(person, !!planner);
export async function joinInfo(code) {
  const key = core.cleanKey(code);
  if (key.length !== 16) return null;
  return backend().joinInfo(key);
}
export async function claim(code, person) {
  await core.signIn();
  return backend().claim(core.cleanKey(code), person);
}
export const release = (id) => backend().release(id);
export const handoverCode = (id) => backend().handoverCode(id);
export async function takeOver(code) {
  const key = core.cleanKey(code);
  if (key.length !== 16) throw new CoreError("That code doesn't work any more.");
  return backend().takeOver(key);
}
export const addSection = (id, kind, title) => backend().addSection(id, kind, text(title || KINDS[kind]?.title, 60, "A section title"));
export const editSection = (section, title, byDay = false) => backend().editSection(section, text(title, 60, "A section title"), !!byDay);
export const orderSections = (id, ids) => backend().orderSections(id, ids);
export const lockSection = (section, locked) => backend().lockSection(section, !!locked);
export const deleteSection = (section) => backend().deleteSection(section);
export function saveNote(section, version, body) {
  const s = String(body ?? "").replace(/\r\n?/g, "\n");
  if (len(s) > 20000) throw new CoreError("Notes are up to 20,000 characters. Split them into another section.");
  return backend().saveNote(section, version, s);
}
export function addItem(section, fields) {
  const f = itemFields(fields);
  if (!f.title) throw new CoreError("Give it a title.");
  return backend().addItem(section, f);
}
export const editItem = (item, fields) => backend().editItem(item, itemFields(fields));
export const moveItem = (item, step) => backend().moveItem(item, step < 0 ? -1 : 1);
export const deleteItem = (item) => backend().deleteItem(item);
export const optOut = (item, kind) => backend().optOut(item, kind || null);
export const log = (id, before = null) => backend().log(id, before);

// ---------- the chat ----------
export const REACTIONS = ["👍", "❤️", "😂", "😮", "🙏", "🎉"];
function messageText(body) {
  const s = String(body ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/^[\s]+|[\s]+$/g, "");
  if (!s) throw new CoreError("Write something first.");
  if (len(s) > 2000) throw new CoreError("A message is up to 2000 characters.");
  if (/[\p{Cc}]/u.test(s.replace(/[\n\t]/g, ""))) throw new CoreError("That message has characters that can't be sent.");
  return s;
}
export const messages = (id, { about = null, before = null, limit = 50 } = {}) => backend().messages(id, about, before, limit);
export const threadCounts = (id) => backend().threadCounts(id);
export const latestMessage = (id) => backend().latestMessage(id);
export const sendMessage = (id, body, { replyTo = null, about = null, mentions = [] } = {}) =>
  backend().sendMessage(id, messageText(body), replyTo, about, mentions);
export const editMessage = (message, body) => backend().editMessage(message, messageText(body));
export const deleteMessage = (message) => backend().deleteMessage(message);
export function react(message, emoji, on) {
  if (!emoji || len(emoji) > 16 || BAD.test(emoji)) throw new CoreError("Pick an emoji.");
  return backend().react(message, emoji, !!on);
}
export const follow = (id, onChange) => app.watch(["changes", "messages", "reactions"].map((table) => ({ table, filter: `trip_id=eq.${id}` })), onChange);

// ---------- push notifications ----------
const KEY_URL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://127.0.0.1:8787/push/key" : "https://play.reclaude.junsaku.dev/push/key";
const PUSH_KEY = "trip-push-key"; // the server key this phone subscribed with
const appleMobile = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
export function pushSupport() {
  if (app.fake) return "ok";
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "ok";
  return appleMobile() && !standalone() ? "install" : "no";
}
const subscription = async () => (await (await navigator.serviceWorker.ready).pushManager.getSubscription());
async function serverKey() {
  const res = await fetch(KEY_URL);
  if (!res.ok) throw new CoreError("Notifications can't be set up right now. Try again later.");
  return (await res.json()).key;
}
const keyBytes = (k) => Uint8Array.from(atob(k.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((k.length + 3) % 4)), (c) => c.charCodeAt(0));
async function savePush(sub) {
  const j = sub.toJSON();
  await backend().savePush({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
}
async function subscribe() {
  const key = await serverKey();
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  let mine = null;
  try { mine = localStorage.getItem(PUSH_KEY); } catch {}
  if (sub && mine !== key) { await sub.unsubscribe().catch(() => {}); sub = null; } // the server's key changed
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  try { localStorage.setItem(PUSH_KEY, key); } catch {}
  await savePush(sub);
}
export async function pushState(id) {
  const support = pushSupport();
  const settings = await backend().pushSettings(id);
  if (app.fake) return { support, permission: "granted", on: settings.phones > 0, settings };
  if (support !== "ok") return { support, permission: "default", on: false, settings };
  const permission = Notification.permission;
  let on = false;
  try {
    on = permission === "granted" && !!(await subscription());
    if (on) await subscribe(); // keeps it saved for whoever's signed in now, and on the server's current key
  } catch { /* shown as off */ }
  return { support, permission, on, settings };
}
export async function enablePush(id) {
  if (app.fake) { await backend().savePush({ endpoint: "https://push.example/fake" }); return; }
  if (pushSupport() === "install") throw new CoreError("On iPhone, add Trip to your Home Screen first (Share, then Add to Home Screen), and turn them on there.");
  if (pushSupport() !== "ok") throw new CoreError("This browser can't show notifications.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new CoreError("Notifications are blocked. Allow them for this site in your browser's settings, then try again.");
  await subscribe();
  await backend().pushSettings(id);
}
export async function disablePush() {
  if (app.fake) { await backend().dropPush(); return; }
  const sub = await subscription().catch(() => null);
  if (!sub) return;
  await backend().dropPush(sub.endpoint).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
export const setPushSettings = (id, s) => backend().setPushSettings(id, s);
