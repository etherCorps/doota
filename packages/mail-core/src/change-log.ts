// SPDX-License-Identifier: Apache-2.0
import { and, eq, gt, lt, asc, max, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Reader over the trigger-written change_log (JMAP /changes shape — no JMAP
 * endpoint yet, this is the substrate). `sinceSeq` is the client's state token:
 * a token at or below the mailbox's pruned floor cannot produce a complete
 * diff, so the caller must resync from scratch (cannotCalculateChanges).
 */
export async function changesSince(
  db: Db,
  mailboxId: string,
  sinceSeq: number,
  limit = 500,
): Promise<
  | { cannotCalculateChanges: true }
  | {
      cannotCalculateChanges: false;
      changes: { seq: number; type: string; objectId: string; action: string }[];
      newSeq: number;
      hasMore: boolean;
    }
> {
  const floor = await db.query.changeLogFloor.findFirst({
    where: eq(schema.changeLogFloor.mailboxId, mailboxId),
  });
  if (floor && sinceSeq < floor.floorSeq) return { cannotCalculateChanges: true };

  const rows = await db
    .select({
      seq: mail.changeLog.seq,
      type: mail.changeLog.type,
      objectId: mail.changeLog.objectId,
      action: mail.changeLog.action,
    })
    .from(mail.changeLog)
    .where(and(eq(mail.changeLog.mailboxId, mailboxId), gt(mail.changeLog.seq, sinceSeq)))
    .orderBy(asc(mail.changeLog.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const changes = hasMore ? rows.slice(0, limit) : rows;
  return {
    cannotCalculateChanges: false,
    changes,
    newSeq: changes.length ? changes[changes.length - 1].seq : sinceSeq,
    hasMore,
  };
}

/** Retention window for change_log rows. A client offline longer than this
 * gets a full resync instead of a diff. */
export const CHANGE_LOG_RETENTION_DAYS = 30;

/**
 * Daily prune (rides the cron alongside draft GC): delete rows past retention
 * and raise each affected mailbox's floor to its highest pruned seq FIRST — the
 * floor must never lag the delete, or an old token would silently get an
 * incomplete diff instead of a resync.
 */
export async function pruneChangeLog(db: Db, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - CHANGE_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const pruned = await db
    .select({ mailboxId: mail.changeLog.mailboxId, maxSeq: max(mail.changeLog.seq) })
    .from(mail.changeLog)
    .where(lt(mail.changeLog.createdAt, cutoff))
    .groupBy(mail.changeLog.mailboxId);
  if (pruned.length === 0) return 0;

  for (const row of pruned) {
    if (row.maxSeq == null) continue;
    await db
      .insert(mail.changeLogFloor)
      .values({ mailboxId: row.mailboxId, floorSeq: row.maxSeq })
      .onConflictDoUpdate({
        target: mail.changeLogFloor.mailboxId,
        // Floor only rises — a concurrent higher floor must not be lowered.
        set: { floorSeq: sql`MAX(${mail.changeLogFloor.floorSeq}, ${row.maxSeq})` },
      });
  }
  const res = await db.delete(mail.changeLog).where(lt(mail.changeLog.createdAt, cutoff));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (res as any)?.rowsAffected ?? (res as any)?.meta?.changes ?? pruned.length;
}
