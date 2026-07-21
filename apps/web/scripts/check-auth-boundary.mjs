#!/usr/bin/env node
/**
 * AUTH BOUNDARY GUARD (grep-based; the project has no ESLint).
 *
 * Enforces the single-boundary rule: Better Auth internals and direct writes to
 * Better Auth-owned tables live ONLY under src/lib/server/auth/. App code must
 * import typed functions from the boundary instead.
 *
 * Fails the build if, OUTSIDE src/lib/server/auth/, any file:
 *   - touches `$context` or `internalAdapter` (undocumented internal API), or
 *   - runs `.insert/.update/.delete(schema.…)` (a direct auth-table write).
 *
 * Reads (`.select` / `db.query`) are allowed anywhere per the migration spec.
 * Run from `pnpm check`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "src");
const BOUNDARY = join(root, "src", "lib", "server", "auth"); // the sanctioned zone

// The shared server code moved out of the app into workspace packages, which
// hold the mail pipeline's DB writes. Scan them too, or the boundary rule has a
// blind spot: an auth-table write added there would bypass the guard.
const WS = join(root, "..", "..");
const SCAN_ROOTS = [SRC, join(WS, "packages", "mail-core", "src"), join(WS, "packages", "db", "src")];

const RULES = [
  { re: /\$context\b/, msg: "$context (Better Auth internal) — use a boundary function" },
  { re: /\binternalAdapter\b/, msg: "internalAdapter (Better Auth internal) — use a boundary function" },
  {
    re: /\.(insert|update|delete)\(\s*schema\./,
    msg: "direct auth-table write — route through auth.api or a boundary escape hatch",
  },
];

/** Recursively collect .ts/.svelte files under a dir. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|svelte)$/.test(name)) out.push(p);
  }
  return out;
}

const TESTS = join(root, "src", "test"); // test stubs/fakes are not app code

const violations = [];
for (const file of SCAN_ROOTS.flatMap(walk)) {
  if (file.startsWith(BOUNDARY)) continue; // the boundary is allowed to use internals
  if (file.startsWith(TESTS) || /\.test\.ts$/.test(file)) continue; // tests are not app code
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    // Skip comment lines so the boundary's own doc references elsewhere don't trip.
    const trimmed = line.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        violations.push(`${relative(root, file)}:${i + 1}: ${rule.msg}`);
      }
    }
  });
}

if (violations.length) {
  console.error("\n✖ Auth boundary violations (must live under src/lib/server/auth/):\n");
  for (const v of violations) console.error("  " + v);
  console.error(`\n${violations.length} violation(s).\n`);
  process.exit(1);
}
console.log("✔ auth boundary clean");
