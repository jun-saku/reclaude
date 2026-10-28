// The social apps' shared client (apps/<name>/, see CLAUDE.md "Supabase"): your profile, kept on this device first
// (it works without Supabase: offline, paused or down) and backed up to Supabase (core.profiles,
// supabase/migrations/) when it can be. An app page imports it as ../../shared/core.js:
//   core.localProfile()                              this device's { display_name, avatar, pending }, or null
//   await core.loadProfile()                         that, or the one Supabase has for this device's sign-in (none: null)
//   await core.saveProfile({ display_name, avatar }) saves here (and the games' name, rooms.myName), then backs up:
//                                                    { backedUp }; throws a CoreError (a message to show) for a bad name
//   await core.backUpProfile()                       sends a profile Supabase doesn't have yet; true once it does
//   const me = await core.signIn()                   { id }: anonymous at first, remembered on this device
//   await core.signedIn()                            { id } if this device already signed in, else null (signs no one up)
//   await core.accessToken()                         this device's current sign-in token (for the game server's
//                                                    spaces, shared/space.js), or null (none, or ?backend=fake)
//   core.cleanName(text)                             the name as the database takes it, or "" if it can't be one
//   core.useProfile(profile)                         makes it this device's profile (and the games' name)
// Accounts (supabase/migrations/…_core_accounts.sql): a username and a personal key, to use your profile on other
// devices. Making one needs an invite code from a superuser; the key is made here and shown once:
//   await core.account()                             this device's account { username, active, roles }, or null
//   await core.makeAccount({ username, invite })     { username, key }: this device's sign-in becomes an account
//   await core.signInAccount({ username, key })      the account's profile, or null: this device signs in to it
//   await core.changeKey()                           { key }: a new key; your other devices are signed out
//   await core.signOut()                             this device signs out (its profile stays here)
//   core.cleanUsername(text), core.cleanKey(text), core.formatKey(key)  as the database takes them / shows them
// It connects to the live project; on this machine (localhost, 127.0.0.1) to a local Supabase (`supabase start`,
// which the security policy allows too); with ?backend=fake to nothing: this browser's storage only, for the UI tests.
import { createClient } from "../shared/supabase-js.js";
import { noteAccount, readMe, rememberMe } from "../shared/me.js";
import { ROOM_NAME_MAX, myName, setMyName } from "../shared/rooms.js";

const LIVE = { url: "https://xikukwpayubiyxcnlwme.supabase.co", key: "sb_publishable_Qqo7Kh391E381GR_zy9DVg_JImDyTVy" };
// The local stack's demo key: the same on every machine, public like the live one.
const LOCAL = { url: "http://127.0.0.1:54321", key: "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH" };

export class CoreError extends Error {}

// What the database refuses in names and avatars (supabase/migrations/…_core_profiles_clean_names.sql): < > &,
// control characters and invisible ones (direction overrides, zero-width spaces…). The zero-width joiner is fine.
const BAD = /[<>&\p{Cc}­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]/u;
const length = (s) => [...s].length; // as Postgres counts: code points
export function cleanName(text) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s && length(s) <= 24 && !BAD.test(s) ? s : "";
}
const cleanAvatar = (text) => {
  const s = String(text ?? "").trim();
  return s && length(s) <= 16 && !BAD.test(s) ? s : null;
};

// The problems a person can do something about, in words they can act on.
function explain(error) {
  if (!error) return null;
  if (error.code === "RCINV") return new CoreError("That invite code doesn't work. It may be used up or too old.");
  if (error.code === "RCTKN") return new CoreError("That username is taken. Try another.");
  if (error.code === "RCUSR") return new CoreError(USERNAME_RULE);
  if (error.code === "RCKEY") return new CoreError("That key can't be used. Try again.");
  if (error.code === "invalid_credentials") return new CoreError("That username and key don't match.");
  if (error.code === "user_banned") return new CoreError("This account is turned off. Ask the person who invited you.");
  if (error.code === "23514") return new CoreError("That name can't be used. Try letters, numbers or emoji (up to 24).");
  if (error.code === "42501") return new CoreError("You can only change your own profile.");
  if (/fetch|network|load failed/i.test(error.message || "") || error.name === "AuthRetryableFetchError") {
    return new CoreError("Can't reach the server. Check your connection and try again.");
  }
  return new CoreError("Something went wrong. Try again.");
}

