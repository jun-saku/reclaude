// Who is entering a space (src/space.js)? Spaces are for accounts (supabase/migrations/…_core_accounts.sql), so a
// person proves who they are with their Supabase sign-in token, from shared/core.js.
//
// The server doesn't check the token's signature itself: it asks Supabase, as that person (their token, the public
// publishable key), for their account and profile. Supabase refuses a token it didn't sign, or an expired one, so
// once it answers, the token's claims are genuine. Its row level security decides what may be read, exactly as for
// the person's own page, and the account's `active` is read now, so a deactivated account (whose token can stay
// valid up to an hour) is refused at once. A space for a project role also asks core.has_app_role.
//
// When Supabase can't be reached (the free plan pauses an idle project), spaces are closed: SpaceDown. Games never
// come here. With the EMULATOR variable (local tests, `npm run dev`), the local stack (`supabase start`) is used.

const LIVE = { url: "https://xikukwpayubiyxcnlwme.supabase.co", key: "sb_publishable_Qqo7Kh391E381GR_zy9DVg_JImDyTVy" };
const LOCAL = { url: "http://127.0.0.1:54321", key: "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH" };
const ASK_MS = 5000; // Supabase not answering by then counts as down
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A reason to show the person; retrying won't help.
export class Refused extends Error {}
// Supabase is paused or down: try again later.
export class SpaceDown extends Error {}

function claimsOf(token) {
  try {
    const part = String(token).split(".")[1];
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
  } catch { return null; }
}

// Checks a Supabase access token against a space's access ("accounts", or "role:<app>/<role>") and returns
// { uid, name, avatar } (the account's profile, or its username), or throws Refused or SpaceDown.
export async function checkPerson(token, access, env) {
  const claims = typeof token === "string" && token.length <= 4096 ? claimsOf(token) : null;
  // Cheap checks first, so junk never costs a request to Supabase.
  if (!claims || claims.role !== "authenticated" || !UUID.test(claims.sub)) throw new Refused("Sign in first.");
  if (!(claims.exp > Date.now() / 1000)) throw new Refused("Your sign-in has expired. Reload the page.");
  if (claims.is_anonymous) throw new Refused("Only accounts can enter. Make one on your Profile page.");
  const { url, key } = env.EMULATOR === "1" ? LOCAL : LIVE;
  const headers = { apikey: key, Authorization: `Bearer ${token}`, "Accept-Profile": "core", "Content-Profile": "core" };
  const ask = async (path, body) => {
    let res;
    try {
      const signal = AbortSignal.timeout(ASK_MS);
      res = await fetch(`${url}/rest/v1/${path}`, body ? { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body), signal } : { headers, signal });
    } catch { throw new SpaceDown("Spaces are asleep right now. Try again later."); }
    if (res.status === 401 || res.status === 403) throw new Refused("Your sign-in wasn't accepted. Reload the page.");
    if (!res.ok) throw new SpaceDown("Spaces are asleep right now. Try again later.");
    return res.json();
  };
  const role = /^role:([a-z0-9_-]{1,40})\/([a-z0-9_-]{1,40})$/.exec(access);
  if (access !== "accounts" && !role) throw new Refused("This space isn't open.");
  const [accounts, profiles, allowed] = await Promise.all([
    ask(`accounts?select=username,active&id=eq.${claims.sub}`),
    ask(`profiles?select=display_name,avatar&id=eq.${claims.sub}`),
    role ? ask("rpc/has_app_role", { app: role[1], role: role[2] }) : true,
  ]);
  const account = Array.isArray(accounts) ? accounts[0] : null;
  if (!account) throw new Refused("Only accounts can enter. Make one on your Profile page.");
  if (account.active !== true) throw new Refused("This account is turned off.");
  if (allowed !== true) throw new Refused("This space is only for some people.");
  const profile = Array.isArray(profiles) ? profiles[0] : null;
  const name = typeof profile?.display_name === "string" && profile.display_name ? profile.display_name : String(account.username);
  const avatar = typeof profile?.avatar === "string" && profile.avatar ? profile.avatar : null;
  return { uid: claims.sub, name: name.slice(0, 40), avatar: avatar && avatar.slice(0, 32) };
}
