// SPDX-License-Identifier: Apache-2.0
import { and, desc, eq, exists, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { decryptContent, type ContentKey } from "./crypto";
import { listNotes } from "./notes";
import { listSystemEvents } from "./collab";
import {
  stripHtmlTags,
  tickForStatus,
  type MessageDTO,
  type SubmissionState,
  type ThreadDTO,
  type TimelineItem,
} from "./mail-thread-contract";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Read model. A thread DTO is assembled from thread + messages + THIS mailbox's
 * deliveries and thread_state, decrypting content on read. Shaped on JMAP
 * Email/Thread so a future JMAP API is a thin mapping. The timeline is a
 * discriminated union; only external_message is emitted this pass.
 *
 * Access is enforced by the caller (thread.remote.ts via can()); these functions
 * assume the mailbox is already authorized.
 */

export type ThreadSummary = {
  threadId: string;
  subject: string | null;
  snippet: string | null;
  from: string | null;
  lastMessageAt: number | null;
  isStarred: boolean;
  unread: boolean;
  /** Triage-at-a-glance for shared mailboxes (Task 5). */
  hasNotes: boolean;
  assigneeUserId: string | null;
};

// stripHtmlTags: stored stripped bodies are plain text by construction, but
// odd senders ship HTML inside text/plain — never let markup reach a list row.
function preview(text: string | null, n = 140): string | null {
  if (!text) return null;
  const clean = stripHtmlTags(text).replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

/**
 * Threads in a mailbox at a placement (inbox/archived/…), newest first.
 *
 * `sent` is a VIEW, not a placement: "threads where this mailbox sent
 * something" (a delivery with role `from`), whatever their placement short of
 * spam/trash. Gmail semantics — a replied-to sent thread shows in BOTH Sent and
 * Inbox; trashing removes it from Sent.
 */
export async function listThreads(
  db: Db,
  input: {
    mailboxId: string;
    placement: string;
    ck: ContentKey;
    limit?: number;
    /** Page offset for infinite scroll (rows to skip). */
    offset?: number;
    includeCollab?: boolean;
    /** Whose unread state to compute. Absent (no session) → everything unread. */
    userId?: string;
  },
): Promise<ThreadSummary[]> {
  const placementCond =
    input.placement === "sent"
      ? and(
          notInArray(schema.threadState.placement, ["spam", "trash"]),
          exists(
            db
              .select({ one: sql`1` })
              .from(schema.delivery)
              .innerJoin(schema.message, eq(schema.message.id, schema.delivery.messageId))
              .where(
                and(
                  eq(schema.delivery.mailboxId, input.mailboxId),
                  eq(schema.delivery.role, "from"),
                  eq(schema.message.threadId, schema.threadState.threadId),
                ),
              ),
          ),
        )
      : eq(schema.threadState.placement, input.placement);

  const states = await db
    .select({
      threadId: schema.threadState.threadId,
      isStarred: schema.threadState.isStarred,
      assigneeUserId: schema.threadState.assigneeUserId,
    })
    .from(schema.threadState)
    .innerJoin(schema.thread, eq(schema.thread.id, schema.threadState.threadId))
    .where(
      and(
        eq(schema.threadState.mailboxId, input.mailboxId),
        placementCond,
        isNull(schema.threadState.hiddenAt), // "emptied" trash/spam stays out
      ),
    )
    .orderBy(desc(schema.thread.lastMessageAt))
    .limit(input.limit ?? 30)
    .offset(input.offset ?? 0);

  // Per-USER read cursors for these threads (shared-mailbox unread is per person,
  // not per mailbox). One indexed read for the page, keyed to this user.
  const readByThread = new Map<string, number>();
  if (input.userId && states.length) {
    const reads = await db
      .select({ threadId: schema.threadRead.threadId, lastReadAt: schema.threadRead.lastReadAt })
      .from(schema.threadRead)
      .where(
        and(
          eq(schema.threadRead.userId, input.userId),
          eq(schema.threadRead.mailboxId, input.mailboxId),
          inArray(schema.threadRead.threadId, states.map((s) => s.threadId)),
        ),
      );
    for (const r of reads) if (r.lastReadAt) readByThread.set(r.threadId, r.lastReadAt.getTime());
  }

  // Latest message per thread (subject + snippet + from) in ONE window-function
  // query instead of a findFirst per row — uses message_thread_sent_idx.
  const threadIds = states.map((s) => s.threadId);
  type LatestRow = {
    threadId: string;
    subjectEnc: string | null;
    bodyStrippedEnc: string | null;
    fromAddr: string | null;
    sentAt: number | null;
  };
  const latestByThread = new Map<string, LatestRow>();
  if (threadIds.length) {
    const idList = sql.join(threadIds.map((id) => sql`${id}`), sql`, `);
    const rows = await db.all<LatestRow>(sql`
      SELECT thread_id AS "threadId", subject_enc AS "subjectEnc", body_stripped_enc AS "bodyStrippedEnc",
             from_addr AS "fromAddr", sent_at AS "sentAt"
      FROM (
        SELECT thread_id, subject_enc, body_stripped_enc, from_addr, sent_at,
               ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY sent_at DESC, rowid DESC) AS rn
        FROM message
        WHERE thread_id IN (${idList})
      ) WHERE rn = 1
    `);
    for (const r of rows) latestByThread.set(r.threadId, r);
  }

  // Which of these threads carry notes — one IN query, not a findFirst per row.
  const notedThreads = new Set<string>();
  if (input.includeCollab && threadIds.length) {
    const noteRows = await db
      .selectDistinct({ threadId: schema.internalNote.threadId })
      .from(schema.internalNote)
      .where(
        and(
          eq(schema.internalNote.mailboxId, input.mailboxId),
          inArray(schema.internalNote.threadId, threadIds),
          isNull(schema.internalNote.deletedAt),
        ),
      );
    for (const n of noteRows) notedThreads.add(n.threadId);
  }

  const out: ThreadSummary[] = [];
  for (const s of states) {
    const latest = latestByThread.get(s.threadId);
    const [subject, body] = await Promise.all([
      decryptContent(input.ck, latest?.subjectEnc),
      decryptContent(input.ck, latest?.bodyStrippedEnc),
    ]);
    const lastMessageAt = latest?.sentAt != null ? Number(latest.sentAt) : null;
    const lastReadAt = readByThread.get(s.threadId);
    out.push({
      threadId: s.threadId,
      subject,
      snippet: preview(body),
      from: latest?.fromAddr ?? null,
      lastMessageAt,
      isStarred: s.isStarred,
      unread: lastReadAt == null || (lastMessageAt != null && lastReadAt < lastMessageAt),
      hasNotes: notedThreads.has(s.threadId),
      assigneeUserId: input.includeCollab ? s.assigneeUserId : null,
    });
  }
  return out;
}

/**
 * Unread INBOX threads for (mailbox, user): thread newer than the user's read
 * cursor (or never read). One indexed count — feeds the sidebar badge + title.
 */
export async function countUnread(
  db: Db,
  input: { mailboxId: string; userId: string },
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.threadState)
    .innerJoin(schema.thread, eq(schema.thread.id, schema.threadState.threadId))
    .leftJoin(
      schema.threadRead,
      and(
        eq(schema.threadRead.threadId, schema.threadState.threadId),
        eq(schema.threadRead.mailboxId, input.mailboxId),
        eq(schema.threadRead.userId, input.userId),
      ),
    )
    .where(
      and(
        eq(schema.threadState.mailboxId, input.mailboxId),
        eq(schema.threadState.placement, "inbox"),
        isNull(schema.threadState.hiddenAt),
        or(
          isNull(schema.threadRead.lastReadAt),
          lt(schema.threadRead.lastReadAt, schema.thread.lastMessageAt),
        ),
      ),
    );
  return rows[0]?.n ?? 0;
}

/** Full thread DTO for a mailbox: timeline items + this mailbox's triage. */
export async function getThread(
  db: Db,
  input: { threadId: string; mailboxId: string; ck: ContentKey; includeCollab?: boolean; userId?: string },
): Promise<ThreadDTO | null> {
  const state = await db.query.threadState.findFirst({
    where: and(
      eq(schema.threadState.threadId, input.threadId),
      eq(schema.threadState.mailboxId, input.mailboxId),
    ),
    columns: { placement: true, isStarred: true, assigneeUserId: true },
  });
  if (!state) return null; // not delivered to this mailbox

  // This user's read cursor for the thread — per-message isRead is derived from
  // it (sent_at <= cursor), so read state is per person, not per mailbox.
  let readCursor: number | null = null;
  if (input.userId) {
    const r = await db.query.threadRead.findFirst({
      where: and(
        eq(schema.threadRead.userId, input.userId),
        eq(schema.threadRead.threadId, input.threadId),
        eq(schema.threadRead.mailboxId, input.mailboxId),
      ),
      columns: { lastReadAt: true },
    });
    readCursor = r?.lastReadAt ? r.lastReadAt.getTime() : null;
  }

  const messages = await db.query.message.findMany({
    where: eq(schema.message.threadId, input.threadId),
    orderBy: schema.message.sentAt,
  });
  const messageIds = messages.map((m) => m.id);

  // This mailbox's per-message receipts.
  const deliveries = messageIds.length
    ? await db
        .select({
          messageId: schema.delivery.messageId,
          role: schema.delivery.role,
          isRead: schema.delivery.isRead,
          keywords: schema.delivery.keywords,
          viaAliasId: schema.delivery.viaAliasId,
        })
        .from(schema.delivery)
        .where(
          and(
            eq(schema.delivery.mailboxId, input.mailboxId),
            inArray(schema.delivery.messageId, messageIds),
          ),
        )
    : [];
  const deliveryByMsg = new Map(deliveries.map((d) => [d.messageId, d]));
  // Messages THIS mailbox sent (it holds the `from` receipt). A message can
  // carry both `from` and `to` receipts here (self-send), so check the set —
  // and never infer "mine" from the submission row: a colleague's send in a
  // shared thread has a submission too, but it is not this mailbox's bubble.
  const sentFromHere = new Set(deliveries.filter((d) => d.role === "from").map((d) => d.messageId));

  // Resolve any alias ids → addresses (usually none).
  const aliasIds = [...new Set(deliveries.map((d) => d.viaAliasId).filter(Boolean))] as string[];
  const aliasAddr = new Map<string, string>();
  if (aliasIds.length) {
    const rows = await db
      .select({ id: schema.alias.id, address: schema.alias.address })
      .from(schema.alias)
      .where(inArray(schema.alias.id, aliasIds));
    for (const r of rows) aliasAddr.set(r.id, r.address);
  }

  // Send-state (Part H) for any outbound messages in this thread: submission
  // status → tick, plus per-recipient detail for multi-recipient sends.
  const submissionByMsg = await loadSubmissionStates(db, messageIds);

  // Attachment metadata per message (bytes stay in R2; served on demand).
  const attRows = messageIds.length
    ? await db
        .select({
          id: schema.attachment.id,
          messageId: schema.attachment.messageId,
          partId: schema.attachment.partId,
          filename: schema.attachment.filename,
          contentType: schema.attachment.contentType,
          size: schema.attachment.size,
        })
        .from(schema.attachment)
        .where(inArray(schema.attachment.messageId, messageIds))
    : [];
  const attByMsg = new Map<string, typeof attRows>();
  for (const a of attRows) {
    const l = attByMsg.get(a.messageId) ?? [];
    l.push(a);
    attByMsg.set(a.messageId, l);
  }

  const items: MessageDTO[] = [];
  let subject: string | null = null;
  for (const m of messages) {
    const [subj, stripped, full, html] = await Promise.all([
      decryptContent(input.ck, m.subjectEnc),
      decryptContent(input.ck, m.bodyStrippedEnc),
      decryptContent(input.ck, m.bodyFullEnc),
      decryptContent(input.ck, m.bodyHtmlEnc),
    ]);
    if (subject == null) subject = subj;
    const d = deliveryByMsg.get(m.id);
    const sentAt = m.sentAt ? m.sentAt.getTime() : null;
    const isRead = readCursor != null && sentAt != null && sentAt <= readCursor;
    const dto: MessageDTO = {
      type: "external_message",
      id: m.id,
      threadId: m.threadId,
      messageIdHeader: m.messageIdHeader,
      from: m.fromAddr,
      to: safeJsonArray(m.toAddrs),
      cc: safeJsonArray(m.ccAddrs),
      replyTo: m.replyTo,
      sentAt,
      contentKind: m.contentKind === "bubble" ? "bubble" : "card",
      subject: subj,
      bodyStripped: stripped,
      bodyFull: full,
      bodyHtml: html,
      keywords: safeJsonArray(d?.keywords),
      isRead,
      outbound: sentFromHere.has(m.id),
      viaAlias: d?.viaAliasId ? (aliasAddr.get(d.viaAliasId) ?? null) : null,
      viaAliasId: d?.viaAliasId ?? null,
      attachments: (attByMsg.get(m.id) ?? []).map((a) => ({
        id: a.id,
        partId: a.partId,
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      })),
      ...(submissionByMsg.has(m.id) ? { submission: submissionByMsg.get(m.id) } : {}),
    };
    items.push(dto);
  }

  const lastMessageAt = items.at(-1)?.sentAt ?? null;

  // Merge internal notes + system events for THIS mailbox into one ordered
  // timeline (Task 5) — ONLY for grant holders. A user reaching a thread via
  // org-admin read (no mailbox_access) gets messages only: notes/events are
  // never placed in a payload they aren't a member for.
  let timeline: TimelineItem[] = items;
  if (input.includeCollab) {
    const [notes, events] = await Promise.all([
      listNotes(db, input.ck, input.threadId, input.mailboxId),
      listSystemEvents(db, input.threadId, input.mailboxId),
    ]);
    timeline = [
      ...items,
      ...notes.map((n) => ({
        type: "internal_note" as const,
        id: n.id,
        authorUserId: n.authorUserId,
        body: n.body,
        editedAt: n.editedAt,
        deleted: n.deleted,
        at: n.createdAt,
      })),
      ...events.map((e) => ({
        type: "system_event" as const,
        id: e.id,
        actorUserId: e.actorUserId,
        eventType: e.eventType,
        data: e.data,
        at: e.createdAt,
      })),
    ];
    const atOf = (i: TimelineItem) => (i.type === "external_message" ? (i.sentAt ?? 0) : i.at);
    timeline.sort((a, b) => atOf(a) - atOf(b));
  }

  return {
    id: input.threadId,
    subject,
    lastMessageAt,
    placement: state.placement,
    isStarred: state.isStarred,
    assigneeUserId: state.assigneeUserId,
    items: timeline,
  };
}

/** Submission state per outbound message id: status→tick + per-recipient rows. */
async function loadSubmissionStates(
  db: Db,
  messageIds: string[],
): Promise<Map<string, SubmissionState>> {
  const out = new Map<string, SubmissionState>();
  if (!messageIds.length) return out;
  const subs = await db
    .select({
      id: schema.submission.id,
      messageId: schema.submission.messageId,
      status: schema.submission.status,
      lastError: schema.submission.lastError,
    })
    .from(schema.submission)
    .where(inArray(schema.submission.messageId, messageIds));
  if (!subs.length) return out;

  const recips = await db
    .select({
      submissionId: schema.submissionRecipient.submissionId,
      address: schema.submissionRecipient.address,
      role: schema.submissionRecipient.role,
      status: schema.submissionRecipient.status,
      bounceType: schema.submissionRecipient.bounceType,
    })
    .from(schema.submissionRecipient)
    .where(inArray(schema.submissionRecipient.submissionId, subs.map((s) => s.id)));
  const bySub = new Map<string, SubmissionState["perRecipient"]>();
  for (const r of recips) {
    const list = bySub.get(r.submissionId) ?? [];
    list.push({ address: r.address, role: r.role, status: r.status, bounceType: r.bounceType });
    bySub.set(r.submissionId, list);
  }

  for (const s of subs) {
    out.set(s.messageId, {
      status: s.status,
      tick: tickForStatus(s.status),
      lastError: s.lastError,
      perRecipient: bySub.get(s.id) ?? [],
    });
  }
  return out;
}

function safeJsonArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
