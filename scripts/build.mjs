// Builds the deployable site into _site/.
// Run: node scripts/build.mjs   (the deploy workflow runs it too)
//
// Each folder projects/<name>/ is published at /<name>/ and must contain an index.html.
// Names must be lowercase-kebab-case and are the URL, so they can't change once shared.
// Folders starting with "_" (templates, drafts) are skipped. There is no index page.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "_site");
const PROJECTS = join(ROOT, "projects");
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED = new Set(["404", "assets"]);

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
// Serve files as-is; don't let GitHub Pages run Jekyll over them.
writeFileSync(join(OUT, ".nojekyll"), "");

console.log(`_site: ${built.length} project(s)${built.length ? ": " + built.join(", ") : ""}`);
