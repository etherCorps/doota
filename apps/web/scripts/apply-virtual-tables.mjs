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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Migrations live at the workspace root. Resolve from THIS file, not cwd —
// `db:push` runs with cwd apps/web, where a bare "drizzle" doesn't exist.
const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "drizzle");
const remote = process.argv.includes("--remote");
const target = remote ? "--remote" : "--local";

// Every custom migration drizzle-kit push skips: FTS5 virtual tables AND the
// change_log triggers (drizzle can't model either). Name-matched, so a
// renumbered file still resolves. Extend the pattern for future custom SQL.
const files = readdirSync(MIG_DIR)
  .filter((f) => /_(fts5|triggers)\.sql$/.test(f))
  .sort();

if (files.length === 0) {
  console.error("apply-virtual-tables: no *_fts5.sql / *_triggers.sql found — nothing to apply.");
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
