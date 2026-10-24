// The social apps' shared client (apps/<name>/, see CLAUDE.md "Supabase"): signs the person in and reads and writes
// their profile (core.profiles, supabase/migrations/). An app page imports it as ../../shared/core.js:
//   const me = await core.signIn()                  { id }: anonymous at first, remembered on this device
//   await core.signedIn()                           { id } if this device already signed in, else null (signs no one up)
//   await core.myProfile()                          { display_name, avatar }, or null before they make one (signs in)
//   await core.saveProfile({ display_name, avatar }) creates or updates it; throws a CoreError whose message can be shown
//   core.cleanName(text)                            the name as the database takes it, or "" if it can't be one
// It connects to the live project; on this machine (localhost, 127.0.0.1) to a local Supabase (`supabase start`,
// which the security policy allows too); with ?backend=fake to nothing: this browser's storage only, for the UI tests.
import { createClient } from "../shared/supabase-js.js";

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
export const myProfile = async () => (fake ? fakeRead().profile || null : supabaseMyProfile());
export async function saveProfile({ display_name, avatar }) {
  const name = cleanName(display_name);
  if (!name) throw new CoreError("That name can't be used. Try letters, numbers or emoji (up to 24).");
  const row = { display_name: name, avatar: cleanAvatar(avatar) };
  if (fake) { const db = fakeRead(); db.profile = row; fakeWrite(db); return; }
  await supabaseSaveProfile(row);
}
