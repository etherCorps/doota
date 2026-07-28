// SPDX-License-Identifier: Apache-2.0
import { and, inArray, isNotNull, lte } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";

type Db = DrizzleD1Database<typeof schema>;

// Snooze lives on thread_state, which is per-(thread, mailbox) — so a snooze is
// per-mailbox, the same scope as `placement`. On a shared mailbox, snoozing hides
// the thread for the whole team until it wakes (matches the shared placement
// model). Snooze/unsnooze writes happen in thread.remote.ts; this file owns the
// cron wake sweep.

/**
 * Wake threads whose snooze elapsed — meant to run on the 5-min cron. Clears
 * `snoozedUntil`, bumps `lastActivityAt` to now (returns the thread to the TOP of
 * the inbox), and drops the per-user read cursors for those threads so they come
 * back UNREAD (Gmail semantics; both confirmed by product). Returns the count woken.
 *
 * lastActivityAt normally mirrors thread.last_message_at; a wake deliberately sets
 * it to now so the thread resurfaces at the top — it re-syncs on the next real
 * delivery. Sort-hint only, no correctness impact elsewhere.
 */
export async function sweepDueSnoozes(db: Db, now: Date = new Date()): Promise<number> {
  const woken = await db
    .update(mail.threadState)
    .set({ snoozedUntil: null, lastActivityAt: now })
    .where(and(isNotNull(mail.threadState.snoozedUntil), lte(mail.threadState.snoozedUntil, now)))
    .returning({ threadId: mail.threadState.threadId });
  if (!woken.length) return 0;
  const threadIds = [...new Set(woken.map((w) => w.threadId))];
  // Drop read cursors → unread for everyone who could see the thread.
  await db.delete(mail.threadRead).where(inArray(mail.threadRead.threadId, threadIds));
  return woken.length;
}
