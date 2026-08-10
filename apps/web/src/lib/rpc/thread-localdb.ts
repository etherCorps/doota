// SPDX-License-Identifier: Apache-2.0
import { max, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import type { ContentKey } from "@doota/mail-core/crypto";
import type { ThreadSummary } from "@doota/mail-core/read";
import { listThreads, threadSummariesByIds } from "@doota/mail-core/read";
import { changesSince } from "@doota/mail-core/change-log";

type Db = DrizzleD1Database<typeof schema>;
type Ctx = { mailboxId: string; ck: ContentKey; userId: string; includeCollab: boolean; assignedTo: string | null };

// ponytail: shared cap — client uses this to decide when local drives the list;
// at/over the cap the remote paginated path takes over so no threads are hidden.
export const SEED_THREAD_LIMIT = 1000;

async function currentSeq(db: Db, mailboxId: string): Promise<number> {
  const row = await db.select({ m: max(mail.changeLog.seq) }).from(mail.changeLog).where(eq(mail.changeLog.mailboxId, mailboxId));
  return row[0]?.m ?? 0;
}

export async function buildSeed(db: Db, ctx: Ctx): Promise<{ rows: ThreadSummary[]; cursor: number }> {
  // Snapshot the cursor BEFORE reading rows: a change landing mid-read then re-appears
  // as a delta (idempotent upsert), never lost.
  const cursor = await currentSeq(db, ctx.mailboxId);
  // ponytail: allPlacements=true so a single request seeds all folders; the client
  // switches folders without another round-trip.
  const rows = await listThreads(db, {
    mailboxId: ctx.mailboxId,
    ck: ctx.ck,
    limit: SEED_THREAD_LIMIT,
    offset: 0,
    includeCollab: ctx.includeCollab,
    userId: ctx.userId,
    assignedTo: ctx.assignedTo,
    allPlacements: true,
  });
  return { rows, cursor };
}

export async function buildChanges(
  db: Db,
  ctx: Ctx & { sinceSeq: number },
): Promise<{ upserts: ThreadSummary[]; removals: string[]; newSeq: number; cannotCalculate: boolean }> {
  const res = await changesSince(db, ctx.mailboxId, ctx.sinceSeq);
  if (res.cannotCalculateChanges) return { upserts: [], removals: [], newSeq: ctx.sinceSeq, cannotCalculate: true };

  // Map change_log entries → affected thread ids. Email changes → their threadId;
  // Thread changes → objectId directly. (EmailSubmission/Mailbox ignored for the
  // thread-list surface.)
  const threadIds = await resolveThreadIds(db, res.changes);
  const present = await threadSummariesByIds(db, { ...ctx, threadIds });
  const presentIds = new Set(present.map((summary) => summary.threadId));
  const removals = threadIds.filter((threadId) => !presentIds.has(threadId));
  return { upserts: present, removals, newSeq: res.newSeq, cannotCalculate: false };
}

// Email objectId → threadId via the message row; Thread objectId is the threadId.
async function resolveThreadIds(
  db: Db,
  changes: { type: string; objectId: string }[],
): Promise<string[]> {
  const ids = new Set<string>();
  const emailIds: string[] = [];
  for (const change of changes) {
    if (change.type === "Thread") ids.add(change.objectId);
    else if (change.type === "Email") emailIds.push(change.objectId);
  }
  if (emailIds.length) {
    const rows = await db
      .select({ threadId: mail.message.threadId })
      .from(mail.message)
      .where(inArray(mail.message.id, emailIds));
    for (const row of rows) ids.add(row.threadId);
  }
  return [...ids];
}
