// Creates projects/<name>/ from the template.
// Usage: node scripts/new-project.mjs <name> "Title" ["Description"]
// Example: node scripts/new-project.mjs snake "Snake" "The classic, with swipe controls"
// The project is published at /<name>/.

import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const [name, title, description = ""] = process.argv.slice(2);

if (!name || !title) {
  console.error('Usage: node scripts/new-project.mjs <name> "Title" ["Description"]');
  process.exit(1);
}
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
  console.error("Name must be lowercase-kebab-case, e.g. tip-calculator");
  process.exit(1);
}
const dir = join(ROOT, "projects", name);
if (existsSync(dir)) {
  console.error(`projects/${name} already exists`);
  process.exit(1);
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
cpSync(join(ROOT, "projects", "_template"), dir, { recursive: true });
const file = join(dir, "index.html");
writeFileSync(
  file,
  readFileSync(file, "utf8")
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(description)}$2`)
    .replace(/<h1>[^<]*<\/h1>/, `<h1>${esc(title)}</h1>`)
);

console.log(`projects/${name}/index.html → /${name}/`);