// Accounts: usernames, and keys and invite codes (16 characters of Crockford base32, shown in groups of four).
const USERNAME_RULE = "A username is 3 to 20 lowercase letters, numbers or _.";
export const cleanUsername = (text) => {
  const s = String(text ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_]{2,19}$/.test(s) ? s : "";
};
// As core.clean_code() in the database: any case, dashes and spaces, O for 0, I or L for 1. Supabase's sign-in
// compares the key exactly, so it only ever gets it cleaned.
export const cleanKey = (text) => String(text ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
export const formatKey = (key) => cleanKey(key).match(/.{1,4}/g)?.join("-") || "";
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const newKey = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => ALPHABET[b % 32]).join("");
const accountEmail = (username) => `${username}@users.reclaude.invalid`;
function checkUsername(text) {
  const username = cleanUsername(text);
  if (!username) throw new CoreError(USERNAME_RULE);
  return username;
}

const fake = new URLSearchParams(location.search).get("backend") === "fake";
const local = ["localhost", "127.0.0.1"].includes(location.hostname);

// ---------- Supabase ----------
let client = null;
const sb = () => (client ||= createClient(local ? LOCAL.url : LIVE.url, local ? LOCAL.key : LIVE.key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
}));
let user = null;

async function supabaseSignedIn() {
  if (user) return user;
  try {
    const { data: { session } } = await sb().auth.getSession();
    if (session) user = { id: session.user.id };
  } catch {}
  return user;
}

async function supabaseSignIn() {
  if (await supabaseSignedIn()) return user;
  let result;
  try { result = await sb().auth.signInAnonymously(); } catch (err) { throw explain(err); }
  if (result.error) throw explain(result.error);
  user = { id: result.data.session.user.id };
  return user;
}

const profiles = () => sb().schema("core").from("profiles");

async function supabaseAccount() {
  const me = await supabaseSignedIn();
  if (!me) return null;
  const [account, roles] = await Promise.all([
    sb().schema("core").from("accounts").select("username, active").eq("id", me.id).maybeSingle(),
    sb().schema("core").from("roles").select("role, scope").eq("user_id", me.id),
  ]);
  if (account.error) throw explain(account.error);
  return account.data && { ...account.data, roles: roles.data || [] };
}

async function supabaseMakeAccount(username, invite) {
  await supabaseSignIn();
  const key = newKey();
  const { error } = await sb().schema("core").rpc("make_account", { username, key, invite });
  if (error) throw explain(error);
  await sb().auth.refreshSession(); // (its sign-in token still says anonymous)
  return key;
}

async function supabaseSignInAccount(username, key) {
  let result;
  try {
    result = await sb().auth.signInWithPassword({ email: accountEmail(username), password: cleanKey(key) });
  } catch (err) { throw explain(err); }
  if (result.error) throw explain(result.error);
  user = { id: result.data.user.id };
  const { data } = await profiles().select("display_name, avatar").eq("id", user.id).maybeSingle();
  return data || null;
}

async function supabaseChangeKey() {
  const key = newKey();
  const { error } = await sb().schema("core").rpc("change_key", { key });
  if (error) throw explain(error);
  return key;
}

async function supabaseSignOut() {
  try { await sb().auth.signOut({ scope: "local" }); } catch {}
  user = null;
}

async function supabaseMyProfile() {
  const { id } = await supabaseSignIn();
  const { data, error } = await profiles().select("display_name, avatar").eq("id", id).maybeSingle();
  if (error) throw explain(error);
  return data;
}

async function supabaseSaveProfile(row) {
  const { id } = await supabaseSignIn();
  // Update first; a person without a profile yet gets one (its id is theirs by default: the rules allow no other).
  const updated = await profiles().update(row).eq("id", id).select("id");
  if (updated.error) throw explain(updated.error);
  if (updated.data.length) return;
  const { error } = await profiles().insert(row);
  if (error) throw explain(error);
}

