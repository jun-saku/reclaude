// Builds the deployable site into _site/.
// Run: node scripts/build.mjs   (the deploy workflow runs it too)
//
// Each folder projects/<name>/ is published at /<name>/ and must contain an index.html.
// Names must be lowercase-kebab-case and are the URL, so they can't change once shared.
// Folders starting with "_" (templates, drafts) are skipped. site/ goes to the root: 404.html, and games/ (the landing page).
// shared/ is published at /shared/ for code used by several projects.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "_site");
const PROJECTS = join(ROOT, "projects");
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED = new Set(["404", "apps", "assets", "games", "icons", "shared"]);
const APPS = join(ROOT, "apps");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);

const errors = [];
const built = [];

for (const e of readdirSync(PROJECTS, { withFileTypes: true })) {
  if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
  if (!e.isDirectory()) {
    errors.push(`projects/${e.name}: projects must be folders (projects/<name>/index.html)`);
    continue;
  }
  if (!NAME_RE.test(e.name)) {
    errors.push(`projects/${e.name}: name must be lowercase-kebab-case (it becomes the URL)`);
    continue;
  }
  if (RESERVED.has(e.name)) {
    errors.push(`projects/${e.name}: "${e.name}" is reserved, pick another name`);
    continue;
  }
  if (!existsSync(join(PROJECTS, e.name, "index.html"))) {
    errors.push(`projects/${e.name}: missing index.html`);
    continue;
  }
  cpSync(join(PROJECTS, e.name), join(OUT, e.name), { recursive: true });
  built.push(e.name);
}

