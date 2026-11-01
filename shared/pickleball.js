// Pickleball's client (apps/pickleball/, its database in supabase/migrations/…_pickleball*.sql), built on
// core.app("pickleball"). Everything that changes something is a database function, which checks who may do it; these
// only fetch and send, and throw a CoreError with a message to show. With ?backend=fake: this browser only.
//   await pb.me()                       { id, account, manager }: this device's sign-in (no sign-up), and whether it manages
//   await pb.players()                  [{ id, name, icon, made_by, guest }] (guest: made for one session) (managers)
//   await pb.clubs()                    [{ id, name, players: [ids], managers: [ids] }]       (managers)
//   await pb.managers()                 [{ id, username, display_name, avatar }]: who can manage (managers)
//   await pb.sessions()                 open sessions: [{ id, club_id, courts, algorithm, watch_code, started_by, started_at }]
//   await pb.pastSessions()             the last 20 ended ones, newest first (the same, and ended_at)
//   await pb.makePlayer(name, icon, guest) / editPlayer(id, name, icon) / keepPlayer(id)   the new player's id / – / –
//                                       (keepPlayer: a guest becomes a regular player)
//   await pb.makeClub(name) / renameClub(club, name) / addClubPlayer(club, player) / removeClubPlayer(club, player)
//   await pb.addClubManager(club, user) / removeClubManager(club, user)
//   await pb.startSession({ club, courts, algorithm, players, name })    the new session's id (name: optional)
//   await pb.renameSession(session, name)   its runners ("": no name)
//   await pb.setSession(session, courts, algorithm) / setHere(session, player, here) / endSession(session)
//   await pb.helperCode(session)        a new helper code (the old one stops working)
//   await pb.becomeHelper(session, code)   signs this device in (anonymously, if it isn't) and returns the watch code
//   await pb.watch(code)                the live view: { id, club, courts, algorithm, state, version, started_at,
//                                       ended_at, players: [{ id, name, icon, here }], matches: [{ id, court, side_a,
//                                       side_b, started_at, ended_at, score_a, score_b }] } or null (no sign-in needed)
//   await pb.saveState(session, version, state, action, detail)   the new version (refused if it isn't `version`)
//   await pb.startMatch(session, court, a, b) / endMatch(match, scoreA, scoreB)
// Linking an account to players (…_pickleball_links.sql):
//   await pb.linkCode(player)           managers: a one-time code (formatted) for that player, valid 7 days
//   await pb.linkPlayer(code)           an account links itself: the player { id, name, icon }
//   await pb.unlinkPlayer(player)       the linked account, or the player's managers
//   await pb.links()                    managers: [{ player_id, username, display_name, avatar }]
//   await pb.myGames()                  { players: [{ id, name, icon, sessions, matches, wins, minutes }],
//                                         sessions: [{ id, club, started_at, ended_at, watch_code, matches }] }
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
  async players() { return rows(app.db.from("players").select("id, name, icon, made_by, guest").order("name")); },
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
    return rows(app.db.from("sessions").select("id, name, club_id, courts, algorithm, watch_code, started_by, started_at")
      .is("ended_at", null).order("started_at", { ascending: false }));
  },
  pastSessions() {
    return rows(app.db.from("sessions").select("id, name, club_id, courts, algorithm, watch_code, started_by, started_at, ended_at")
      .not("ended_at", "is", null).order("ended_at", { ascending: false }).limit(20));
  },
  makePlayer: (name, icon, guest) => rpc("make_player", { name, icon, guest }),
  keepPlayer: (player) => rpc("keep_player", { player }),
  renameSession: (session, name) => rpc("rename_session", { session, name }),
  editPlayer: (player, name, icon) => rpc("edit_player", { player, name, icon }),
  makeClub: (name) => rpc("make_club", { name }),
  renameClub: (club, name) => rpc("rename_club", { club, name }),
  addClubPlayer: (club, player) => rpc("add_club_player", { club, player }),
  removeClubPlayer: (club, player) => rpc("remove_club_player", { club, player }),
  addClubManager: (club, target) => rpc("add_club_manager", { club, target }),
  removeClubManager: (club, target) => rpc("remove_club_manager", { club, target }),
  startSession: (club, courts, algorithm, players, name) => rpc("start_session", { club, courts, algorithm, players, name }),
  setSession: (session, courts, algorithm) => rpc("set_session", { session, courts, algorithm }),
  setHere: (session, player, here) => rpc("set_here", { session, player, here }),
  helperCode: (session) => rpc("helper_code", { session }),
  endSession: (session) => rpc("end_session", { session }),
  becomeHelper: (session, code) => rpc("become_helper", { session, code }),
  watch: (code) => rpc("watch", { code }),
  saveState: (session, version, state, action, detail) => rpc("save_state", { session, version, state, action, detail }),
  startMatch: (session, court, side_a, side_b) => rpc("start_match", { session, court, side_a, side_b }),
  endMatch: (match_id, score_a, score_b) => rpc("end_match", { match_id, score_a, score_b }),
  linkCode: (player) => rpc("link_code", { player }),
  linkPlayer: (code) => rpc("link_player", { code }),
  unlinkPlayer: (player) => rpc("unlink_player", { player }),
  links: () => rpc("links"),
  myGames: () => rpc("my_games"),
};

