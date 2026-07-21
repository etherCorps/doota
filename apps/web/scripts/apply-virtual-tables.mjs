#!/usr/bin/env node
/**
 * Apply the FTS5 virtual-table SQL after `drizzle-kit push`.
 *
 * `drizzle-kit push` diffs the TS schema against the DB and never runs migration
 * files, so anything Drizzle can't model — the `message_fts` virtual table — is
 * skipped. This re-applies just those custom statements so `db:push` leaves a
 * complete schema. The SQL lives ONCE, in the `--custom` migration
 * (`drizzle/*_message_fts5.sql`); this reuses it, so there is no second copy to
 * drift. All statements are idempotent (CREATE VIRTUAL TABLE IF NOT EXISTS).
 *
 * Targets the LOCAL D1 (matching push's local sqlite). Pass `--remote` to apply
 * against the remote D1 instead.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const MIG_DIR = "drizzle";
const remote = process.argv.includes("--remote");
const target = remote ? "--remote" : "--local";

// Every custom virtual-table migration (name-matched, so a renumbered file still
// resolves). Extend the pattern if more virtual tables are added later.
const files = readdirSync(MIG_DIR)
  .filter((f) => /_fts5\.sql$/.test(f))
  .sort();

if (files.length === 0) {
  console.error("apply-virtual-tables: no *_fts5.sql found — nothing to apply.");
  process.exit(0);
}

for (const f of files) {
  const path = join(MIG_DIR, f);
  console.log(`apply-virtual-tables: applying ${path} (${target})`);
  execFileSync(
    "wrangler",
    ["d1", "execute", "doota", target, "--file", path, "--yes"],
    { stdio: "inherit" },
  );
}