// ---------- ?backend=fake: this browser only ----------
const FAKE_KEY = "core-fake";
const fakeRead = () => { try { return JSON.parse(localStorage.getItem(FAKE_KEY)) || {}; } catch { return {}; } };
const fakeWrite = (db) => { try { localStorage.setItem(FAKE_KEY, JSON.stringify(db)); } catch {} };
async function fakeSignIn() {
  const db = fakeRead();
  if (!db.id) { db.id = crypto.randomUUID(); fakeWrite(db); }
  return { id: db.id };
}
// Accounts here: any 16-character invite code works, and accounts live in this browser only.
const fakeAccount = (db = fakeRead()) => Object.entries(db.accounts || {}).find(([, a]) => a.id === db.id);
const fakeAccounts = {
  account() {
    const found = fakeAccount();
    return found && { username: found[0], active: found[1].active !== false, roles: found[1].roles || [] };
  },
  async makeAccount(username, invite) {
    const { id } = await fakeSignIn();
    const db = fakeRead();
    db.accounts ||= {};
    if (fakeAccount(db)) throw new CoreError("This device already has an account.");
    if (cleanKey(invite).length !== 16) throw explain({ code: "RCINV" });
    if (db.accounts[username]) throw explain({ code: "RCTKN" });
    // The first account here is the superuser; a fake invite made in the admin panel gives its role.
    const inv = (db.invites || []).find((i) => i.code === cleanKey(invite) && !i.used_at && !i.cancelled);
    if (inv) Object.assign(inv, { used_by: id, used_at: new Date().toISOString(), code: null });
    const roles = !Object.keys(db.accounts).length ? [{ role: "superuser", scope: "*" }] : inv?.role ? [{ role: inv.role, scope: inv.scope }] : [];
    const key = newKey();
    db.accounts[username] = { id, key, profile: db.profile || null, roles, active: true, created_at: new Date().toISOString() };
    fakeWrite(db);
    return key;
  },
  signInAccount(username, key) {
    const db = fakeRead();
    const a = db.accounts?.[username];
    if (!a || a.key !== cleanKey(key)) throw explain({ code: "invalid_credentials" });
    if (a.active === false) throw explain({ code: "user_banned" });
    db.id = a.id;
    db.profile = a.profile;
    fakeWrite(db);
    return a.profile || null;
  },
  changeKey() {
    const db = fakeRead();
    const found = fakeAccount(db);
    if (!found) throw new CoreError("Only an account can change its key.");
    found[1].key = newKey();
    fakeWrite(db);
    return found[1].key;
  },
  signOut() {
    const db = fakeRead();
    const found = fakeAccount(db);
    if (found) found[1].profile = db.profile || null;
    delete db.id;
    delete db.profile;
    fakeWrite(db);
  },
};

