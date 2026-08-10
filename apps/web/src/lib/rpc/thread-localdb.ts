// SPDX-License-Identifier: Apache-2.0
import { and, max, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import type { ContentKey, R2Like } from "@doota/mail-core/crypto";
import type { ThreadSummary } from "@doota/mail-core/read";
import type { MessageDTO } from "@doota/mail-core/mail-thread-contract";
import { listThreads, threadSummariesByIds, getThread } from "@doota/mail-core/read";
import { changesSince } from "@doota/mail-core/change-log";
import { RENDER_CACHE_VERSION } from "@doota/mail-core/mime";
import { renderFramedBody } from "$lib/server/framed-body.js";

type Db = DrizzleD1Database<typeof schema>;
type Ctx = { mailboxId: string; ck: ContentKey; userId: string; includeCollab: boolean; assignedTo: string | null };
type ThreadCtx = Ctx & { threadId: string; env: { MAIL_RAW?: R2Like } };

/** A MessageDTO augmented with the mirror-specific fields. */
export type MirroredMessage = MessageDTO & {
  /** Index within the thread (sentAt order), used for the client's seq column. */
  seq: number;
  /** Server-built framed document (images=0) for rich messages; null for plain. */
  framedHtml: string | null;
};

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
  // ponytail: single page per call — changesSince caps at 500 and we drop hasMore;
  // the next realtime event/ensure drains the rest. Loop while hasMore if large
  // silent catch-ups ever matter.
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

/**
 * Seed a single thread's messages into the mirror. Uses `getThread` for the
 * DTO and `renderFramedBody` per rich message to produce the framed doc.
 *
 * `cursor` is snapshotted BEFORE the read so any change mid-seed re-appears as
 * a delta (same invariant as buildSeed for the thread list).
 */
export async function buildSeedThread(
  db: Db,
  ctx: ThreadCtx,
): Promise<{ messages: MirroredMessage[]; cursor: number; renderVersion: string }> {
  const cursor = await currentSeq(db, ctx.mailboxId);
  const dto = await getThread(db, {
    mailboxId: ctx.mailboxId,
    threadId: ctx.threadId,
    ck: ctx.ck,
    includeCollab: ctx.includeCollab,
    userId: ctx.userId,
    assignedTo: ctx.assignedTo,
  });
  if (!dto) return { messages: [], cursor, renderVersion: RENDER_CACHE_VERSION };

  const externalMessages = dto.items.filter((item): item is MessageDTO => item.type === "external_message");
  const bucket = ctx.env.MAIL_RAW ?? null;

  // r2RawKey is not on MessageDTO — fetch it from the DB for rich messages.
  // ponytail: one extra read per rich message; acceptable for the seed path
  // (lazy, once per thread open). A future optimization: extend getThread to
  // carry r2RawKey on the DTO so this extra read disappears.
  const richIds = externalMessages.filter((m) => m.htmlKind === "rich").map((m) => m.id);
  const r2KeyRows = richIds.length
    ? await db
        .select({ id: mail.message.id, r2RawKey: mail.message.r2RawKey })
        .from(mail.message)
        .where(inArray(mail.message.id, richIds))
    : [];
  const r2KeyByMsgId = new Map(r2KeyRows.map((row) => [row.id, row.r2RawKey]));

  const messages: MirroredMessage[] = await Promise.all(
    externalMessages.map(async (msgDto, seqIndex) => {
      let framedHtml: string | null = null;
      if (msgDto.htmlKind === "rich" && bucket) {
        const r2RawKey = r2KeyByMsgId.get(msgDto.id) ?? null;
        if (r2RawKey) {
          framedHtml = await renderFramedBody(bucket, { id: msgDto.id, r2RawKey }, ctx.ck).catch(() => null);
        }
      }
      return { ...msgDto, seq: seqIndex, framedHtml };
    }),
  );

  return { messages, cursor, renderVersion: RENDER_CACHE_VERSION };
}

/**
 * Incremental delta for a thread's messages since `sinceSeq`. Mirrors the
 * shape of buildChanges for the thread list.
 *
 * Maps Email change_log entries to this thread's messages; re-derives the
 * message DTO (via getThread filtered) for upserts; destroyed → removals.
 */
export async function buildThreadMessageChanges(
  db: Db,
  ctx: ThreadCtx & { sinceSeq: number },
): Promise<{ upserts: MirroredMessage[]; removals: string[]; newSeq: number; cannotCalculate: boolean }> {
  const res = await changesSince(db, ctx.mailboxId, ctx.sinceSeq);
  if (res.cannotCalculateChanges) {
    return { upserts: [], removals: [], newSeq: ctx.sinceSeq, cannotCalculate: true };
  }

  // Filter to Email entries and check which ones belong to this thread.
  const emailChanges = res.changes.filter((change) => change.type === "Email");
  if (!emailChanges.length) {
    return { upserts: [], removals: [], newSeq: res.newSeq, cannotCalculate: false };
  }

  // Email change_log objectId = delivery.id (not message.id). Resolve:
  //   delivery.id → message.id → threadId check.
  const deliveryIds = emailChanges.map((change) => change.objectId);
  const deliveryRows = await db
    .select({ deliveryId: mail.delivery.id, messageId: mail.delivery.messageId })
    .from(mail.delivery)
    .where(and(inArray(mail.delivery.id, deliveryIds), eq(mail.delivery.mailboxId, ctx.mailboxId)));
  // Map delivery ids to message ids, then check which message ids belong to this thread.
  const deliveryToMsg = new Map(deliveryRows.map((row) => [row.deliveryId, row.messageId]));
  const candidateMsgIds = [...new Set(deliveryRows.map((row) => row.messageId))];
  let ownedMsgIds: Set<string>;
  if (candidateMsgIds.length) {
    const threadMsgRows = await db
      .select({ id: mail.message.id })
      .from(mail.message)
      .where(and(inArray(mail.message.id, candidateMsgIds), eq(mail.message.threadId, ctx.threadId)));
    ownedMsgIds = new Set(threadMsgRows.map((row) => row.id));
  } else {
    ownedMsgIds = new Set();
  }

  // Filter email changes to those that belong to this thread.
  const ownedDeliveryChanges = emailChanges.filter((change) => {
    const msgId = deliveryToMsg.get(change.objectId);
    return msgId !== undefined && ownedMsgIds.has(msgId);
  });
  if (!ownedDeliveryChanges.length) {
    return { upserts: [], removals: [], newSeq: res.newSeq, cannotCalculate: false };
  }

  // Destroyed deliveries → the message is gone from this mailbox → removals.
  // Use the resolved message id (not the delivery id) for the client.
  const destroyedIds = ownedDeliveryChanges
    .filter((change) => change.action === "destroyed")
    .map((change) => deliveryToMsg.get(change.objectId)!)
    .filter(Boolean);

  // Upsert: re-derive via getThread, filter to changed message ids.
  const dto = await getThread(db, {
    mailboxId: ctx.mailboxId,
    threadId: ctx.threadId,
    ck: ctx.ck,
    includeCollab: ctx.includeCollab,
    userId: ctx.userId,
    assignedTo: ctx.assignedTo,
  });

  const upsertMsgIds = new Set(
    ownedDeliveryChanges
      .filter((change) => change.action !== "destroyed")
      .map((change) => deliveryToMsg.get(change.objectId)!)
      .filter(Boolean),
  );

  const upserts: MirroredMessage[] = [];
  if (dto && upsertMsgIds.size) {
    const externalMessages = dto.items.filter((item): item is MessageDTO => item.type === "external_message");
    const bucket = ctx.env.MAIL_RAW ?? null;
    for (const [seqIndex, msgDto] of externalMessages.entries()) {
      if (!upsertMsgIds.has(msgDto.id)) continue;
      let framedHtml: string | null = null;
      if (msgDto.htmlKind === "rich" && bucket) {
        const msgRow = await db.query.message.findFirst({
          where: eq(mail.message.id, msgDto.id),
          columns: { id: true, r2RawKey: true },
        });
        if (msgRow?.r2RawKey) {
          framedHtml = await renderFramedBody(bucket, msgRow, ctx.ck).catch(() => null);
        }
      }
      upserts.push({ ...msgDto, seq: seqIndex, framedHtml });
    }
  }

  return { upserts, removals: destroyedIds, newSeq: res.newSeq, cannotCalculate: false };
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
