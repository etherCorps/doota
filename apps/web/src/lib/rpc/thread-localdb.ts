// SPDX-License-Identifier: Apache-2.0
import { and, max, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import type { ContentKey, R2Like } from "@doota/mail-core/crypto";
import type { ThreadSummary } from "@doota/mail-core/read";
import type { MessageDTO, TimelineItem } from "@doota/mail-core/mail-thread-contract";
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

/** A full-timeline item for the slice-3 thread mirror. */
export type MirroredItem = {
  itemId: string;
  seq: number;
  itemType: string;
  payload: TimelineItem;
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
  const threadIds = await resolveThreadIds(db, ctx.mailboxId, res.changes);
  const present = await threadSummariesByIds(db, { ...ctx, threadIds });
  const presentIds = new Set(present.map((summary) => summary.threadId));
  const removals = threadIds.filter((threadId) => !presentIds.has(threadId));
  return { upserts: present, removals, newSeq: res.newSeq, cannotCalculate: false };
}

/**
 * Seed a single thread's FULL timeline into the mirror. Uses `getThread` for
 * the DTO and maps EVERY item (external_message, internal_note, system_event)
 * to a `MirroredItem`. Rich message items get `renderFramedBody`; others null.
 *
 * `cursor` is snapshotted BEFORE the read so any change mid-seed re-appears as
 * a delta (same invariant as buildSeed for the thread list).
 *
 * ponytail: re-renders ALL rich messages on each revalidation; acceptable for
 * typical thread sizes. Upgrade path: wire slice-2 incremental delta for only
 * changed messages once re-render cost is measurably a problem.
 */
export async function buildSeedThread(
  db: Db,
  ctx: ThreadCtx,
): Promise<{ items: MirroredItem[]; cursor: number; renderVersion: string }> {
  const cursor = await currentSeq(db, ctx.mailboxId);
  const dto = await getThread(db, {
    mailboxId: ctx.mailboxId,
    threadId: ctx.threadId,
    ck: ctx.ck,
    includeCollab: ctx.includeCollab,
    userId: ctx.userId,
    assignedTo: ctx.assignedTo,
  });
  if (!dto) return { items: [], cursor, renderVersion: RENDER_CACHE_VERSION };

  const bucket = ctx.env.MAIL_RAW ?? null;

  // Pre-fetch r2RawKey for all rich external_message items in one query.
  // ponytail: one extra read per seed; acceptable (lazy, once per thread open).
  const richIds = dto.items
    .filter((item): item is MessageDTO => item.type === "external_message" && item.htmlKind === "rich")
    .map((item) => item.id);
  const r2KeyRows = richIds.length
    ? await db
        .select({ id: mail.message.id, r2RawKey: mail.message.r2RawKey })
        .from(mail.message)
        .where(inArray(mail.message.id, richIds))
    : [];
  const r2KeyByMsgId = new Map(r2KeyRows.map((row) => [row.id, row.r2RawKey]));

  const items: MirroredItem[] = await Promise.all(
    dto.items.map(async (item, seq) => {
      let framedHtml: string | null = null;
      if (item.type === "external_message" && item.htmlKind === "rich" && bucket) {
        const r2RawKey = r2KeyByMsgId.get(item.id) ?? null;
        if (r2RawKey) {
          framedHtml = await renderFramedBody(bucket, { id: item.id, r2RawKey }, ctx.ck).catch(() => null);
        }
      }
      return { itemId: item.id, seq, itemType: item.type, payload: item, framedHtml };
    }),
  );

  return { items, cursor, renderVersion: RENDER_CACHE_VERSION };
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

  // Email change_log objectId = delivery.id (not message.id). Resolve via the
  // shared helper: delivery.id → { messageId, threadId } (mailbox-scoped join).
  const deliveryIds = emailChanges.map((change) => change.objectId);
  const deliveryInfoMap = await deliveriesToThreadInfo(db, ctx.mailboxId, deliveryIds);
  // deliveryToMsg: deliveryId → messageId, filtered to this thread.
  const deliveryToMsg = new Map<string, string>();
  for (const [deliveryId, info] of deliveryInfoMap) {
    if (info.threadId === ctx.threadId) deliveryToMsg.set(deliveryId, info.messageId);
  }

  // Filter email changes to those that belong to this thread.
  const ownedDeliveryChanges = emailChanges.filter((change) => deliveryToMsg.has(change.objectId));
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

/**
 * Maps a set of Email change_log delivery-ids (scoped to a mailbox) to their
 * message and thread ids via the delivery→message join.
 *
 * Returns a Map keyed by deliveryId so each caller can project what it needs:
 *   - resolveThreadIds needs the threadId set (for the thread-list surface)
 *   - buildThreadMessageChanges needs deliveryId→messageId + threadId filter
 */
async function deliveriesToThreadInfo(
  db: Db,
  mailboxId: string,
  deliveryIds: string[],
): Promise<Map<string, { messageId: string; threadId: string }>> {
  if (!deliveryIds.length) return new Map();
  const rows = await db
    .select({
      deliveryId: mail.delivery.id,
      messageId: mail.delivery.messageId,
      threadId: mail.message.threadId,
    })
    .from(mail.delivery)
    .innerJoin(mail.message, eq(mail.message.id, mail.delivery.messageId))
    .where(and(inArray(mail.delivery.id, deliveryIds), eq(mail.delivery.mailboxId, mailboxId)));
  return new Map(rows.map((row) => [row.deliveryId, { messageId: row.messageId, threadId: row.threadId }]));
}

// Email objectId → threadId via the delivery→message join; Thread objectId is the threadId directly.
async function resolveThreadIds(
  db: Db,
  mailboxId: string,
  changes: { type: string; objectId: string }[],
): Promise<string[]> {
  const ids = new Set<string>();
  const deliveryIds: string[] = [];
  for (const change of changes) {
    if (change.type === "Thread") ids.add(change.objectId);
    else if (change.type === "Email") deliveryIds.push(change.objectId);
  }
  if (deliveryIds.length) {
    const infoMap = await deliveriesToThreadInfo(db, mailboxId, deliveryIds);
    for (const { threadId } of infoMap.values()) ids.add(threadId);
  }
  return [...ids];
}
