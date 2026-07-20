import { and, desc, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { decryptContent, type ContentKey } from "./crypto";
import { listNotes, threadHasNotes } from "./notes";
import { listSystemEvents } from "./collab";
import {
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

function preview(text: string | null, n = 140): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

/** Threads in a mailbox at a placement (inbox/archived/…), newest first. */
export async function listThreads(
  db: Db,
  input: { mailboxId: string; placement: string; ck: ContentKey; limit?: number; includeCollab?: boolean },
): Promise<ThreadSummary[]> {
  const states = await db
    .select({
      threadId: schema.threadState.threadId,
      isStarred: schema.threadState.isStarred,
      lastReadAt: schema.threadState.lastReadAt,
      assigneeUserId: schema.threadState.assigneeUserId,
    })
    .from(schema.threadState)
    .innerJoin(schema.thread, eq(schema.thread.id, schema.threadState.threadId))
    .where(
      and(
        eq(schema.threadState.mailboxId, input.mailboxId),
        eq(schema.threadState.placement, input.placement),
      ),
    )
    .orderBy(desc(schema.thread.lastMessageAt))
    .limit(input.limit ?? 50);

  // Latest message per thread for subject + snippet. N+1 is fine for a list page;
  // ponytail: swap for a window function if a mailbox ever holds huge threads.
  const out: ThreadSummary[] = [];
  for (const s of states) {
    const latest = await db.query.message.findFirst({
      where: eq(schema.message.threadId, s.threadId),
      orderBy: desc(schema.message.sentAt),
      columns: {
        subjectEnc: true,
        bodyStrippedEnc: true,
        fromAddr: true,
        sentAt: true,
      },
    });
    const [subject, body] = await Promise.all([
      decryptContent(input.ck, latest?.subjectEnc),
      decryptContent(input.ck, latest?.bodyStrippedEnc),
    ]);
    const lastMessageAt = latest?.sentAt ? latest.sentAt.getTime() : null;
    out.push({
      threadId: s.threadId,
      subject,
      snippet: preview(body),
      from: latest?.fromAddr ?? null,
      lastMessageAt,
      isStarred: s.isStarred,
      unread: !s.lastReadAt || (lastMessageAt != null && s.lastReadAt.getTime() < lastMessageAt),
      hasNotes: input.includeCollab ? await threadHasNotes(db, s.threadId, input.mailboxId) : false,
      assigneeUserId: input.includeCollab ? s.assigneeUserId : null,
    });
  }
  return out;
}

/** Full thread DTO for a mailbox: timeline items + this mailbox's triage. */
export async function getThread(
  db: Db,
  input: { threadId: string; mailboxId: string; ck: ContentKey; includeCollab?: boolean },
): Promise<ThreadDTO | null> {
  const state = await db.query.threadState.findFirst({
    where: and(
      eq(schema.threadState.threadId, input.threadId),
      eq(schema.threadState.mailboxId, input.mailboxId),
    ),
    columns: { placement: true, isStarred: true, assigneeUserId: true },
  });
  if (!state) return null; // not delivered to this mailbox

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
    const dto: MessageDTO = {
      type: "external_message",
      id: m.id,
      threadId: m.threadId,
      messageIdHeader: m.messageIdHeader,
      from: m.fromAddr,
      to: safeJsonArray(m.toAddrs),
      cc: safeJsonArray(m.ccAddrs),
      replyTo: m.replyTo,
      sentAt: m.sentAt ? m.sentAt.getTime() : null,
      contentKind: m.contentKind === "bubble" ? "bubble" : "card",
      subject: subj,
      bodyStripped: stripped,
      bodyFull: full,
      bodyHtml: html,
      keywords: safeJsonArray(d?.keywords),
      isRead: d?.isRead ?? false,
      viaAlias: d?.viaAliasId ? (aliasAddr.get(d.viaAliasId) ?? null) : null,
      viaAliasId: d?.viaAliasId ?? null,
      attachments: (attByMsg.get(m.id) ?? []).map((a) => ({
        id: a.id,
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
    .select({ id: schema.submission.id, messageId: schema.submission.messageId, status: schema.submission.status })
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
