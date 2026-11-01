// Pickleball's client (apps/pickleball/, its database in supabase/migrations/…_pickleball*.sql), built on
// core.app("pickleball"). Everything that changes something is a database function, which checks who may do it; these
// only fetch and send, and throw a CoreError with a message to show. With ?backend=fake: this browser only.
//   await pb.me()                       { id, account, manager }: this device's sign-in (no sign-up), and whether it manages
//   await pb.players()                  [{ id, name, icon, made_by }]                         (managers)
//   await pb.clubs()                    [{ id, name, players: [ids], managers: [ids] }]       (managers)
//   await pb.managers()                 [{ id, username, display_name, avatar }]: who can manage (managers)
//   await pb.sessions()                 open sessions: [{ id, club_id, courts, algorithm, watch_code, started_by, started_at }]
//   await pb.makePlayer(name, icon) / editPlayer(id, name, icon)          the new player's id / nothing
//   await pb.makeClub(name) / renameClub(club, name) / addClubPlayer(club, player) / removeClubPlayer(club, player)
//   await pb.addClubManager(club, user) / removeClubManager(club, user)
//   await pb.startSession({ club, courts, algorithm, players })          the new session's id
//   await pb.setSession(session, courts, algorithm) / setHere(session, player, here) / endSession(session)
//   await pb.helperCode(session)        a new helper code (the old one stops working)
//   await pb.becomeHelper(session, code)   signs this device in (anonymously, if it isn't) and returns the watch code
//   await pb.watch(code)                the live view: { id, club, courts, algorithm, state, version, started_at,
//                                       ended_at, players: [{ id, name, icon, here }], matches: [{ id, court, side_a,
//                                       side_b, started_at, ended_at, score_a, score_b }] } or null (no sign-in needed)
//   await pb.saveState(session, version, state, action, detail)   the new version (refused if it isn't `version`)
//   await pb.startMatch(session, court, a, b) / endMatch(match, scoreA, scoreB)
import * as core from "../shared/core.js";

const app = core.app("pickleball");
const { CoreError } = core;
const rpc = (fn, args) => app.run(app.db.rpc(fn, args));
const rows = (query) => app.run(query);
const cleanText = (text, max) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s && [...s].length <= max && !/[<>&\p{Cc}]/u.test(s) ? s : "";
};
const playerName = (name) => {
  const s = core.cleanName(name);
  if (!s) throw new CoreError("A name is 1 to 24 letters, numbers or emoji.");
  return s;
};
const clubName = (name) => {
  const s = cleanText(name, 40);
  if (!s) throw new CoreError("A club name is 1 to 40 characters, without < > &.");
  return s;
};
const icon = (text) => cleanText(text, 16) || "👤";

// ---------- live (Supabase) ----------
const live = {
  async players() { return rows(app.db.from("players").select("id, name, icon, made_by").order("name")); },
  async clubs() {
    const [clubs, players, managers] = await Promise.all([
      rows(app.db.from("clubs").select("id, name").order("name")),
      rows(app.db.from("club_players").select("club_id, player_id")),
      rows(app.db.from("club_managers").select("club_id, user_id")),
    ]);
    return clubs.map((c) => ({ ...c, players: players.filter((p) => p.club_id === c.id).map((p) => p.player_id),
      managers: managers.filter((m) => m.club_id === c.id).map((m) => m.user_id) }));
  },
  managers: () => rpc("managers"),
  sessions() {
    return rows(app.db.from("sessions").select("id, club_id, courts, algorithm, watch_code, started_by, started_at")
      .is("ended_at", null).order("started_at", { ascending: false }));
  },
  makePlayer: (name, icon) => rpc("make_player", { name, icon }),
  editPlayer: (player, name, icon) => rpc("edit_player", { player, name, icon }),
  makeClub: (name) => rpc("make_club", { name }),
  renameClub: (club, name) => rpc("rename_club", { club, name }),
  addClubPlayer: (club, player) => rpc("add_club_player", { club, player }),
  removeClubPlayer: (club, player) => rpc("remove_club_player", { club, player }),
  addClubManager: (club, target) => rpc("add_club_manager", { club, target }),
  removeClubManager: (club, target) => rpc("remove_club_manager", { club, target }),
  startSession: (club, courts, algorithm, players) => rpc("start_session", { club, courts, algorithm, players }),
  setSession: (session, courts, algorithm) => rpc("set_session", { session, courts, algorithm }),
  setHere: (session, player, here) => rpc("set_here", { session, player, here }),
  helperCode: (session) => rpc("helper_code", { session }),
  endSession: (session) => rpc("end_session", { session }),
  becomeHelper: (session, code) => rpc("become_helper", { session, code }),
  watch: (code) => rpc("watch", { code }),
  saveState: (session, version, state, action, detail) => rpc("save_state", { session, version, state, action, detail }),
  startMatch: (session, court, side_a, side_b) => rpc("start_match", { session, court, side_a, side_b }),
  endMatch: (match_id, score_a, score_b) => rpc("end_match", { match_id, score_a, score_b }),
};