// ---------- ?backend=fake: this browser only (the same checks, roughly) ----------
const no = (message) => { throw new CoreError(message); };
const newId = () => crypto.randomUUID();
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[b % 32]).join("");
function db() {
  const d = app.read();
  for (const k of ["players", "clubs", "sessions", "matches", "log"]) d[k] ||= [];
  d.links ||= {}; // player id: user id
  d.linkCodes ||= {}; // code: { player, expires }
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
    return db().sessions.filter((s) => !s.ended_at).map(({ id, name, club_id, courts, algorithm, watch_code, started_by, started_at }) =>
      ({ id, name, club_id, courts, algorithm, watch_code, started_by, started_at })).reverse();
  },
  async pastSessions() {
    if (!(await isManager())) return [];
    return db().sessions.filter((s) => s.ended_at).map(({ id, name, club_id, courts, algorithm, watch_code, started_by, started_at, ended_at }) =>
      ({ id, name, club_id, courts, algorithm, watch_code, started_by, started_at, ended_at })).reverse().slice(0, 20);
  },
  async makePlayer(name, icon, guest) {
    const me = await needManager();
    const d = db();
    const id = newId();
    d.players.push({ id, name, icon, made_by: me, guest: !!guest });
    app.write(d);
    return id;
  },
  async keepPlayer(player) {
    const me = await needManager();
    const d = db();
    const p = d.players.find((x) => x.id === player);
    if (!p || !(p.made_by === me || d.clubs.some((c) => c.players.includes(player) && c.managers.includes(me)))) {
      no("Only whoever added this player, or a manager of their club, can do that.");
    }
    p.guest = false;
    app.write(d);
  },
  async renameSession(session, name) {
    const d = db();
    const s = await needRunner(d, session);
    s.name = name || null;
    bump(s);
    app.write(d);
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
    const p = d.players.find((x) => x.id === player);
    if (p) p.guest = false;
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
  async startSession(club, courts, algorithm, players, name) {
    const me = await needManager();
    const d = db();
    if (club) await needClub(d, club);
    const id = newId();
    d.sessions.push({ id, name: name || null, club_id: club, courts, algorithm, state: {}, version: 0, watch_code: newCode(), helper: null, helpers: [],
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
    return { id: s.id, name: s.name || null, club: d.clubs.find((c) => c.id === s.club_id)?.name || null, courts: s.courts, algorithm: s.algorithm,
      state: s.state, version: s.version, started_at: s.started_at, ended_at: s.ended_at,
      players: s.here.map((h) => ({ ...d.players.find((p) => p.id === h.id), here: h.here })).map(({ id, name, icon, here, guest }) => ({ id, name, icon, here, guest: !!guest })),
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
  async linkCode(player) {
    const me = await needManager();
    const d = db();
    const p = d.players.find((x) => x.id === player);
    if (!p || !(p.made_by === me || d.clubs.some((c) => c.players.includes(player) && c.managers.includes(me)))) {
      no("Only whoever added this player, or a manager of their club, can do that.");
    }
    if (d.links[player]) no("This player is already linked to an account.");
    for (const [k, v] of Object.entries(d.linkCodes)) if (v.player === player) delete d.linkCodes[k];
    const code = newCode();
    d.linkCodes[code] = { player, expires: Date.now() + 7 * 864e5 };
    app.write(d);
    return code;
  },
  async linkPlayer(code) {
    const acc = await core.account();
    if (!acc?.active) no("Sign in to your account first.");
    const d = db();
    const c = d.linkCodes[code];
    if (!c || c.expires < Date.now()) no("That code doesn't work. Ask for a new one.");
    delete d.linkCodes[code];
    d.links[c.player] = await who();
    app.write(d);
    const { id, name, icon } = d.players.find((x) => x.id === c.player);
    return { id, name, icon };
  },
  async unlinkPlayer(player) {
    const d = db();
    const me = await who();
    if (d.links[player] !== me && !(await isManager())) no("Only the linked account, or a manager of this player, can unlink it.");
    delete d.links[player];
    app.write(d);
  },
  async links() {
    if (!(await isManager())) return [];
    let accounts = {};
    try { accounts = JSON.parse(localStorage.getItem("core-fake"))?.accounts || {}; } catch {}
    return Object.entries(db().links).map(([player_id, uid]) => {
      const [username, a] = Object.entries(accounts).find(([, x]) => x.id === uid) || ["?", {}];
      return { player_id, username, display_name: a.profile?.display_name || null, avatar: a.profile?.avatar || null };
    });
  },
  async myGames() {
    const d = db();
    const me = await who();
    const mine = Object.entries(d.links).filter(([, uid]) => uid === me).map(([pid]) => pid);
    const done = d.matches.filter((m) => m.ended_at);
    const players = d.players.filter((p) => mine.includes(p.id)).map((p) => {
      const played = done.filter((m) => [...m.side_a, ...m.side_b].includes(p.id));
      return { id: p.id, name: p.name, icon: p.icon,
        sessions: d.sessions.filter((s) => s.here.some((h) => h.id === p.id)).length, matches: played.length,
        wins: played.filter((m) => m.score_a != null && m.score_a !== m.score_b && (m.score_a > m.score_b) === m.side_a.includes(p.id)).length,
        minutes: Math.round(played.reduce((n, m) => n + (new Date(m.ended_at) - new Date(m.started_at)) / 60000, 0)) };
    });
    const sessions = d.sessions.filter((s) => s.here.some((h) => mine.includes(h.id))).reverse().slice(0, 30).map((s) => ({
      id: s.id, name: s.name || null, club: d.clubs.find((c) => c.id === s.club_id)?.name || null, started_at: s.started_at, ended_at: s.ended_at, watch_code: s.watch_code,
      matches: done.filter((m) => m.session_id === s.id && [...m.side_a, ...m.side_b].some((x) => mine.includes(x))).length }));
    return { players, sessions };
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
export const pastSessions = () => backend().pastSessions();
export const makePlayer = (name, emoji, guest = false) => backend().makePlayer(playerName(name), icon(emoji), !!guest);
export const keepPlayer = (player) => backend().keepPlayer(player);
const sessionName = (name) => {
  const s = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if ([...s].length > 40 || /[<>&\p{Cc}]/u.test(s)) throw new CoreError("A session name is up to 40 characters, without < > &.");
  return s;
};
export const renameSession = (session, name) => backend().renameSession(session, sessionName(name));
export const editPlayer = (id, name, emoji) => backend().editPlayer(id, playerName(name), icon(emoji));
export const makeClub = (name) => backend().makeClub(clubName(name));
export const renameClub = (club, name) => backend().renameClub(club, clubName(name));
export const addClubPlayer = (club, player) => backend().addClubPlayer(club, player);
export const removeClubPlayer = (club, player) => backend().removeClubPlayer(club, player);
export const addClubManager = (club, user) => backend().addClubManager(club, user);
export const removeClubManager = (club, user) => backend().removeClubManager(club, user);
export function startSession({ club = null, courts, algorithm, players = [], name = null }) {
  if (!(courts >= 1 && courts <= 20)) throw new CoreError("Pick 1 to 20 courts.");
  return backend().startSession(club, courts, algorithm, players, sessionName(name));
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
export const linkCode = async (player) => core.formatKey(await backend().linkCode(player));
export async function linkPlayer(code) {
  const key = core.cleanKey(code);
  if (key.length !== 16) throw new CoreError("That code doesn't work. Ask for a new one.");
  return backend().linkPlayer(key);
}
export const unlinkPlayer = (player) => backend().unlinkPlayer(player);
export const links = () => backend().links();
export async function myGames() {
  if (!(await core.signedIn())) return { players: [], sessions: [] };
  return backend().myGames();
}
