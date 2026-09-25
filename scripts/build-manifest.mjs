// Scans the content folders and writes files.json, which the home page lists.
// Run: node scripts/build-manifest.mjs   (CI runs it on every deploy)
//
// Each .html file contributes its <title> and <meta name="description">.
// Files or folders starting with "_" (templates, drafts) are skipped.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SECTIONS = ["docs", "slides", "pages"];

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

function tag(html, re) {
  const m = html.match(re);
  return m ? decode(m[1].trim()) : "";
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
    const d = execFileSync("git", ["log", "-1", "--format=%cI", "--", file], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (d) return d;
  } catch {}
  return statSync(file).mtime.toISOString();
}

const files = [];
for (const section of SECTIONS) {
  for (const file of walk(join(ROOT, section))) {
    const html = readFileSync(file, "utf8");
    const path = relative(ROOT, file).split("\\").join("/");
    files.push({
      path,
      section,
      title: tag(html, /<title>([^<]*)<\/title>/i) || path,
      description: tag(html, /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i),
      updated: updated(file),
    });
  }
}

files.sort((a, b) => b.updated.localeCompare(a.updated));
writeFileSync(join(ROOT, "files.json"), JSON.stringify({ files }, null, 2) + "\n");
console.log(`files.json: ${files.length} file(s)`);