// ---------- ?backend=fake: this browser only (the same checks, roughly) ----------
const no = (message) => { throw new CoreError(message); };
const newId = () => crypto.randomUUID();
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[b % 32]).join("");
function db() {
  const d = app.read();
  for (const k of ["players", "clubs", "sessions", "matches", "log"]) d[k] ||= [];
  return d;
}
async function who() { return (await core.signedIn())?.id || null; }
async function isManager() { return core.hasAppRole(await core.account(), "pickleball", "manager"); }
async function needManager() { if (!(await isManager())) no("Only a pickleball manager can do that."); return who(); }
async function needClub(d, club) {
  const me = await needManager();
  const c = d.clubs.find((x) => x.id === club);
  if (!c || !c.managers.includes(me)) no("Only this club's managers can do that.");
  return c;
}
async function runs(d, s) {
  const me = await who();
  return (await isManager()) && (s.started_by === me || !!d.clubs.find((c) => c.id === s.club_id)?.managers.includes(me));
}
async function needRunner(d, session) {
  const s = d.sessions.find((x) => x.id === session);
  if (!s || !(await runs(d, s))) no("Only the session's managers can do that.");
  if (s.ended_at) no("This session has ended.");
  return s;
}
async function needHelper(d, session) {
  const s = d.sessions.find((x) => x.id === session);
  if (!s) no("Only the session's managers and helpers can do that.");
  if (s.ended_at) no("This session has ended.");
  if (!(await runs(d, s)) && !s.helpers.includes(await who())) no("Only the session's managers and helpers can do that.");
  return s;
}
const bump = (s) => { s.version++; };
const now = () => new Date().toISOString();
const fake = {
  async players() { if (!(await isManager())) return []; return db().players.sort((a, b) => a.name.localeCompare(b.name)); },
  async clubs() { if (!(await isManager())) return []; return db().clubs.map(({ id, name, players, managers }) => ({ id, name, players, managers })); },
  async managers() {
    if (!(await isManager())) return [];
    let accounts = {};
    try { accounts = JSON.parse(localStorage.getItem("core-fake"))?.accounts || {}; } catch {}
    return Object.entries(accounts).filter(([, a]) => a.active !== false && ((a.roles || []).some((r) => r.role === "superuser")
      || (a.appRoles || []).some((r) => r.app === "pickleball" && r.role === "manager")))
      .map(([username, a]) => ({ id: a.id, username, display_name: a.profile?.display_name || null, avatar: a.profile?.avatar || null }));
  },
  async sessions() {
    if (!(await isManager())) return [];
    return db().sessions.filter((s) => !s.ended_at).map(({ id, club_id, courts, algorithm, watch_code, started_by, started_at }) =>
      ({ id, club_id, courts, algorithm, watch_code, started_by, started_at })).reverse();
  },
  async makePlayer(name, icon) {
    const me = await needManager();
    const d = db();
    const id = newId();
    d.players.push({ id, name, icon, made_by: me });
    app.write(d);
    return id;
  },
  async editPlayer(player, name, icon) {
    const me = await needManager();
    const d = db();
    const p = d.players.find((x) => x.id === player);
    if (!p || !(p.made_by === me || d.clubs.some((c) => c.players.includes(player) && c.managers.includes(me)))) {
      no("Only whoever added this player, or a manager of their club, can change them.");
    }
    Object.assign(p, { name, icon });
    app.write(d);
  },
  async makeClub(name) {
    const me = await needManager();
    const d = db();
    const id = newId();
    d.clubs.push({ id, name, players: [], managers: [me] });
    app.write(d);
    return id;
  },
  async renameClub(club, name) { const d = db(); (await needClub(d, club)).name = name; app.write(d); },
  async addClubPlayer(club, player) {
    const d = db();
    const c = await needClub(d, club);
    if (!c.players.includes(player)) c.players.push(player);
    app.write(d);
  },
  async removeClubPlayer(club, player) {
    const d = db();
    const c = await needClub(d, club);
    c.players = c.players.filter((p) => p !== player);
    app.write(d);
  },
  async addClubManager(club, target) {
    const d = db();
    const c = await needClub(d, club);
    if (!(await fake.managers()).some((m) => m.id === target)) no("Only an account with the pickleball manager role can manage a club.");
    if (!c.managers.includes(target)) c.managers.push(target);
    app.write(d);
  },
  async removeClubManager(club, target) {
    const d = db();
    const c = await needClub(d, club);
    if (!c.managers.some((m) => m !== target)) no("A club needs at least one manager.");
    c.managers = c.managers.filter((m) => m !== target);
    app.write(d);
  },
  async startSession(club, courts, algorithm, players) {
    const me = await needManager();
    const d = db();
    if (club) await needClub(d, club);
    const id = newId();
    d.sessions.push({ id, club_id: club, courts, algorithm, state: {}, version: 0, watch_code: newCode(), helper: null, helpers: [],
      started_by: me, started_at: now(), ended_at: null, here: [...new Set(players)].map((p) => ({ id: p, here: true })) });
    app.write(d);
    return id;
  },
  async setSession(session, courts, algorithm) {
    const d = db();
    const s = await needRunner(d, session);
    if (d.matches.some((m) => m.session_id === session && !m.ended_at && m.court > courts)) no("A match is still on a court you're removing.");
    Object.assign(s, { courts, algorithm });
    bump(s);
    app.write(d);
  },
  async setHere(session, player, here) {
    const d = db();
    const s = await needRunner(d, session);
    const row = s.here.find((x) => x.id === player);
    if (row) row.here = here; else s.here.push({ id: player, here });
    bump(s);
    app.write(d);
  },
  async helperCode(session) {
    const d = db();
    const s = await needRunner(d, session);
    s.helper = newCode();
    s.helpers = [];
    app.write(d);
    return s.helper;
  },
  async endSession(session) {
    const d = db();
    const s = await needRunner(d, session);
    for (const m of d.matches) if (m.session_id === session && !m.ended_at) m.ended_at = now();
    Object.assign(s, { ended_at: now(), helper: null, helpers: [] });
    bump(s);
    app.write(d);
  },
  async becomeHelper(session, code) {
    const { id: me } = await core.signIn();
    const d = db();
    const s = d.sessions.find((x) => x.id === session);
    if (!s || s.ended_at || !s.helper || s.helper !== core.cleanKey(code)) no("That helper code doesn't work. Ask for a new one.");
    if (!s.helpers.includes(me)) s.helpers.push(me);
    app.write(d);
    return s.watch_code;
  },
  async watch(code) {
    const d = db();
    const s = d.sessions.find((x) => x.watch_code === core.cleanKey(code));
    if (!s) return null;
    const ended = d.matches.filter((m) => m.session_id === s.id && m.ended_at).slice(-20).map((m) => m.id);
    return { id: s.id, club: d.clubs.find((c) => c.id === s.club_id)?.name || null, courts: s.courts, algorithm: s.algorithm,
      state: s.state, version: s.version, started_at: s.started_at, ended_at: s.ended_at,
      players: s.here.map((h) => ({ ...d.players.find((p) => p.id === h.id), here: h.here })).map(({ id, name, icon, here }) => ({ id, name, icon, here })),
      matches: d.matches.filter((m) => m.session_id === s.id && (!m.ended_at || ended.includes(m.id))) };
  },
  async saveState(session, version, state) {
    const d = db();
    const s = await needHelper(d, session);
    if (s.version !== version) no("Someone else just changed this. Showing the latest.");
    s.state = state;
    bump(s);
    app.write(d);
    return s.version;
  },
  async startMatch(session, court, a, b) {
    const d = db();
    const s = await needHelper(d, session);
    const everyone = [...(a || []), ...(b || [])];
    if (!a?.length || !b?.length || a.length > 2 || b.length > 2 || new Set(everyone).size !== everyone.length) no("Each side is one or two different players.");
    if (court < 1 || court > s.courts) no("There's no such court.");
    if (!everyone.every((p) => s.here.some((h) => h.id === p && h.here))) no("Everyone playing has to be here.");
    if (d.matches.some((m) => m.session_id === session && !m.ended_at && (m.court === court || [...m.side_a, ...m.side_b].some((p) => everyone.includes(p))))) {
      no("That court or someone in this match is already playing.");
    }
    const id = d.matches.length + 1;
    d.matches.push({ id, session_id: session, court, side_a: a, side_b: b, started_at: now(), ended_at: null, score_a: null, score_b: null });
    bump(s);
    app.write(d);
    return id;
  },
  async endMatch(match, scoreA, scoreB) {
    const d = db();
    const m = d.matches.find((x) => x.id === match);
    if (!m) no("There's no such match.");
    const s = await needHelper(d, m.session_id);
    if ((scoreA == null) !== (scoreB == null)) no("Give both scores, or neither.");
    Object.assign(m, { ended_at: m.ended_at || now(), score_a: scoreA, score_b: scoreB });
    bump(s);
    app.write(d);
  },
};

