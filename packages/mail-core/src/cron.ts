// SPDX-License-Identifier: Apache-2.0
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { sweepDueSubmissions, type OutboundEnv } from "./outbound";
import { sweepStaleDrafts } from "./drafts";
import { pruneStaleNotifications } from "./notify";
import { pruneStalePushSubscriptions } from "./web-push";

type Db = DrizzleD1Database<typeof schema>;

// The sweep fires every 5 min (~288×/day). Notification GC only needs to run
// daily, so gate it probabilistically — ~once/day on average, stateless, no KV.
// ponytail: swap for a KV day-marker if a skipped/doubled day ever matters, or
// if the read_at scan shows up hot.
const DAILY_ODDS = 1 / 288;

/**
 * Periodic maintenance, meant to run on the 5-min cron trigger. One entry point
 * so both the /api/cron endpoint and a future scheduled() handler share it:
 *   - enqueue due scheduled sends whose hold elapsed (sweepDueSubmissions)
 *   - GC abandoned drafts + their staged R2 objects (sweepStaleDrafts)
 *   - prune read notifications past retention (daily-gated)
 */
export async function runScheduledSweeps(
  db: Db,
  env: OutboundEnv,
): Promise<{ dueEnqueued: number; staleDraftsDeleted: number; notificationsPruned: number; pushSubsPruned: number }> {
  const dueEnqueued = await sweepDueSubmissions(db, env.MAIL_OUT_QUEUE);
  const staleDraftsDeleted = await sweepStaleDrafts(db, env);
  // Daily-gated GC (both bounded scans): read notifications past retention +
  // push subscriptions that stopped refreshing.
  const daily = Math.random() < DAILY_ODDS;
  const notificationsPruned = daily ? await pruneStaleNotifications(db) : 0;
  const pushSubsPruned = daily ? await pruneStalePushSubscriptions(db) : 0;
  return { dueEnqueued, staleDraftsDeleted, notificationsPruned, pushSubsPruned };
}
