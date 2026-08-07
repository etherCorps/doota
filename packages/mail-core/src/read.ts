// SPDX-License-Identifier: Apache-2.0
import { and, asc, desc, eq, exists, gt, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
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
  type CalendarInviteDTO,
  type InviteRsvpStatus,
} from "./mail-thread-contract";
import { trustedSenders } from "./sender-trust";
import { log } from "./log";

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
  /** Latest sender's display name (label only; `from` is the address). */
  fromName: string | null;
  /** Distinct people on the latest message (from + to + cc), capped at 4 — the
   * avatar faces. */
  participants: string[];
  /** Full distinct participant count (uncapped). >2 = a group thread; the list
   * renders an avatar stack + this count so it reads as one. */
  participantCount: number;
  lastMessageAt: number | null;
  isStarred: boolean;
  unread: boolean;
  /** Triage-at-a-glance for shared mailboxes (Task 5). */
  hasNotes: boolean;
  assigneeUserId: string | null;
  /** The thread's actual placement (inbox/archived/…). The Sent view is a
   * cross-cut, so a sent row can still live in Inbox — the UI badges that. */
  placement: string;
  /** Pin timestamp (ms) or null. Non-null = shown pinned atop its list. */
  pinnedAt: number | null;
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
    /** Assigned-only grantee: show ONLY threads assigned to this user id
     * (from assignedOnlyFor; null/undefined = full mailbox). */
    assignedTo?: string | null;
    /** Folder view: threads carrying this label (any placement short of
     * spam/trash), like `sent` a VIEW — `placement` is ignored when set. */
    labelId?: string;
    /** Pinned-list mode: only pinned threads of this view, newest-pin first.
     * Served by the partial pinned index, so the main list index is untouched. */
    pinnedOnly?: boolean;
  },
): Promise<ThreadSummary[]> {
  // `snoozed` is a VIEW like `sent`: any non-spam/trash thread with a pending
  // snooze, soonest-to-wake first. Every other placement EXCLUDES snoozed threads
  // (they've left the inbox until the cron wakes them — see the where clause).
  const isSnoozedView = input.placement === "snoozed" && !input.labelId;
  const placementCond = input.labelId
    ? and(
        notInArray(schema.threadState.placement, ["spam", "trash"]),
        exists(
          db
            .select({ one: sql`1` })
            .from(schema.threadLabel)
            .where(
              and(
                eq(schema.threadLabel.mailboxId, input.mailboxId),
                eq(schema.threadLabel.labelId, input.labelId),
                eq(schema.threadLabel.threadId, schema.threadState.threadId),
              ),
            ),
        ),
      )
    : input.placement === "sent"
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
      : isSnoozedView
        ? and(
            notInArray(schema.threadState.placement, ["spam", "trash"]),
            isNotNull(schema.threadState.snoozedUntil),
          )
        : eq(schema.threadState.placement, input.placement);

  // Sort on the denormalized recency column (mirrors thread.last_message_at) so
  // thread_state_list_idx serves ORDER BY + LIMIT without joining `thread`.
  const states = await db
    .select({
      threadId: schema.threadState.threadId,
      isStarred: schema.threadState.isStarred,
      assigneeUserId: schema.threadState.assigneeUserId,
      placement: schema.threadState.placement,
      lastInboundAt: schema.threadState.lastInboundAt,
      lastActivityAt: schema.threadState.lastActivityAt,
      pinnedAt: schema.threadState.pinnedAt,
    })
    .from(schema.threadState)
    .where(
      and(
        eq(schema.threadState.mailboxId, input.mailboxId),
        placementCond,
        isNull(schema.threadState.hiddenAt), // "emptied" trash/spam stays out
        // Snoozed threads are hidden from every other view until they wake.
        isSnoozedView ? undefined : isNull(schema.threadState.snoozedUntil),
        // Pinned-list mode: restrict to the pinned set (partial index).
        input.pinnedOnly ? isNotNull(schema.threadState.pinnedAt) : undefined,
        input.assignedTo
          ? eq(schema.threadState.assigneeUserId, input.assignedTo)
          : undefined,
      ),
    )
    .orderBy(
      input.pinnedOnly
        ? desc(schema.threadState.pinnedAt) // newest pin on top
        : isSnoozedView
          ? asc(schema.threadState.snoozedUntil) // next to wake at the top
          : desc(schema.threadState.lastActivityAt),
    )
    .limit(input.pinnedOnly ? 50 : (input.limit ?? 30))
    .offset(input.pinnedOnly ? 0 : (input.offset ?? 0));

  // Unread keys on the mailbox mode (same model as unreadCount below):
  // personal → last_inbound_at (an own send never marks unread), shared →
  // last_activity_at (a teammate's send does).
  const listBox = await db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, input.mailboxId),
    columns: { isPersonal: true },
  });

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
    fromName: string | null;
    toAddrs: string | null;
    ccAddrs: string | null;
    sentAt: number | null;
  };
  const latestByThread = new Map<string, LatestRow>();
  if (threadIds.length) {
    const idList = sql.join(threadIds.map((id) => sql`${id}`), sql`, `);
    // Personal mailbox: the preview must be the latest message THIS mailbox was a
    // party to, not the globally-latest (which could be a colleague's reply it
    // can't see). Shared mailbox: whole conversation, so globally-latest. Mirrors
    // getThread's visibility model.
    const mbox = await db.query.mailbox.findFirst({
      where: eq(schema.mailbox.id, input.mailboxId),
      columns: { isPersonal: true },
    });
    const visibleCond = mbox?.isPersonal
      ? sql`AND id IN (SELECT message_id FROM delivery WHERE mailbox_id = ${input.mailboxId})`
      : sql``;
    const rows = await db.all<LatestRow>(sql`
      SELECT thread_id AS "threadId", subject_enc AS "subjectEnc", body_stripped_enc AS "bodyStrippedEnc",
             from_addr AS "fromAddr", from_name AS "fromName", to_addrs AS "toAddrs", cc_addrs AS "ccAddrs", sent_at AS "sentAt"
      FROM (
        SELECT thread_id, subject_enc, body_stripped_enc, from_addr, from_name, to_addrs, cc_addrs, sent_at,
               ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY sent_at DESC, rowid DESC) AS rn
        FROM message
        WHERE thread_id IN (${idList}) ${visibleCond}
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
    // Distinct people on the latest message — from + to + cc, deduped by bare
    // address (case-insensitive). `participants` caps at 4 (for avatars);
    // `participantCount` is the full distinct total (>2 = a group thread).
    const seen = new Set<string>();
    const participants: string[] = [];
    for (const a of [latest?.fromAddr ?? "", ...safeJsonArray(latest?.toAddrs), ...safeJsonArray(latest?.ccAddrs)]) {
      const key = (a.match(/<([^>]+)>/)?.[1] ?? a).trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (participants.length < 4) participants.push(a);
    }
    const participantCount = seen.size;
    out.push({
      threadId: s.threadId,
      subject,
      snippet: preview(body),
      from: latest?.fromAddr ?? null,
      fromName: latest?.fromName ?? null,
      participants,
      participantCount,
      lastMessageAt,
      isStarred: s.isStarred,
      // Personal: only inbound counts — an own-sent(-only) thread is read by
      // definition. Shared: any activity after the cursor counts (the sender's
      // own cursor is bumped at send time in sendDraft).
      unread: (() => {
        const newestRelevantAt = listBox?.isPersonal
          ? (s.lastInboundAt?.getTime() ?? null)
          : (s.lastActivityAt?.getTime() ?? lastMessageAt);
        return newestRelevantAt != null && (lastReadAt == null || lastReadAt < newestRelevantAt);
      })(),
      hasNotes: notedThreads.has(s.threadId),
      assigneeUserId: input.includeCollab ? s.assigneeUserId : null,
      placement: s.placement,
      pinnedAt: s.pinnedAt?.getTime() ?? null,
    });
  }
  return out;
}

export type UnreadNotice = {
  threadId: string;
  mailboxId: string;
  from: string | null;
  fromName: string | null;
  subject: string | null;
  at: number | null;
};

/**
 * Recent unread INBOX threads across the given mailboxes, for the notification
 * bell. "Unread" keys on last_inbound_at (a recipient-role message newer than
 * the user's read cursor) so an own send never shows up. Newest first, capped.
 */
export async function recentUnread(
  db: Db,
  input: {
    userId: string;
    ck: ContentKey;
    mailboxIds: string[];
    /** Mailboxes where this user only sees threads assigned to them. */
    assignedOnlyMailboxIds?: string[];
    limit?: number;
  },
): Promise<UnreadNotice[]> {
  if (!input.mailboxIds.length) return [];
  const restricted = input.assignedOnlyMailboxIds?.length
    ? or(
        notInArray(schema.threadState.mailboxId, input.assignedOnlyMailboxIds),
        eq(schema.threadState.assigneeUserId, input.userId),
      )
    : undefined;
  const states = await db
    .select({
      threadId: schema.threadState.threadId,
      mailboxId: schema.threadState.mailboxId,
    })
    .from(schema.threadState)
    .leftJoin(
      schema.threadRead,
      and(
        eq(schema.threadRead.threadId, schema.threadState.threadId),
        eq(schema.threadRead.mailboxId, schema.threadState.mailboxId),
        eq(schema.threadRead.userId, input.userId),
      ),
    )
    .where(
      and(
        inArray(schema.threadState.mailboxId, input.mailboxIds),
        eq(schema.threadState.placement, "inbox"),
        isNull(schema.threadState.hiddenAt),
        isNull(schema.threadState.snoozedUntil), // snoozed = out of inbox, not unread
        restricted,
        isNotNull(schema.threadState.lastInboundAt),
        or(
          isNull(schema.threadRead.lastReadAt),
          gt(schema.threadState.lastInboundAt, schema.threadRead.lastReadAt),
        ),
      ),
    )
    .orderBy(desc(schema.threadState.lastInboundAt))
    .limit(input.limit ?? 8);

  // Display line per thread: newest message's sender + subject. Few rows, so a
  // parallel findFirst each is cheaper than a window query.
  return Promise.all(
    states.map(async (s) => {
      const m = await db.query.message.findFirst({
        where: eq(schema.message.threadId, s.threadId),
        orderBy: desc(schema.message.sentAt),
        columns: { fromAddr: true, fromName: true, subjectEnc: true, sentAt: true },
      });
      return {
        threadId: s.threadId,
        mailboxId: s.mailboxId,
        from: m?.fromAddr ?? null,
        fromName: m?.fromName ?? null,
        subject: await decryptContent(input.ck, m?.subjectEnc),
        at: m?.sentAt ? m.sentAt.getTime() : null,
      };
    }),
  );
}

/**
 * Unread INBOX threads for (mailbox, user): thread newer than the user's read
 * cursor (or never read). One indexed count — feeds the sidebar badge + title.
 */
export async function countUnread(
  db: Db,
  input: { mailboxId: string; userId: string; assignedTo?: string | null },
): Promise<number> {
  const mbox = await db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, input.mailboxId),
    columns: { isPersonal: true },
  });
  // "Unread" = the newest relevant message is after the user's read cursor,
  // read straight off the denormalized thread_state columns (no delivery scan,
  // no `thread` join):
  //  - PERSONAL: only messages delivered here count → last_inbound_at (NULL when
  //    nothing inbound has landed, so an own-sent-only thread is never unread).
  //  - SHARED: the whole conversation is visible → last_activity_at (mirrors
  //    thread.last_message_at, the prior authority).
  const newerThanCursor = mbox?.isPersonal
    ? and(
        isNotNull(schema.threadState.lastInboundAt),
        or(
          isNull(schema.threadRead.lastReadAt),
          gt(schema.threadState.lastInboundAt, schema.threadRead.lastReadAt),
        ),
      )
    : or(
        isNull(schema.threadRead.lastReadAt),
        lt(schema.threadRead.lastReadAt, schema.threadState.lastActivityAt),
      );

  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.threadState)
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
        isNull(schema.threadState.snoozedUntil), // snoozed = out of inbox, not unread
        input.assignedTo ? eq(schema.threadState.assigneeUserId, input.assignedTo) : undefined,
        newerThanCursor,
      ),
    );
  return rows[0]?.n ?? 0;
}

/**
 * Unread thread count per label for (mailbox, user) — the sidebar's folder
 * badges in one grouped query (mirrors countUnread's cursor predicate, but
 * over any non-spam/trash placement: a filed thread is exactly the one whose
 * unread state the folder badge must carry).
 */
export async function countUnreadByLabel(
  db: Db,
  input: { mailboxId: string; userId: string },
): Promise<Map<string, number>> {
  const mbox = await db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, input.mailboxId),
    columns: { isPersonal: true },
  });
  const newerThanCursor = mbox?.isPersonal
    ? and(
        isNotNull(schema.threadState.lastInboundAt),
        or(
          isNull(schema.threadRead.lastReadAt),
          gt(schema.threadState.lastInboundAt, schema.threadRead.lastReadAt),
        ),
      )
    : or(
        isNull(schema.threadRead.lastReadAt),
        lt(schema.threadRead.lastReadAt, schema.threadState.lastActivityAt),
      );
  const rows = await db
    .select({ labelId: schema.threadLabel.labelId, n: sql<number>`count(*)` })
    .from(schema.threadLabel)
    .innerJoin(
      schema.threadState,
      and(
        eq(schema.threadState.threadId, schema.threadLabel.threadId),
        eq(schema.threadState.mailboxId, input.mailboxId),
      ),
    )
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
        eq(schema.threadLabel.mailboxId, input.mailboxId),
        notInArray(schema.threadState.placement, ["spam", "trash"]),
        isNull(schema.threadState.hiddenAt),
        isNull(schema.threadState.snoozedUntil),
        newerThanCursor,
      ),
    )
    .groupBy(schema.threadLabel.labelId);
  return new Map(rows.map((r) => [r.labelId, r.n]));
}

/** Full thread DTO for a mailbox: timeline items + this mailbox's triage. */
export async function getThread(
  db: Db,
  input: {
    threadId: string;
    mailboxId: string;
    ck: ContentKey;
    includeCollab?: boolean;
    userId?: string;
    /** Assigned-only grantee: the thread opens only if assigned to this user. */
    assignedTo?: string | null;
  },
): Promise<ThreadDTO | null> {
  // Phase timing (debug-only): openThread was reported slow; these marks say
  // WHICH wave eats the time (dev proxy vs D1 vs assembly) instead of guessing.
  const tStart = Date.now();
  let tPreamble = 0;
  let tMessages = 0;
  let tBatch = 0;
  // Preamble: three independent reads in parallel (was three serial round-trips).
  //  - state gates the whole thing (thread must be in this mailbox);
  //  - readRow → the user's read cursor (per-message isRead derives from it);
  //  - mbox.isPersonal drives the visibility model below.
  const [state, readRow, mbox] = await Promise.all([
    db.query.threadState.findFirst({
      where: and(
        eq(schema.threadState.threadId, input.threadId),
        eq(schema.threadState.mailboxId, input.mailboxId),
      ),
      columns: { placement: true, isStarred: true, pinnedAt: true, assigneeUserId: true },
    }),
    input.userId
      ? db.query.threadRead.findFirst({
          where: and(
            eq(schema.threadRead.userId, input.userId),
            eq(schema.threadRead.threadId, input.threadId),
            eq(schema.threadRead.mailboxId, input.mailboxId),
          ),
          columns: { lastReadAt: true },
        })
      : Promise.resolve(null),
    db.query.mailbox.findFirst({
      where: eq(schema.mailbox.id, input.mailboxId),
      columns: { isPersonal: true },
    }),
  ]);
  tPreamble = Date.now();
  if (!state) return null; // not delivered to this mailbox
  // Assigned-only grantee: not theirs → invisible (same 404 as "not in this
  // mailbox", so the restriction never leaks the thread's existence).
  if (input.assignedTo && state.assigneeUserId !== input.assignedTo) return null;
  const readCursor = readRow?.lastReadAt ? readRow.lastReadAt.getTime() : null;

  // Visibility model: a SHARED mailbox shows the whole conversation (team
  // transparency, Front/Missive-style); a PERSONAL mailbox shows only the
  // messages it was actually a party to (Gmail-style) — so a colleague's reply
  // that dropped this address never leaks into a coincidentally-shared thread.
  let messages: (typeof schema.message.$inferSelect)[];
  if (mbox?.isPersonal) {
    const delivered = await db
      .select({ messageId: schema.delivery.messageId })
      .from(schema.delivery)
      .innerJoin(schema.message, eq(schema.message.id, schema.delivery.messageId))
      .where(
        and(
          eq(schema.delivery.mailboxId, input.mailboxId),
          eq(schema.message.threadId, input.threadId),
        ),
      );
    const ids = delivered.map((d) => d.messageId);
    // Empty is legitimate — a note-only thread, or one where every message
    // dropped this address. Show no messages but keep the thread (notes/state).
    messages = ids.length
      ? await db.query.message.findMany({
          where: and(eq(schema.message.threadId, input.threadId), inArray(schema.message.id, ids)),
          orderBy: schema.message.sentAt,
        })
      : [];
  } else {
    messages = await db.query.message.findMany({
      where: eq(schema.message.threadId, input.threadId),
      orderBy: schema.message.sentAt,
    });
  }
  const messageIds = messages.map((m) => m.id);
  tMessages = Date.now();

  // Header index + the reply-parents this mailbox can't see (Cc-added case) —
  // computed now so the hidden-parent fetch joins the one parallel batch below.
  const visibleByHeader = new Map(messages.map((m) => [m.messageIdHeader, m]));
  const hiddenHeaders = [
    ...new Set(
      messages.map((m) => m.inReplyTo).filter((h): h is string => !!h && !visibleByHeader.has(h)),
    ),
  ];

  // ONE parallel batch for everything keyed on the message set — this was a
  // serial chain of ~6 round-trips and the dominant cost of opening a thread.
  const [deliveries, submissionByMsg, attRows, trustedFrom, hiddenParentRows, collab, calendarRows] =
    await Promise.all([
      messageIds.length
        ? db
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
        : Promise.resolve([]),
      loadSubmissionStates(db, messageIds, input.userId ?? null),
      messageIds.length
        ? db
            .select({
              id: schema.attachment.id,
              messageId: schema.attachment.messageId,
              partId: schema.attachment.partId,
              filename: schema.attachment.filename,
              contentType: schema.attachment.contentType,
              size: schema.attachment.size,
              inline: schema.attachment.inline,
            })
            .from(schema.attachment)
            .where(inArray(schema.attachment.messageId, messageIds))
        : Promise.resolve([]),
      // Per-sender image trust (display default only) — the body route still
      // proxies everything; this just picks the initial images=0|1.
      input.userId
        ? trustedSenders(db, input.userId, messages.map((m) => m.fromAddr ?? "").filter(Boolean))
        : Promise.resolve(new Set<string>()),
      hiddenHeaders.length
        ? db.query.message.findMany({
            where: and(
              eq(schema.message.threadId, input.threadId),
              inArray(schema.message.messageIdHeader, hiddenHeaders),
            ),
          })
        : Promise.resolve([] as (typeof messages)),
      // Notes + system events for grant holders (Task 5) — only for members.
      input.includeCollab
        ? Promise.all([
            listNotes(db, input.ck, input.threadId, input.mailboxId),
            listSystemEvents(db, input.threadId, input.mailboxId),
          ])
        : Promise.resolve(null),
      // Calendar invites carried by these messages (one per message at most).
      messageIds.length
        ? db
            .select()
            .from(schema.calendarEvent)
            .where(inArray(schema.calendarEvent.messageId, messageIds))
        : Promise.resolve([]),
    ]);
  tBatch = Date.now();

  const parseAttendees = (json: string): CalendarInviteDTO["attendees"] => {
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? (v as CalendarInviteDTO["attendees"]) : [];
    } catch {
      return [];
    }
  };
  // Decrypt + hydrate invites, folding in the viewer's local RSVP (keyed by UID).
  const inviteByMsg = new Map<string, CalendarInviteDTO>();
  if (calendarRows.length) {
    const uids = [...new Set(calendarRows.map((c) => c.uid))];
    const rsvpRows = input.userId
      ? await db
          .select({ uid: schema.calendarRsvp.uid, status: schema.calendarRsvp.status })
          .from(schema.calendarRsvp)
          .where(
            and(eq(schema.calendarRsvp.userId, input.userId), inArray(schema.calendarRsvp.uid, uids)),
          )
      : [];
    const rsvpByUid = new Map(rsvpRows.map((r) => [r.uid, r.status as InviteRsvpStatus]));
    await Promise.all(
      calendarRows.map(async (c) => {
        // details_enc is a JSON blob of the sensitive free-text; a decrypt failure
        // (rotated key / tamper) must not sink the whole thread — degrade to null.
        let details: { summary?: string; description?: string; location?: string; joinUrl?: string; rsvpLinks?: CalendarInviteDTO["rsvpLinks"] } = {};
        try {
          const raw = await decryptContent(input.ck, c.detailsEnc);
          if (raw) details = JSON.parse(raw);
        } catch {
          details = {};
        }
        inviteByMsg.set(c.messageId, {
          uid: c.uid,
          method: c.method,
          status: c.status,
          summary: details.summary ?? null,
          description: details.description ?? null,
          location: details.location ?? null,
          startMs: c.startMs,
          endMs: c.endMs,
          tz: c.tz,
          allDay: c.allDay,
          organizer: { email: c.organizerEmail, name: c.organizerName },
          attendees: parseAttendees(c.attendeesJson),
          meetingPlatform: c.meetingPlatform as CalendarInviteDTO["meetingPlatform"],
          calOrigin: c.calOrigin as CalendarInviteDTO["calOrigin"],
          joinUrl: details.joinUrl ?? null,
          rsvpLinks: details.rsvpLinks ?? { accepted: null, declined: null, tentative: null },
          myRsvp: rsvpByUid.get(c.uid) ?? null,
        });
      }),
    );
  }

  const deliveryByMsg = new Map(deliveries.map((d) => [d.messageId, d]));
  // Messages THIS mailbox sent (it holds the `from` receipt). A message can
  // carry both `from` and `to` receipts here (self-send), so check the set —
  // and never infer "mine" from the submission row: a colleague's send in a
  // shared thread has a submission too, but it is not this mailbox's bubble.
  const sentFromHere = new Set(deliveries.filter((d) => d.role === "from").map((d) => d.messageId));
  const attByMsg = new Map<string, typeof attRows>();
  for (const a of attRows) {
    const l = attByMsg.get(a.messageId) ?? [];
    l.push(a);
    attByMsg.set(a.messageId, l);
  }

  // Alias ids → addresses (usually none) — depends on `deliveries`, so it trails
  // the batch; small and rare.
  const aliasIds = [...new Set(deliveries.map((d) => d.viaAliasId).filter(Boolean))] as string[];
  const aliasAddr = new Map<string, string>();
  if (aliasIds.length) {
    const rows = await db
      .select({ id: schema.alias.id, address: schema.alias.address })
      .from(schema.alias)
      .where(inArray(schema.alias.id, aliasIds));
    for (const r of rows) aliasAddr.set(r.id, r.address);
  }

  // Reply context per message. Two shapes:
  //  - parent IS visible (accessible) → a one-line preview that links to it, so a
  //    reply to an OLDER message can jump back.
  //  - parent NOT visible (a personal mailbox added on Cc) → the FULL parent text,
  //    because a half-shown message is worse than none — plus the hidden ancestor
  //    chain above it (`ancestors`, oldest first), so the newcomer gets the whole
  //    conversation, not one hop. The walk stops at a visible message (the reader
  //    can scroll to it) or a gap; depth cap guards cycles.
  const replyContextByMsg = new Map<
    string,
    {
      from: string | null;
      sentAt: number | null;
      parentId: string | null;
      text: string;
      ancestors?: { from: string | null; sentAt: number | null; text: string }[];
    }
  >();
  if (messages.length) {
    // visibleByHeader + the hidden parents were fetched in the batch above.
    const hiddenByHeader = new Map<string, (typeof messages)[number]>();
    for (const p of hiddenParentRows) hiddenByHeader.set(p.messageIdHeader, p);
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m.inReplyTo) continue;
      const visibleParent = visibleByHeader.get(m.inReplyTo);
      if (visibleParent) {
        // WhatsApp-style: show the quoted reference for every reply (even to the
        // message directly above) — it's the click target to jump back.
        replyContextByMsg.set(m.id, {
          from: visibleParent.fromAddr,
          sentAt: visibleParent.sentAt ? visibleParent.sentAt.getTime() : null,
          parentId: visibleParent.id,
          text: preview(await decryptContent(input.ck, visibleParent.bodyStrippedEnc), 120) ?? "",
        });
      } else {
        // Walk the hidden chain: immediate parent + any older hidden ancestors.
        const chain: (typeof messages)[number][] = [];
        const seen = new Set<string>();
        let ref: string | null = m.inReplyTo;
        while (ref && chain.length < 5 && !seen.has(ref) && !visibleByHeader.has(ref)) {
          seen.add(ref);
          let h = hiddenByHeader.get(ref);
          if (!h) {
            h = await db.query.message.findFirst({
              where: and(
                eq(schema.message.threadId, input.threadId),
                eq(schema.message.messageIdHeader, ref),
              ),
            });
            if (h) hiddenByHeader.set(ref, h);
          }
          if (!h) break;
          chain.push(h);
          ref = h.inReplyTo;
        }
        if (!chain.length) continue;
        const [parent, ...older] = chain;
        const ancestors = await Promise.all(
          older.reverse().map(async (a) => ({
            from: a.fromAddr,
            sentAt: a.sentAt ? a.sentAt.getTime() : null,
            text: (await decryptContent(input.ck, a.bodyStrippedEnc)) ?? "",
          })),
        );
        replyContextByMsg.set(m.id, {
          from: parent.fromAddr,
          sentAt: parent.sentAt ? parent.sentAt.getTime() : null,
          parentId: null,
          text: (await decryptContent(input.ck, parent.bodyStrippedEnc)) ?? "",
          ...(ancestors.length ? { ancestors } : {}),
        });
      }
    }
  }

  // Decrypt + assemble EVERY message in parallel — this was a serial loop that
  // awaited each message's decrypts before starting the next (N sequential
  // round-trips of AES-GCM over the bodies).
  const items: MessageDTO[] = await Promise.all(
    messages.map(async (m): Promise<MessageDTO> => {
    const [subj, stripped, full] = await Promise.all([
      decryptContent(input.ck, m.subjectEnc),
      decryptContent(input.ck, m.bodyStrippedEnc),
      decryptContent(input.ck, m.bodyFullEnc),
    ]);
    const d = deliveryByMsg.get(m.id);
    const sentAt = m.sentAt ? m.sentAt.getTime() : null;
    const isRead = readCursor != null && sentAt != null && sentAt <= readCursor;
    const dto: MessageDTO = {
      type: "external_message",
      id: m.id,
      threadId: m.threadId,
      messageIdHeader: m.messageIdHeader,
      from: m.fromAddr,
      fromName: m.fromName,
      to: safeJsonArray(m.toAddrs),
      cc: safeJsonArray(m.ccAddrs),
      replyTo: m.replyTo,
      sentAt,
      contentKind: m.contentKind === "bubble" ? "bubble" : "card",
      subject: subj,
      bodyStripped: stripped,
      bodyFull: full,
      // Raw HTML never leaves the server — only the render decision + flags do.
      // Computed at ingest (materialize) + stored, so the read path never touches
      // the body. The sandboxed /api/messages/[id]/body route derives + sanitizes
      // the html from the R2 raw on demand.
      htmlKind: (m.htmlKind as "rich" | "plain" | null) ?? null,
      hasRemoteImages: m.hasRemoteImages,
      senderTrusted: !!m.fromAddr && trustedFrom.has(m.fromAddr.toLowerCase()),
      senderVerified: m.dmarcPass,
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
        inline: a.inline,
      })),
      ...(submissionByMsg.has(m.id) ? { submission: submissionByMsg.get(m.id) } : {}),
      ...(replyContextByMsg.has(m.id) ? { replyContext: replyContextByMsg.get(m.id) } : {}),
      ...(inviteByMsg.has(m.id) ? { calendarInvite: inviteByMsg.get(m.id) } : {}),
    };
    return dto;
    }),
  );
  // Thread subject = the first message's subject (messages are sent-ordered).
  const subject = items[0]?.subject ?? null;

  const lastMessageAt = items.at(-1)?.sentAt ?? null;

  // Merge internal notes + system events for THIS mailbox into one ordered
  // timeline (Task 5) — ONLY for grant holders. A user reaching a thread via
  // org-admin read (no mailbox_access) gets messages only: notes/events are
  // never placed in a payload they aren't a member for.
  let timeline: TimelineItem[] = items;
  if (collab) {
    const [notes, events] = collab;
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

  const tEnd = Date.now();
  log.debug("read.thread_timing", {
    threadId: input.threadId,
    msgs: messages.length,
    preambleMs: tPreamble - tStart,
    messagesMs: tMessages - tPreamble,
    batchMs: tBatch - tMessages,
    assembleMs: tEnd - tBatch,
    totalMs: tEnd - tStart,
  });

  return {
    id: input.threadId,
    subject,
    lastMessageAt,
    placement: state.placement,
    isStarred: state.isStarred,
    pinnedAt: state.pinnedAt?.getTime() ?? null,
    assigneeUserId: state.assigneeUserId,
    items: timeline,
  };
}

/** Submission state per outbound message id: status→tick + per-recipient rows. */
async function loadSubmissionStates(
  db: Db,
  messageIds: string[],
  userId: string | null,
): Promise<Map<string, SubmissionState>> {
  const out = new Map<string, SubmissionState>();
  if (!messageIds.length) return out;
  const subs = await db
    .select({
      id: schema.submission.id,
      messageId: schema.submission.messageId,
      status: schema.submission.status,
      lastError: schema.submission.lastError,
      createdByUserId: schema.submission.createdByUserId,
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
      id: s.id,
      status: s.status,
      tick: tickForStatus(s.status),
      lastError: s.lastError,
      // Renders the Retry affordance for the author only. UI hint, not the
      // authorization — retryFailedSend re-checks ownership server-side.
      mine: !!userId && s.createdByUserId === userId,
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
