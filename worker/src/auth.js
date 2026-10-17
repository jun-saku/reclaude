// Who is connecting, and are they seated in the room?
//
// A player proves who they are with their Firebase ID token (anonymous sign-in): a JWT signed by Google for the
// reclaude-67a01 project. The seat check reads the room from the Realtime Database's REST API as that player,
// with their App Check token, so the database's own rules and App Check decide what the server may see, exactly as
// for the player's own page. With the EMULATOR variable (local tests only, `npm run dev`), tokens come from the
// Auth emulator (unsigned) and rooms from the Database emulator.

const PROJECT = "reclaude-67a01";
const DATABASE = "https://reclaude-67a01-default-rtdb.asia-southeast1.firebasedatabase.app";
const EMULATOR_PROJECT = "demo-reclaude";
const EMULATOR_DATABASE = "http://127.0.0.1:9000";
const KEYS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

export class AuthError extends Error {}

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const jsonPart = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

// Google's signing keys change every few hours; keep them as long as Google says they're good for.
let keys = null, keysUntil = 0;
async function signingKey(kid) {
  if (!keys || Date.now() > keysUntil || !keys[kid]) {
    const res = await fetch(KEYS_URL);
    if (!res.ok) throw new AuthError("couldn't fetch Google's signing keys");
    const age = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") || "")?.[1] || 3600);
    keys = {};
    for (const k of (await res.json()).keys) keys[k.kid] = k;
    keysUntil = Date.now() + age * 1000;
  }
  const jwk = keys[kid];
  if (!jwk) throw new AuthError("unknown signing key");
  return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

// Checks a Firebase ID token and returns the player's uid.
export async function verifyIdToken(token, env) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new AuthError("not a token");
  let header, claims;
  try { header = jsonPart(parts[0]); claims = jsonPart(parts[1]); } catch { throw new AuthError("not a token"); }
  const emulator = env.EMULATOR === "1";
  const project = emulator ? EMULATOR_PROJECT : PROJECT;
  if (!emulator) {
    if (header.alg !== "RS256") throw new AuthError("wrong algorithm");
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", await signingKey(header.kid), b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) throw new AuthError("bad signature");
  }
  const now = Date.now() / 1000;
  if (claims.aud !== project || claims.iss !== `https://securetoken.google.com/${project}`) throw new AuthError("token for another project");
  if (!(claims.exp > now) || !(claims.iat <= now + 300)) throw new AuthError("token expired");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128) throw new AuthError("no user");
  return claims.sub;
}

// Reads rooms/<code> as the player (their ID token and App Check token), so the database rules apply.
export async function readRoom(code, idToken, appCheck, env) {
  if (!/^[A-HJ-NP-Z2-9]{4}$/.test(code)) throw new AuthError("bad room code");
  const emulator = env.EMULATOR === "1";
  const url = emulator
    ? `${EMULATOR_DATABASE}/rooms/${code}.json?ns=${EMULATOR_PROJECT}-default-rtdb&auth=${encodeURIComponent(idToken)}`
    : `${DATABASE}/rooms/${code}.json?auth=${encodeURIComponent(idToken)}`;
  const res = await fetch(url, { headers: appCheck ? { "X-Firebase-AppCheck": appCheck } : {} });
  if (!res.ok) throw new AuthError(`the database refused (${res.status})`);
  return res.json();
}

// The seat this uid holds in the room, or null.
export function seatIn(room, uid) {
  for (let i = 0; i < (room?.seats || 0); i++) if (room.players?.[`s${i}`] === uid) return i;
  return null;
}
