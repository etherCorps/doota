// SPDX-License-Identifier: Apache-2.0
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { sweepDueSubmissions, type OutboundEnv } from "./outbound";
import { sweepStaleDrafts } from "./drafts";
import { sweepDueSnoozes } from "./snooze";
import { pruneStaleNotifications } from "./notify";
import { pruneStalePushSubscriptions } from "./web-push";
import { purgeExpiredSendData } from "./send-log";
import { pruneChangeLog } from "./change-log";
import { sweepJunk } from "./spam";
import { sweepDueWebhooks, pruneWebhookDeliveries } from "./webhooks";

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
): Promise<{ dueEnqueued: number; snoozesWoken: number; webhooksRedriven: number; staleDraftsDeleted: number; notificationsPruned: number; pushSubsPruned: number; sendDataPurged: number; changeLogPruned: number; junkHidden: number; webhookDeliveriesPruned: number }> {
  const dueEnqueued = await sweepDueSubmissions(db, env.MAIL_OUT_QUEUE);
  // User-facing timing (a snooze returning to the inbox) — runs every 5 min, not
  // daily-gated.
  const snoozesWoken = await sweepDueSnoozes(db);
  // Re-drive webhook deliveries whose retry came due (or whose enqueue was lost)
  // — timely, so every 5 min like snoozes, not daily-gated. No-op without the
  // queue binding.
  const webhooksRedriven = env.WEBHOOK_QUEUE ? await sweepDueWebhooks(db, env.WEBHOOK_QUEUE) : 0;
  // Daily-gated GC — all bounded scans that don't need per-5-min frequency:
  // abandoned-draft + stuck-send tombstones, read notifications past retention,
  // push subscriptions that stopped refreshing. Draft GC ran ~288×/day for a
  // tombstone sweep a once-daily pass covers (a crashed send's draft reopening
  // within ~a day is fine — the mail already went out before the crash).
  const daily = Math.random() < DAILY_ODDS;
  const staleDraftsDeleted = daily ? await sweepStaleDrafts(db, env) : 0;
  const notificationsPruned = daily ? await pruneStaleNotifications(db) : 0;
  const pushSubsPruned = daily ? await pruneStalePushSubscriptions(db) : 0;
  // Null out send-log payloads past their retention TTL (metadata rows stay).
  const sendDataPurged = daily ? await purgeExpiredSendData(db) : 0;
  // change_log retention: delete past-window rows and raise each mailbox's
  // floor first, so a below-floor sync token gets a resync signal, never a
  // silently incomplete diff.
  const changeLogPruned = daily ? await pruneChangeLog(db) : 0;
  // Junk retention: HIDE spam threads past the window (never a delete).
  const junkHidden = daily ? await sweepJunk(db) : 0;
  // Webhook delivery-row retention (terminal rows past the window). Folds into
  // the daily GC — not a second cron.
  const webhookDeliveriesPruned = daily ? await pruneWebhookDeliveries(db) : 0;
  return { dueEnqueued, snoozesWoken, webhooksRedriven, staleDraftsDeleted, notificationsPruned, pushSubsPruned, sendDataPurged, changeLogPruned, junkHidden, webhookDeliveriesPruned };
}
