// Unit test of the game server's sign-in check (worker/src/auth.js) as it runs live: Firebase ID tokens signed by
// Google. Signs tokens with a test key that stands in for Google's (fetch is faked), and checks that only a genuine,
// current token for reclaude-67a01 passes. Run: node tests/worker-auth.test.mjs   (no dependencies; CI's build job)
import { verifyIdToken, seatIn } from "../worker/src/auth.js";

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + m); };
const enc = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const alg = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const keyPair = async () => crypto.subtle.generateKey({ ...alg, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
const google = await keyPair(), stranger = await keyPair();
const jwk = { ...(await crypto.subtle.exportKey("jwk", google.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
globalThis.fetch = async (url) => {
  if (!String(url).includes("securetoken@system.gserviceaccount.com")) throw new Error("unexpected fetch " + url);
  return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "cache-control": "public, max-age=3600" } });
};
const now = Math.floor(Date.now() / 1000);
const good = { iss: "https://securetoken.google.com/reclaude-67a01", aud: "reclaude-67a01", sub: "player1", iat: now - 10, exp: now + 3600 };
async function token(claims, { key = google.privateKey, header = { alg: "RS256", kid: "k1", typ: "JWT" } } = {}) {
  const body = `${enc(header)}.${enc(claims)}`;
  const sig = Buffer.from(await crypto.subtle.sign(alg, key, new TextEncoder().encode(body))).toString("base64url");
  return `${body}.${sig}`;
}
const LIVE = {}, EMU = { EMULATOR: "1" };
const passes = async (t, env = LIVE) => { try { return await verifyIdToken(t, env); } catch { return null; } };

ok((await passes(await token(good))) === "player1", "a genuine, current token passes and gives the player's uid");
ok(!(await passes(await token(good, { key: stranger.privateKey }))), "a token signed by anyone else is refused");
ok(!(await passes(await token({ ...good, aud: "other-project", iss: "https://securetoken.google.com/other-project" }))), "a token for another Firebase project is refused");
ok(!(await passes(await token({ ...good, exp: now - 5 }))), "an expired token is refused");
ok(!(await passes(await token({ ...good, iat: now + 3600 }))), "a token issued in the future is refused");
ok(!(await passes(await token({ ...good, sub: "" }))), "a token without a user is refused");
ok(!(await passes(await token(good, { header: { alg: "RS256", kid: "nope" } }))), "a token naming an unknown key is refused");
const [h, b] = (await token(good)).split(".");
ok(!(await passes(`${h}.${enc({ ...good, sub: "someone-else" })}.${(await token(good)).split(".")[2]}`)), "a token with changed contents is refused");
const unsigned = `${enc({ alg: "none", typ: "JWT" })}.${b}.`;
ok(!(await passes(unsigned)), "an unsigned token is refused live");
ok(!(await passes(`${enc({ alg: "none" })}.${enc({ ...good, iss: "https://securetoken.google.com/demo-reclaude", aud: "demo-reclaude" })}.`)), "an emulator token is refused live");
ok((await passes(`${enc({ alg: "none" })}.${enc({ ...good, iss: "https://securetoken.google.com/demo-reclaude", aud: "demo-reclaude" })}.`, EMU)) === "player1", "the local test server (EMULATOR) accepts the Auth emulator's unsigned tokens");
ok(!(await passes(unsigned, EMU)), "but not tokens for the live project, even there");
ok(!(await passes("garbage")) && !(await passes(undefined)), "garbage is refused");
ok(seatIn({ seats: 3, players: { s0: "a", s2: "player1" } }, "player1") === 2 && seatIn({ seats: 2, players: { s0: "a" } }, "player1") === null, "seats are found from the room");

console.log(`\nFAILS: ${fails}`);
process.exit(fails ? 1 : 0);
