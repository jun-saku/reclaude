// Builds the deployable site into _site/.
// Run: node scripts/build.mjs   (Cloudflare Pages runs it on every deploy)
//
// Every .html file in docs/, slides/ and pages/ is published at /<file-name>,
// e.g. docs/trip-plan.html → /trip-plan. File names must be unique across folders.
// There is no public index: the full list goes to the admin page, which
// functions/admin/_middleware.js serves only at /admin/<ADMIN_KEY>.
// Files or folders starting with "_" (templates, drafts) are skipped.

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "_site");
const SECTIONS = ["docs", "slides", "pages"];
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED = new Set(["admin", "assets", "404", "index", "functions"]);

function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(full));
    else if (e.name.endsWith(".html")) out.push(full);
  }
  return out;
}

function decode(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Last commit date for the file; falls back to mtime for uncommitted files.
function updated(file) {
  try {
    const d = execFileSync("git", ["log", "-1", "--format=%cI", "--", file], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (d) return d;
  } catch {}
  return statSync(file).mtime.toISOString();
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);

const files = [];
const seen = new Map();
const errors = [];

for (const section of SECTIONS) {
  for (const file of walk(join(ROOT, section))) {
    const source = relative(ROOT, file).split("\\").join("/");
    const name = basename(file, ".html");
    if (!NAME_RE.test(name)) {
      errors.push(`${source}: file name must be lowercase-kebab-case (it becomes the URL)`);
      continue;
    }
    if (RESERVED.has(name)) {
      errors.push(`${source}: "${name}" is reserved, pick another file name`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`${source}: /${name} is already taken by ${seen.get(name)}`);
      continue;
    }
    seen.set(name, source);

    const html = readFileSync(file, "utf8");
    // Cloudflare Pages serves _site/<name>.html at /<name>.
    writeFileSync(join(OUT, name + ".html"), html);
    const desc = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
    files.push({
      url: `/${name}`,
      source,
      section,
      title: decode((html.match(/<title>([^<]*)<\/title>/i) || [, name])[1].trim()),
      description: desc ? decode(desc[1].trim()) : "",
      updated: updated(file),
    });
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

files.sort((a, b) => b.updated.localeCompare(a.updated));

cpSync(join(ROOT, "assets"), join(OUT, "assets"), { recursive: true });
cpSync(join(ROOT, "site"), OUT, { recursive: true });
cpSync(join(ROOT, "admin"), join(OUT, "admin"), { recursive: true });
writeFileSync(join(OUT, "admin", "files.json"), JSON.stringify({ files }, null, 2) + "\n");

console.log(`_site: ${files.length} page(s)`);
