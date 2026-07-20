import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "$lib/server/db/schema";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIG_DIR = join(root, "drizzle");

/**
 * In-memory SQLite (libsql) with the real drizzle migrations applied — so
 * pipeline tests exercise the actual unique indexes / upserts / FTS5 that
 * idempotency depends on, not a mock. Returns a drizzle db compatible with the
 * D1-typed functions under test.
 */
export async function makeDb() {
  const client = createClient({ url: ":memory:" });
  for (const file of readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIG_DIR, file), "utf8");
    for (const stmt of sql.split(/-->\s*statement-breakpoint/)) {
      const trimmed = stmt.trim();
      if (trimmed) await client.execute(trimmed);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return drizzle(client, { schema }) as any;
}
