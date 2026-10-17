// Picks which end-to-end tests (tests/e2e/<name>.cjs) a PR needs, from the files it changes, and prints
// `tests=<comma list>` for GitHub Actions (empty: nothing to run).
//   projects/<game>/…          → that game's test, if it has one
//   tests/e2e/<name>.cjs       → that test
//   shared code, the game server, rules, build, the test runner or its packages, the workflow → every test
// Run: node tests/pick-e2e.mjs <base ref>   (e.g. origin/main)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const base = process.argv[2] || "origin/main";
const here = new URL(".", import.meta.url).pathname;
const all = readdirSync(join(here, "e2e")).filter((f) => f.endsWith(".cjs")).map((f) => f.slice(0, -4)).sort();
const changed = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" }).split("\n").filter(Boolean);

const EVERYTHING = [/^shared\//, /^worker\//, /^firebase\//, /^scripts\/(rules|build)\.mjs$/, /^tests\/e2e\.cjs$/, /^tests\/package(-lock)?\.json$/, /^\.github\/workflows\//];
const pick = new Set();
for (const f of changed) {
  if (EVERYTHING.some((re) => re.test(f))) { all.forEach((n) => pick.add(n)); break; }
  const game = f.match(/^projects\/([a-z0-9-]+)\//)?.[1];
  if (game && all.includes(game)) pick.add(game);
  const test = f.match(/^tests\/e2e\/([a-z0-9-]+)\.cjs$/)?.[1];
  if (test && existsSync(join(here, "e2e", `${test}.cjs`))) pick.add(test);
}
const tests = [...pick].sort().join(",");
console.error(`Changed: ${changed.length} file(s). End-to-end tests to run: ${tests || "none"}`);
console.log(`tests=${tests}`);