// The social apps (on Supabase, see CLAUDE.md): each apps/<name>/ at /apps/<name>/, with the same rules as projects.
// (The home page, site/index.html, links to them.) "_" and "." folders are skipped.
const apps = [];
if (existsSync(APPS)) {
  for (const e of readdirSync(APPS, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith("_") || e.name.startsWith(".")) continue;
    if (!NAME_RE.test(e.name)) errors.push(`apps/${e.name}: name must be lowercase-kebab-case (it becomes the URL)`);
    else if (!existsSync(join(APPS, e.name, "index.html"))) errors.push(`apps/${e.name}: missing index.html`);
    else apps.push(e.name);
  }
  cpSync(APPS, join(OUT, "apps"), { recursive: true, filter: (src) => !relative(APPS, src).split(sep).some((p) => /^[_.]/.test(p)) });
  built.push(...apps.map((a) => `apps/${a}`));
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

cpSync(join(ROOT, "site"), OUT, { recursive: true });
// Code shared between projects, imported as ../shared/<file>.
cpSync(join(ROOT, "shared"), join(OUT, "shared"), { recursive: true });
// Cache-busting: links to shared files get ?v=<content hash>, so a browser holding an old copy
// (say, from playing another game) fetches the new one as soon as it changes. Shared files link to each other the
// same way (../shared/<file>, which from /shared/ is the folder itself), so those links are stamped too, and a file's
// hash covers the stamped links in it: a change to rooms.js also changes kit.js's version, which imports it. That
// also keeps one copy of each module in the browser, whether a page or another shared file imports it.
const SHARED_LINK = /(\.\.\/shared\/)([\w.-]+)(?![\w.?-])/g;
const sharedText = {};
for (const f of readdirSync(join(ROOT, "shared"))) sharedText[f] = readFileSync(join(ROOT, "shared", f), "utf8");
const version = {};
const stampText = (text) => text.replace(SHARED_LINK, (m, pre, file) => (version[file] ? `${pre}${file}?v=${version[file]}` : m));
for (let pass = 0; pass < 8; pass++) { // until links between shared files settle (they don't loop)
  for (const [f, text] of Object.entries(sharedText)) version[f] = createHash("sha256").update(stampText(text)).digest("hex").slice(0, 10);
}
for (const [f, text] of Object.entries(sharedText)) if (/\.(js|mjs)$/.test(f)) writeFileSync(join(OUT, "shared", f), stampText(text));
function stamp(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { stamp(full); continue; }
    if (!/\.(html|js|mjs)$/.test(e.name)) continue;
    const text = readFileSync(full, "utf8");
    const out = stampText(text);
    if (out !== text) writeFileSync(full, out);
  }
}
for (const name of built) stamp(join(OUT, name));
// A game's own modules (./game.js, ./words.js, ./sim.js…) get ?v=<content hash> too, so a page never runs with an
// older copy of one held by the browser or the offline copy (the page then fails to start: a name it imports is
// missing). Like shared files, a module's hash covers the stamped links in it (game.js changes when words.js does).
const LOCAL_LINK = /(["'])\.\/([\w.-]+\.m?js)\1/g;
for (const name of built) {
  const dir = join(OUT, name);
  const files = readdirSync(dir).filter((f) => /\.(html|js|mjs)$/.test(f));
  const text = Object.fromEntries(files.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  const ver = {};
  const stampLocal = (t) => t.replace(LOCAL_LINK, (m, q, file) => (ver[file] ? `${q}./${file}?v=${ver[file]}${q}` : m));
  for (let pass = 0; pass < 8; pass++) {
    for (const f of files) if (/\.m?js$/.test(f)) ver[f] = createHash("sha256").update(stampLocal(text[f])).digest("hex").slice(0, 10);
  }
  for (const f of files) { const out = stampLocal(text[f]); if (out !== text[f]) writeFileSync(join(dir, f), out); }
}

// Content-Security-Policy, added to every page as a <meta> tag: scripts may only come from this site, the page's own
// inline scripts (by hash, so injected ones can't run), Firebase's SDK folder and reCAPTCHA's (App Check), and pages
// may only connect to Firebase, Google's APIs, reclaude's game server (worker/, play.reclaude.junsaku.dev) and the
// apps' Supabase project. Sources are exact folders, not whole hosts: a whole CDN would let an injected tag load
// anyone's code from it. 127.0.0.1 is the Firebase emulator, the local game server and the local Supabase the tests use.
// site/_headers adds the rest (no framing by other sites, nosniff, referrer and permissions policies).
// A new external source must be added here as its exact folder (e.g. https://cdn.jsdelivr.net/npm/some-lib@1.2.3/),
// or the browser blocks it.
const CSP = {
  "default-src": ["'self'"],
  // *.firebasedatabase.app: the Realtime Database falls back to script-tag long polling when WebSockets fail.
  "script-src": ["'self'", "https://www.gstatic.com/firebasejs/", "https://www.gstatic.com/recaptcha/",
    "https://www.google.com/recaptcha/", "https://*.firebasedatabase.app"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "https://www.gstatic.com/recaptcha/"],
  "connect-src": ["'self'", "https://*.firebasedatabase.app", "wss://*.firebasedatabase.app", "https://*.googleapis.com",
    "https://www.google.com", "http://127.0.0.1:9000", "ws://127.0.0.1:9000", "http://127.0.0.1:9099",
    "wss://play.reclaude.junsaku.dev", "ws://127.0.0.1:8787",
    "https://xikukwpayubiyxcnlwme.supabase.co", "wss://xikukwpayubiyxcnlwme.supabase.co", "http://127.0.0.1:54321", "ws://127.0.0.1:54321"],
  "frame-src": ["https://www.google.com", "https://recaptcha.google.com"],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'self'"],
};
function addCsp(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { addCsp(full); continue; }
    if (!e.name.endsWith(".html")) continue;
    let html = readFileSync(full, "utf8");
    // Every page (the games, the games page, the apps and the home page; not 404.html, which is served at any address)
    // can install the site as an app: the manifest, icons and the service worker (site/manifest.webmanifest,
    // site/icons/, site/sw.js). It also shows your avatar in the profile icon, if the page has one (shared/me.js).
    // Paths are relative, like everything.
    const up = relative(dirname(full), OUT);
    if (up || e.name !== "404.html") {
      const r = up ? up.split(sep).join("/") + "/" : "./";
      html = html.replace(/<meta charset="utf-8">/i, (m) => `${m}
  <link rel="manifest" href="${r}manifest.webmanifest">
  <link rel="icon" href="${r}icons/favicon-32.png" type="image/png">
  <link rel="apple-touch-icon" href="${r}icons/apple-touch-icon.png">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <script type="module">import { showMe } from "${r}shared/me.js?v=${version["me.js"]}"; showMe();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("${r}sw.js").catch(() => {});</script>`);
    }
    const hashes = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
    const policy = Object.entries(CSP)
      .map(([k, v]) => [k, ...(k === "script-src" ? [...v, ...hashes] : v)].join(" ")).join("; ");
    const out = html.replace(/<meta charset="utf-8">/i, (m) => `${m}\n  <meta http-equiv="Content-Security-Policy" content="${policy}">`);
    if (out === html) { errors.push(`${full}: no <meta charset="utf-8"> to put the security policy after`); continue; }
    writeFileSync(full, out);
  }
}
addCsp(OUT);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}


console.log(`_site: ${built.length} project(s)${built.length ? ": " + built.join(", ") : ""}`);