// ---------- API ----------
export const signIn = () => (fake ? fakeSignIn() : supabaseSignIn());
export const signedIn = async () => (fake ? (fakeRead().id ? { id: fakeRead().id } : null) : supabaseSignedIn());
export async function accessToken() {
  if (fake) return null;
  try { return (await sb().auth.getSession()).data.session?.access_token || null; } catch { return null; }
}
// The profile name as the games take it (up to ROOM_NAME_MAX UTF-16 units, as rooms.js and the Firebase rules count):
// a longer one is cut at a word break if it can be, and never inside an emoji.
function gameName(name) {
  if (name.length <= ROOM_NAME_MAX) return name;
  const space = name.slice(0, ROOM_NAME_MAX + 1).lastIndexOf(" ");
  if (space > 0) return name.slice(0, space);
  let cut = name.slice(0, ROOM_NAME_MAX);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

// Local first: your profile lives on this device (shared/me.js, which also feeds the profile icon) and works with no
// network and with Supabase paused or down; Supabase keeps a copy (a backup, and for the apps), sent when it can be.
// The name also becomes the one the games use (rooms.myName, every game's "Your name").

// This device's profile: { display_name, avatar, pending } (pending: Supabase doesn't have it yet), or null.
export const localProfile = () => readMe();

// For a device with no profile of its own: the one Supabase has for this device's sign-in, if there is one (it signs
// no one up). null when there's none, or Supabase can't be reached.
export async function loadProfile() {
  if (readMe()) return readMe();
  try {
    if (!(await signedIn())) return null;
    const profile = fake ? fakeRead().profile || null : await supabaseMyProfile();
    if (!profile) return null;
    rememberMe(profile);
    if (!myName()) setMyName(gameName(profile.display_name));
    return readMe();
  } catch {
    return null;
  }
}

// Saves on this device straight away (so it always works), then backs it up to Supabase if it can.
// Throws a CoreError (with a message to show) only for a name that can't be used.
export async function saveProfile({ display_name, avatar }) {
  const name = cleanName(display_name);
  if (!name) throw new CoreError("That name can't be used. Try letters, numbers or emoji (up to 24).");
  const row = { display_name: name, avatar: cleanAvatar(avatar) };
  rememberMe({ ...row, pending: true });
  setMyName(gameName(name));
  return { backedUp: await backUpProfile() };
}

// Makes this one this device's profile (and the games' name): e.g. an account's, after signing in to it.
export function useProfile(profile) {
  rememberMe({ display_name: profile.display_name, avatar: profile.avatar || null });
  setMyName(gameName(profile.display_name));
}

// Sends this device's profile to Supabase if it hasn't got it yet (signing in for that). true once Supabase has it,
// false if it can't be reached now (the next save or visit to the profile page tries again). Never throws.
export async function backUpProfile() {
  const me = readMe();
  if (!me?.pending) return !!me;
  const row = { display_name: me.display_name, avatar: me.avatar || null };
  try {
    if (fake) { const db = fakeRead(); db.profile = row; fakeWrite(db); } else await supabaseSaveProfile(row);
  } catch {
    return false;
  }
  const now = readMe(); // (unless it changed meanwhile: that change is still to be sent)
  if (now && now.display_name === row.display_name && (now.avatar || null) === row.avatar) rememberMe(row);
  return true;
}

// ---------- accounts ----------

// This device's account ({ username, active, roles: [{ role, scope }] }), or null (none, or Supabase unreachable).
// Signs no one up.
export async function account() {
  let acc;
  try { acc = fake ? fakeAccounts.account() : await supabaseAccount(); } catch { return null; }
  noteAccount(acc?.active ? acc.username : null); // (only when the answer is sure: not when Supabase is unreachable)
  return acc;
}

// This device's sign-in (anonymous; made now if there's none) becomes an account, keeping its profile. Returns the
// new key, to show once. Throws a CoreError (a message to show) for a bad username or invite code.
export async function makeAccount({ username, invite }) {
  const name = checkUsername(username);
  if (!cleanKey(invite)) throw explain({ code: "RCINV" });
  const key = fake ? await fakeAccounts.makeAccount(name, invite) : await supabaseMakeAccount(name, invite);
  noteAccount(name);
  if (readMe()?.pending) await backUpProfile();
  return { username: name, key: formatKey(key) };
}

// Signs this device in to an account (instead of its anonymous sign-in). Returns the account's profile, or null if
// it has none yet; the page decides whether it replaces this device's (useProfile) or this device's is kept
// (saveProfile). Throws a CoreError for a wrong username or key.
export async function signInAccount({ username, key }) {
  const name = cleanUsername(username);
  if (!name || cleanKey(key).length !== 16) throw explain({ code: "invalid_credentials" });
  const profile = await (fake ? fakeAccounts.signInAccount(name, key) : supabaseSignInAccount(name, key));
  noteAccount(name);
  return profile;
}

// A new key for this device's account, to show once; the account's other devices are signed out.
export async function changeKey() {
  return { key: formatKey(fake ? fakeAccounts.changeKey() : await supabaseChangeKey()) };
}

// Signs this device out of its account. Its profile stays here (and in the games).
export async function signOut() {
  if (fake) fakeAccounts.signOut(); else await supabaseSignOut();
  noteAccount(null);
}

// ---------- admin panel (apps/admin/) ----------
// What admins and superusers can do. The database checks every call (supabase/migrations/…_core_accounts.sql and
// …_core_invite_codes.sql); these only fetch and send. Each throws a CoreError with a message to show.
//   isAdmin(account) / isSuperuser(account)    from core.account()'s roles
//   await admin.invites()                       [{ id, code, note, role, scope, made_at, expires_at, used_at, used_by: person }]
//   await admin.makeInvite({ note, days, role, scope })   the new code (formatted)
//   await admin.cancelInvite(id)
//   await admin.accounts()                      admins: [{ id, username, active, created_at, role (core: "admin",
//                                               "superuser" or null), appRoles: [{ app, role }], display_name, avatar }]
//   await admin.setActive(id, active), admin.resetKey(id) (the new key), admin.editAccount(id, { username, display_name, avatar })
//                                               superusers
//   await admin.apps()                          the projects and their roles: [{ name, title, roles: [{ role, title }] }]
//   await admin.setRole(id, role), admin.removeRole(id)                  superusers: the core role, "admin" or "superuser"
//   await admin.giveAppRole(id, app, role), admin.removeAppRole(id, app, role)   admins: a project's role
//   await admin.log({ before })                 superusers: audit entries, newest first, LOG_PAGE at a time (before: an
//                                               entry's id, for the page after it)
// (person: { display_name, avatar, username? } or null.)
const ADMIN_ROLES = ["admin", "superuser"];
export const LOG_PAGE = 25;
export const isAdmin = (acc) => !!acc?.active && !!acc.roles?.some((r) => ADMIN_ROLES.includes(r.role));
export const isSuperuser = (acc) => !!acc?.active && !!acc.roles?.some((r) => r.role === "superuser");

// The database's own messages for refusals are written to be shown; anything else gets explain()'s.
function adminError(error) {
  if (["42501", "22023", "P0002"].includes(error?.code) && error.message && !/permission denied|row-level/i.test(error.message)) {
    return new CoreError(error.message);
  }
  if (error?.code === "42501") return new CoreError("Only an admin can do that.");
  return explain(error);
}
const core = () => sb().schema("core");
async function call(fn, args) {
  let result;
  try { result = await core().rpc(fn, args); } catch (err) { throw adminError(err); }
  if (result.error) throw adminError(result.error);
  return result.data;
}
async function rows(query) {
  let result;
  try { result = await query; } catch (err) { throw adminError(err); }
  if (result.error) throw adminError(result.error);
  return result.data || [];
}
// Names and avatars (and usernames, for superusers) of these people, by id.
async function people(ids) {
  ids = [...new Set(ids.filter(Boolean))];
  if (!ids.length) return {};
  const [profs, accs] = await Promise.all([
    rows(profiles().select("id, display_name, avatar").in("id", ids)),
    rows(core().from("accounts").select("id, username").in("id", ids)),
  ]);
  const out = {};
  for (const p of profs) out[p.id] = { display_name: p.display_name, avatar: p.avatar };
  for (const a of accs) out[a.id] = { display_name: a.username, ...out[a.id], username: a.username };
  return out;
}

const supabaseAdmin = {
  async invites() {
    const list = await rows(core().from("invites")
      .select("id, code, note, role, scope, made_by, made_at, expires_at, used_by, used_at").order("made_at", { ascending: false }).limit(200));
    const who = await people(list.flatMap((i) => [i.used_by, i.made_by]));
    return list.map((i) => ({ ...i, used_by: who[i.used_by] || null, made_by: who[i.made_by] || null }));
  },
  makeInvite: ({ note, days, role, scope }) => call("make_invite", { role: role || null, scope: scope || "*", days, note: note || null }),
  cancelInvite: (id) => call("cancel_invite", { invite_id: id }),
  async accounts() {
    const [accs, roles, appRoles] = await Promise.all([
      rows(core().from("accounts").select("id, username, active, created_at").order("created_at")),
      rows(core().from("roles").select("user_id, role")),
      rows(core().from("app_roles").select("user_id, app, role").order("app").order("role")),
    ]);
    const profs = await rows(profiles().select("id, display_name, avatar").in("id", accs.map((a) => a.id)));
    return accs.map((a) => ({
      ...a, role: roles.find((r) => r.user_id === a.id)?.role || null,
      appRoles: appRoles.filter((r) => r.user_id === a.id).map(({ app, role }) => ({ app, role })),
      display_name: profs.find((p) => p.id === a.id)?.display_name || null, avatar: profs.find((p) => p.id === a.id)?.avatar || null,
    }));
  },
  async apps() {
    const [apps, names] = await Promise.all([
      rows(core().from("apps").select("name, title").order("title")),
      rows(core().from("app_role_names").select("app, role, title").order("title")),
    ]);
    return apps.map((a) => ({ ...a, roles: names.filter((n) => n.app === a.name).map(({ role, title }) => ({ role, title })) }));
  },
  setActive: (id, active) => call("set_active", { target: id, make_active: active }),
  setRole: (id, role) => call("set_role", { target: id, role }),
  removeRole: (id) => call("remove_role", { target: id }),
  giveAppRole: (id, app, role) => call("give_app_role", { target: id, app, role }),
  removeAppRole: (id, app, role) => call("remove_app_role", { target: id, app, role }),
  resetKey: (id) => call("reset_key", { target: id }),
  editAccount: (id, { username, display_name, avatar }) =>
    call("edit_account", { target: id, new_username: username || null, new_display_name: display_name || null, new_avatar: avatar || null }),
  async log(before) {
    let query = core().from("audit").select("id, at, actor, action, target, detail").order("id", { ascending: false }).limit(LOG_PAGE);
    if (before) query = query.lt("id", before);
    const list = await rows(query);
    const who = await people(list.flatMap((e) => [e.actor, e.target]));
    return list.map((e) => ({ ...e, actor: who[e.actor] || null, target: who[e.target] || null }));
  },
};

// ?backend=fake: invites, accounts and a log in this browser, as the database would answer (roughly).
const fakeAdmin = {
  me() {
    const found = fakeAccount();
    if (!found || !isAdmin({ active: found[1].active !== false, roles: found[1].roles })) throw new CoreError("Only an admin can do that.");
    return found;
  },
  logged(db, action, target, detail = {}) {
    (db.log ||= []).unshift({ id: (db.log[0]?.id || 0) + 1, at: new Date().toISOString(), actor: fakeAccount(db)?.[1].id, action, target, detail });
  },
  person(db, id) {
    const found = Object.entries(db.accounts || {}).find(([, a]) => a.id === id);
    return found ? { display_name: found[1].profile?.display_name || found[0], avatar: found[1].profile?.avatar || null, username: found[0] } : null;
  },
  invites() {
    this.me();
    const db = fakeRead();
    return (db.invites || []).map((i) => ({ ...i, used_by: this.person(db, i.used_by), made_by: this.person(db, i.made_by) }));
  },
  makeInvite({ note, days, role, scope }) {
    const [, me] = this.me();
    if (role && !isSuperuser({ active: true, roles: me.roles })) throw new CoreError("Only a superuser can make invites that give a role.");
    const db = fakeRead();
    const code = newKey();
    const now = Date.now();
    (db.invites ||= []).unshift({ id: (db.invites[0]?.id || 0) + 1, code, note: note || null, role: role || null, scope: scope || "*",
      made_by: me.id, made_at: new Date(now).toISOString(), expires_at: new Date(now + days * 864e5).toISOString(), used_at: null });
    this.logged(db, "made invite", null, { note, role, days });
    fakeWrite(db);
    return code;
  },
  cancelInvite(id) {
    this.me();
    const db = fakeRead();
    const inv = (db.invites || []).find((i) => i.id === id);
    if (inv && !inv.used_at) Object.assign(inv, { expires_at: new Date().toISOString(), code: null });
    this.logged(db, "cancelled invite", null, { invite: id });
    fakeWrite(db);
  },
  super() {
    const found = this.me();
    if (!isSuperuser({ active: true, roles: found[1].roles })) throw new CoreError("Only a superuser can do that.");
    return found;
  },
  accounts() {
    this.me();
    return Object.entries(fakeRead().accounts || {}).map(([username, a]) => ({ id: a.id, username, active: a.active !== false,
      created_at: a.created_at, role: a.roles?.[0]?.role || null, appRoles: a.appRoles || [],
      display_name: a.profile?.display_name || null, avatar: a.profile?.avatar || null }));
  },
  // A made-up project, so the panel's project roles can be tried here.
  apps() {
    return [{ name: "pickleball", title: "Pickleball", roles: [{ role: "organiser", title: "Organiser" }, { role: "scorekeeper", title: "Scorekeeper" }] }];
  },
  change(id, fn, who = "super") {
    const [, me] = this[who]();
    const db = fakeRead();
    const found = Object.entries(db.accounts || {}).find(([, a]) => a.id === id);
    if (!found) throw new CoreError("There's no such account.");
    const out = fn(db, found, me);
    fakeWrite(db);
    return out;
  },
  setActive(id, active) {
    return this.change(id, (db, [, a], me) => {
      if (a.id === me.id) throw new CoreError("You can't deactivate your own account.");
      a.active = active;
      this.logged(db, active ? "reactivated" : "deactivated", id);
    });
  },
  setRole(id, role) {
    return this.change(id, (db, [, a], me) => {
      if (a.id === me.id) throw new CoreError("You can't change your own roles.");
      a.roles = [{ role, scope: "*" }];
      this.logged(db, "gave role", id, { app: "core", role });
    });
  },
  removeRole(id) {
    return this.change(id, (db, [, a], me) => {
      if (a.id === me.id) throw new CoreError("You can't change your own roles.");
      const gone = a.roles?.[0];
      a.roles = [];
      if (gone) this.logged(db, "removed role", id, { app: "core", role: gone.role });
    });
  },
  giveAppRole(id, app, role) {
    return this.change(id, (db, [, a], me) => {
      if (a.id === me.id) throw new CoreError("You can't change your own roles.");
      if (!this.apps().some((p) => p.name === app && p.roles.some((r) => r.role === role))) throw new CoreError("That project has no such role.");
      if ((a.appRoles ||= []).some((r) => r.app === app && r.role === role)) return;
      a.appRoles.push({ app, role });
      this.logged(db, "gave role", id, { app, role });
    }, "me");
  },
  removeAppRole(id, app, role) {
    return this.change(id, (db, [, a], me) => {
      if (a.id === me.id) throw new CoreError("You can't change your own roles.");
      const before = (a.appRoles || []).length;
      a.appRoles = (a.appRoles || []).filter((r) => !(r.app === app && r.role === role));
      if (a.appRoles.length < before) this.logged(db, "removed role", id, { app, role });
    }, "me");
  },
  resetKey(id) {
    return this.change(id, (db, [, a], me) => {
      if (a.id === me.id) throw new CoreError("Change your own key from your profile.");
      a.key = newKey();
      this.logged(db, "reset key", id);
      return a.key;
    });
  },
  editAccount(id, { username, display_name, avatar }) {
    return this.change(id, (db, [old, a]) => {
      if (username && username !== old) {
        if (db.accounts[username]) throw explain({ code: "RCTKN" });
        delete db.accounts[old];
        db.accounts[username] = a;
      }
      if (a.profile && (display_name || avatar)) Object.assign(a.profile, display_name ? { display_name } : {}, avatar ? { avatar } : {});
      this.logged(db, "edited account", id);
    });
  },
  log(before) {
    this.super();
    const db = fakeRead();
    return (db.log || []).filter((e) => !before || e.id < before).slice(0, LOG_PAGE)
      .map((e) => ({ ...e, actor: this.person(db, e.actor), target: this.person(db, e.target) }));
  },
};

const backend = () => (fake ? fakeAdmin : supabaseAdmin);
export const admin = {
  invites: async () => backend().invites(),
  async makeInvite({ note, days = 7, role = null, scope = "*" } = {}) {
    const text = String(note ?? "").replace(/\s+/g, " ").trim();
    if (text && (text.length > 60 || /[<>&\p{Cc}]/u.test(text))) throw new CoreError("A note is up to 60 characters, without < > &.");
    return formatKey(await backend().makeInvite({ note: text || null, days, role, scope }));
  },
  cancelInvite: async (id) => { await backend().cancelInvite(id); },
  accounts: async () => backend().accounts(),
  setActive: async (id, active) => { await backend().setActive(id, active); },
  resetKey: async (id) => formatKey(await backend().resetKey(id)),
  apps: async () => backend().apps(),
  async setRole(id, role) {
    if (!["admin", "superuser"].includes(role)) throw new CoreError("Pick a role.");
    await backend().setRole(id, role);
  },
  removeRole: async (id) => { await backend().removeRole(id); },
  giveAppRole: async (id, app, role) => { await backend().giveAppRole(id, app, role); },
  removeAppRole: async (id, app, role) => { await backend().removeAppRole(id, app, role); },
  async editAccount(id, { username, display_name, avatar } = {}) {
    const name = display_name == null ? null : cleanName(display_name);
    if (display_name != null && !name) throw new CoreError("That name can't be used. Try letters, numbers or emoji (up to 24).");
    await backend().editAccount(id, { username: username == null ? null : checkUsername(username), display_name: name, avatar });
  },
  log: async ({ before } = {}) => backend().log(before),
};