const backend = () => (app.fake ? fake : live);

// ---------- API ----------
export async function me() {
  const signed = await core.signedIn();
  const account = signed ? await core.account() : null;
  return { id: signed?.id || null, account, manager: core.hasAppRole(account, "pickleball", "manager") };
}
export const players = () => backend().players();
export const clubs = () => backend().clubs();
export const managers = () => backend().managers();
export const sessions = () => backend().sessions();
export const makePlayer = (name, emoji) => backend().makePlayer(playerName(name), icon(emoji));
export const editPlayer = (id, name, emoji) => backend().editPlayer(id, playerName(name), icon(emoji));
export const makeClub = (name) => backend().makeClub(clubName(name));
export const renameClub = (club, name) => backend().renameClub(club, clubName(name));
export const addClubPlayer = (club, player) => backend().addClubPlayer(club, player);
export const removeClubPlayer = (club, player) => backend().removeClubPlayer(club, player);
export const addClubManager = (club, user) => backend().addClubManager(club, user);
export const removeClubManager = (club, user) => backend().removeClubManager(club, user);
export function startSession({ club = null, courts, algorithm, players = [] }) {
  if (!(courts >= 1 && courts <= 20)) throw new CoreError("Pick 1 to 20 courts.");
  return backend().startSession(club, courts, algorithm, players);
}
export const setSession = (session, courts, algorithm) => backend().setSession(session, courts, algorithm);
export const setHere = (session, player, here) => backend().setHere(session, player, here);
export const helperCode = async (session) => core.formatKey(await backend().helperCode(session));
export const endSession = (session) => backend().endSession(session);
export async function becomeHelper(session, code) {
  if (!app.fake) await core.signIn();
  return backend().becomeHelper(session, core.cleanKey(code));
}
export async function watch(code) {
  const key = core.cleanKey(code);
  if (key.length !== 16) return null;
  return backend().watch(key);
}
export const saveState = (session, version, state, action, detail = null) => backend().saveState(session, version, state, action, detail);
export const startMatch = (session, court, a, b) => backend().startMatch(session, court, a, b);
export function endMatch(match, scoreA = null, scoreB = null) {
  const n = (x) => (x === "" || x == null ? null : Number(x));
  const [a, b] = [n(scoreA), n(scoreB)];
  if ([a, b].some((x) => x != null && !(Number.isInteger(x) && x >= 0 && x <= 99))) throw new CoreError("A score is a number from 0 to 99.");
  return backend().endMatch(match, a, b);
}
