// Rebuilds shared/supabase-js.js: the Supabase client (@supabase/supabase-js) as one ES module, so pages use it with
// no npm and no build step, and from this site only (the security policy allows no CDN for it).
// Run: node scripts/vendor-supabase.mjs   (needs npm and the network; commit the result)
// To update, change VERSION to a release at least two weeks old, run this, and test the apps.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "2.117.3";
const ESBUILD = "0.25.10";
const out = new URL("../shared/supabase-js.js", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "vendor-supabase-"));
try {
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
  writeFileSync(join(dir, "package.json"), "{}");
  run("npm", ["install", "--silent", "--no-audit", "--no-fund", `@supabase/supabase-js@${VERSION}`, `esbuild@${ESBUILD}`]);
  writeFileSync(join(dir, "entry.mjs"), 'export { createClient } from "@supabase/supabase-js";\n');
  run(join(dir, "node_modules", ".bin", "esbuild"), ["entry.mjs", "--bundle", "--format=esm", "--platform=browser",
    "--target=es2020", "--minify", "--legal-comments=none", "--outfile=bundle.js"]);
  // The packages bundled in, each with its licence and copyright line (the licence texts follow).
  const modules = join(dir, "node_modules");
  const names = readdirSync(modules).filter((n) => !n.startsWith(".") && !/esbuild/.test(n))
    .flatMap((n) => (n.startsWith("@") ? readdirSync(join(modules, n)).map((m) => `${n}/${m}`) : [n])).filter((n) => !/esbuild/.test(n));
  const credits = names.map((n) => {
    const pkg = JSON.parse(readFileSync(join(modules, n, "package.json"), "utf8"));
    const file = readdirSync(join(modules, n)).find((f) => /^licen[cs]e/i.test(f));
    const copyright = file ? readFileSync(join(modules, n, file), "utf8").match(/^.*copyright.*$/im)?.[0].trim() : "";
    return `${n} ${pkg.version} (${pkg.license})${copyright ? `: ${copyright}` : ""}`;
  });
  const license = readFileSync(join(modules, "@supabase", "supabase-js", "LICENSE"), "utf8").trim();
  const header = [`@supabase/supabase-js ${VERSION}, bundled by scripts/vendor-supabase.mjs (do not edit; run the script).`,
    "Includes:", ...credits.map((c) => `  ${c}`), "", ...license.split("\n")].map((l) => `// ${l}`.trimEnd()).join("\n") + "\n";
  writeFileSync(out, header + readFileSync(join(dir, "bundle.js"), "utf8"));
  console.log(`wrote shared/supabase-js.js (@supabase/supabase-js ${VERSION})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
