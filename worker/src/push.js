// Web Push for Trip's notifications (apps/trip/, supabase/migrations/…_trip_push.sql), with nothing but WebCrypto:
//   GET  /push/key   the server's public key (VAPID, base64url), which pages subscribe with
//   POST /push/send  from the database only (Authorization: Bearer <PUSH_SECRET>): { pushes: [{ endpoint, p256dh, auth }],
//                    payload: { title, body, url, tag } } → each phone gets the payload, encrypted for it (RFC 8291,
//                    aes128gcm) and signed by this server (RFC 8292, VAPID). Answers { sent, gone: [endpoints] }.
// The key pair is made by the server itself the first time and kept in a Durable Object (PushKeys), so no one ever
// handles the private key. If it's ever lost, a new one is made and phones subscribe again when Trip next opens.
// (This file has no Workers-only imports, so tests/push.test.mjs runs it in Node.)

const enc = new TextEncoder();
export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// A new VAPID key pair: { publicKey: base64url of the 65-byte point, jwk: the private key }.
export async function makeKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { publicKey: b64url(await crypto.subtle.exportKey("raw", pair.publicKey)), jwk: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

// The payload encrypted for one subscription (RFC 8291, one aes128gcm record).
export async function encrypt(payload, p256dh, auth) {
  const uaPublic = unb64url(p256dh), authSecret = unb64url(auth);
  const ua = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const mine = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", mine.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ua }, mine.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key,
    concat(enc.encode(typeof payload === "string" ? payload : JSON.stringify(payload)), new Uint8Array([2]))));
  const header = new Uint8Array(21);
  new DataView(header.buffer).setUint32(16, 4096);
  header.set(salt, 0);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}

// The VAPID Authorization header for a push service (its origin), valid 12 hours.
export async function vapid(endpoint, keys, subject = "https://reclaude.junsaku.dev") {
  const head = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", keys.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64url(sig)}, k=${keys.publicKey}`;
}

// Sends one push; true if delivered, "gone" if the phone unsubscribed (404/410), false otherwise.
export async function sendOne(sub, payload, keys, fetcher = fetch) {
  try {
    const res = await fetcher(sub.endpoint, {
      method: "POST",
      headers: { Authorization: await vapid(sub.endpoint, keys), TTL: "86400", Urgency: "normal",
        "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream" },
      body: await encrypt(payload, sub.p256dh, sub.auth),
    });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok;
  } catch { return false; }
}

// The key pair, kept in a Durable Object's storage (PushKeys in index.js): made the first time it's asked for.
export async function storedKeys(storage) {
  let keys = await storage.get("keys");
  if (!keys) { keys = await makeKeys(); await storage.put("keys", keys); }
  return keys;
}

const SITE = [/^https:\/\/reclaude\.junsaku\.dev$/, /^https:\/\/([a-z0-9-]+\.)?reclaude\.pages\.dev$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const same = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
const clean = (s, max) => String(s ?? "").slice(0, max);

export async function handlePush(request, env, url) {
  const keys = () => env.PUSH_KEYS.get(env.PUSH_KEYS.idFromName("keys")).keys();
  if (url.pathname === "/push/key" && request.method === "GET") {
    const origin = request.headers.get("Origin") || "";
    const cors = SITE.some((r) => r.test(origin)) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
    return json({ key: (await keys()).publicKey }, 200, { ...cors, "Cache-Control": "max-age=3600" });
  }
  if (url.pathname === "/push/send" && request.method === "POST") {
    if (!env.PUSH_SECRET || !same(request.headers.get("Authorization") || "", `Bearer ${env.PUSH_SECRET}`)) return json({ error: "no" }, 403);
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad" }, 400); }
    const pushes = Array.isArray(body?.pushes) ? body.pushes.slice(0, 200) : [];
    const p = body?.payload || {};
    const payload = { title: clean(p.title, 120), body: clean(p.body, 300), url: clean(p.url, 300), tag: clean(p.tag, 120) };
    if (!payload.url.startsWith("/")) payload.url = "/";
    const k = await keys();
    const results = await Promise.all(pushes.filter((s) => /^https:\/\//.test(s?.endpoint || "") && s.p256dh && s.auth)
      .map(async (s) => [s.endpoint, await sendOne(s, payload, k)]));
    return json({ sent: results.filter(([, r]) => r === true).length, gone: results.filter(([, r]) => r === "gone").map(([e]) => e) });
  }
  return new Response("Not found", { status: 404 });
}
