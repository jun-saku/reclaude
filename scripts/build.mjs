// Builds the deployable site into _site/.
// Run: node scripts/build.mjs   (the deploy workflow runs it too)
//
// Each folder projects/<name>/ is published at /<name>/ and must contain an index.html.
// Names must be lowercase-kebab-case and are the URL, so they can't change once shared.
// Folders starting with "_" (templates, drafts) are skipped. site/ goes to the root: 404.html, and games/ (the landing page).
// shared/ is published at /shared/ for code used by several projects.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "_site");
const PROJECTS = join(ROOT, "projects");
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED = new Set(["404", "assets", "games", "shared"]);

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

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

cpSync(join(ROOT, "site"), OUT, { recursive: true });
// Code shared between projects, imported as ../shared/<file>.
cpSync(join(ROOT, "shared"), join(OUT, "shared"), { recursive: true });
// Cache-busting: links to shared files get ?v=<content hash>, so a browser holding an old copy
// (say, from playing another game) fetches the new one as soon as it changes.
const version = {};
for (const f of readdirSync(join(ROOT, "shared"))) {
  version[f] = createHash("sha256").update(readFileSync(join(ROOT, "shared", f))).digest("hex").slice(0, 10);
}
function stamp(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { stamp(full); continue; }
    if (!/\.(html|js|mjs)$/.test(e.name)) continue;
    const text = readFileSync(full, "utf8");
    const out = text.replace(/(\.\.\/shared\/)([\w.-]+)(?![\w.?-])/g, (m, pre, file) => (version[file] ? `${pre}${file}?v=${version[file]}` : m));
    if (out !== text) writeFileSync(full, out);
  }
}
for (const name of built) stamp(join(OUT, name));

// Content-Security-Policy, added to every page as a <meta> tag: scripts may only come from this site, the page's own
// inline scripts (by hash, so injected ones can't run), Firebase's SDK folder and reCAPTCHA's (App Check), and pages
// may only connect to Firebase, Google's APIs and reclaude's game server (worker/, play.reclaude.junsaku.dev). Sources
// are exact folders, not whole hosts: a whole CDN would let an injected tag load anyone's code from it. 127.0.0.1 is the
// Firebase emulator and the local game server the tests use.
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
    "wss://play.reclaude.junsaku.dev", "ws://127.0.0.1:8787"],
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
    const html = readFileSync(full, "utf8");
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
