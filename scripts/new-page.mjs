// Creates a new page from a template.
// Usage: node scripts/new-page.mjs <docs|slides|pages> <name> "Title" ["Description"]
// Example: node scripts/new-page.mjs docs trip-plan "Trip plan" "Dates, bookings and budget"
// The page is published at /<name>.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const [section, rawName, title, description = ""] = process.argv.slice(2);
const name = (rawName || "").replace(/\.html$/, "");

if (!["docs", "slides", "pages"].includes(section) || !name || !title) {
  console.error('Usage: node scripts/new-page.mjs <docs|slides|pages> <name> "Title" ["Description"]');
  process.exit(1);
}
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
  console.error("Name must be lowercase-kebab-case, e.g. trip-plan");
  process.exit(1);
}
for (const s of ["docs", "slides", "pages"]) {
  if (existsSync(join(ROOT, s)) && readdirSync(join(ROOT, s)).includes(name + ".html")) {
    console.error(`/${name} is already taken by ${s}/${name}.html`);
    process.exit(1);
  }
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const template = join(ROOT, section === "slides" ? "slides" : "docs", "_template.html");
const html = readFileSync(template, "utf8")
  .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
  .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(description)}$2`)
  .replace(/<h1>[^<]*<\/h1>/, `<h1>${esc(title)}</h1>`);

writeFileSync(join(ROOT, section, name + ".html"), html);
console.log(`${section}/${name}.html → /${name}`);
