import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { sweepDueSubmissions, type OutboundEnv } from "./outbound";
import { sweepStaleDrafts } from "./drafts";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Periodic maintenance, meant to run on the 5-min cron trigger. One entry point
 * so both the /api/cron endpoint and a future scheduled() handler share it:
 *   - enqueue due scheduled sends whose hold elapsed (sweepDueSubmissions)
 *   - GC abandoned drafts + their staged R2 objects (sweepStaleDrafts)
 */
export async function runScheduledSweeps(
  db: Db,
  env: OutboundEnv,
): Promise<{ dueEnqueued: number; staleDraftsDeleted: number }> {
  const dueEnqueued = await sweepDueSubmissions(db, env.MAIL_OUT_QUEUE);
  const staleDraftsDeleted = await sweepStaleDrafts(db, env);
  return { dueEnqueued, staleDraftsDeleted };
}
