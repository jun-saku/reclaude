// Unit test of the game server's Web Push for Trip (worker/src/push.js) in Node: a push is decrypted the way a phone
// does it (RFC 8291) and its VAPID signature checked (RFC 8292); /push/key and /push/send with a stand-in key store,
// fetch and secret. Run: node tests/push.test.mjs   (no dependencies; CI's build job)
import { b64url, encrypt, handlePush, makeKeys, storedKeys, unb64url, vapid } from "../worker/src/push.js";

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + m); };
const enc = new TextEncoder(), dec = new TextDecoder();
const hkdf = async (salt, ikm, info, len) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info },
  await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), len * 8));
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let a = 0; for (const x of p) { o.set(x, a); a += x.length; } return o; };

// A phone: its key pair and auth secret, as a browser's PushSubscription gives them.
const phone = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", phone.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));
const sub = { endpoint: "https://push.example.net/send/abc", p256dh: b64url(uaPublic), auth: b64url(authSecret) };

// How the phone opens it.
async function open(body) {
  const salt = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset).getUint32(16), idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen), sealed = body.slice(21 + idlen);
  const as = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: as }, phone.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, cat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce },
    await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), sealed));
  return { rs, idlen, text: dec.decode(plain.slice(0, plain.lastIndexOf(2))), pad: plain.at(-1) };
}

// ---------- encryption ----------
const payload = { title: "Ann · Tokyo", body: "Ramen tonight? 🍜", url: "/apps/trip/?id=x&chat", tag: "trip-x" };
const body = await encrypt(payload, sub.p256dh, sub.auth);
const got = await open(body);
ok(got.rs === 4096 && got.idlen === 65, "the header has the record size and the server's 65-byte key");
ok(got.pad === 2 && JSON.parse(got.text).body === payload.body, "the phone decrypts the payload (emoji and all)");
ok(b64url(await encrypt(payload, sub.p256dh, sub.auth)) !== b64url(body), "each push is encrypted afresh");

// ---------- VAPID ----------
const keys = await makeKeys();
const auth = await vapid(sub.endpoint, keys);
const [, jwt, k] = auth.match(/^vapid t=([^,]+), k=(.+)$/) || [];
const [h, c, s] = jwt.split(".");
const claims = JSON.parse(dec.decode(unb64url(c)));
const pub = await crypto.subtle.importKey("raw", unb64url(k), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64url(s), enc.encode(`${h}.${c}`)), "the VAPID token is signed by the server's key");
ok(claims.aud === "https://push.example.net" && claims.exp > Date.now() / 1000 && claims.sub.startsWith("https://"),
  "for the push service's origin, not expired, with a contact");
ok(k === keys.publicKey && unb64url(k).length === 65, "and names the public key pages subscribe with");

// ---------- the key store ----------
const store = new Map();
const storage = { get: async (x) => store.get(x), put: async (x, v) => { store.set(x, v); } };
const k1 = await storedKeys(storage), k2 = await storedKeys(storage);
ok(k1.publicKey === k2.publicKey, "the key pair is made once and kept");

// ---------- the routes ----------
const env = { PUSH_SECRET: "s3cret-s3cret-s3cret", PUSH_KEYS: { idFromName: () => "id", get: () => ({ keys: () => storedKeys(storage) }) } };
const call = (path, init = {}) => handlePush(new Request(`https://play.reclaude.junsaku.dev${path}`, init), env, new URL(`https://play.reclaude.junsaku.dev${path}`));
const keyRes = await call("/push/key", { headers: { Origin: "https://reclaude.junsaku.dev" } });
ok((await keyRes.json()).key === k1.publicKey && keyRes.headers.get("Access-Control-Allow-Origin") === "https://reclaude.junsaku.dev",
  "GET /push/key gives the site the public key");
ok(!(await call("/push/key", { headers: { Origin: "https://evil.example" } })).headers.get("Access-Control-Allow-Origin"), "other sites can't read it from a page");

let sent = [];
globalThis.fetch = async (url, init) => { sent.push({ url, init }); return new Response("", { status: url.endsWith("/gone") ? 410 : 201 }); };
const send = (authz, data) => call("/push/send", { method: "POST", headers: { Authorization: authz, "Content-Type": "application/json" }, body: JSON.stringify(data) });
const job = { pushes: [sub, { ...sub, endpoint: "https://push.example.net/gone" }, { ...sub, endpoint: "http://insecure.example/x" }], payload };
ok((await send("Bearer wrong", job)).status === 403 && sent.length === 0, "a wrong secret sends nothing");
ok((await send("", job)).status === 403, "and no secret neither");
const res = await (await send(`Bearer ${env.PUSH_SECRET}`, job)).json();
ok(res.sent === 1 && res.gone.length === 1 && res.gone[0].endsWith("/gone"), "the right secret sends to each https phone; gone ones are reported");
ok(sent.length === 2 && !sent.some((x) => x.url.startsWith("http:")), "never to a plain http address");
const first = sent.find((x) => x.url === sub.endpoint);
ok(first.init.headers["Content-Encoding"] === "aes128gcm" && first.init.headers.TTL && first.init.headers.Authorization.startsWith("vapid t="),
  "pushes carry the encoding, a time to live and the VAPID token");
ok(JSON.parse((await open(first.init.body)).text).title === payload.title, "and the phone reads the title");
sent = [];
await send(`Bearer ${env.PUSH_SECRET}`, { pushes: [sub], payload: { ...payload, url: "https://evil.example/" } });
ok(JSON.parse((await open(sent[0].init.body)).text).url === "/", "a link off the site becomes the site's home");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
