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
//   core.cleanName(text)                             the name as the database takes it, or "" if it can't be one
// It connects to the live project; on this machine (localhost, 127.0.0.1) to a local Supabase (`supabase start`,
// which the security policy allows too); with ?backend=fake to nothing: this browser's storage only, for the UI tests.
import { createClient } from "../shared/supabase-js.js";
import { readMe, rememberMe } from "../shared/me.js";
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
  if (error.code === "23514") return new CoreError("That name can't be used. Try letters, numbers or emoji (up to 24).");
  if (error.code === "42501") return new CoreError("You can only change your own profile.");
  if (/fetch|network|load failed/i.test(error.message || "") || error.name === "AuthRetryableFetchError") {
    return new CoreError("Can't reach the server. Check your connection and try again.");
  }
  return new CoreError("Something went wrong. Try again.");
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

// ---------- API ----------
export const signIn = () => (fake ? fakeSignIn() : supabaseSignIn());
export const signedIn = async () => (fake ? (fakeRead().id ? { id: fakeRead().id } : null) : supabaseSignedIn());
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
