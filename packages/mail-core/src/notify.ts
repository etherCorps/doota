// SPDX-License-Identifier: Apache-2.0
import { and, eq, inArray, isNull, isNotNull, lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { notifyNotification, type EventHubNamespace } from "./events-hub";
import { sendPushToUser, type WebPushEnv } from "./web-push";

type Db = DrizzleD1Database<typeof schema>;

const threadUrl = (mailboxId: string | null, threadId: string | null): string =>
  mailboxId && threadId ? `/app?mailbox=${mailboxId}&thread=${threadId}` : threadId ? `/app?thread=${threadId}` : "/app";

/** VAPID `sub` — self-deployed, so the sender identity is the org's own domain
 * (per push, no env var). Falls back to a harmless URL when the org has none. */
async function orgSubject(db: Db, orgId: string): Promise<string> {
  const org = await db.query.organization.findFirst({
    where: eq(schema.organization.id, orgId),
    columns: { domain: true },
  });
  return org?.domain ? `https://${org.domain}` : "https://push.local";
}

/**
 * Durable notification writes (docs/notifications.md, Phase A). Rows carry
 * STRUCTURAL refs only — the display string is resolved at read/send time from
 * cleartext fields, so no subject line is ever stored. Every writer is
 * best-effort at the call site: a notification failure must never fail mail
 * delivery or a triage action.
 */

/**
 * Users to notify of new mail in a mailbox: full-access members always; an
 * assigned-only member ONLY when this thread is currently theirs (they can't
 * open threads that aren't assigned to them, so notifying would dead-end).
 */
async function newMailRecipients(db: Db, mailboxId: string, threadId: string): Promise<string[]> {
  const [access, state] = await Promise.all([
    db
      .select({
        userId: mail.mailboxAccess.userId,
        assignedOnly: mail.mailboxAccess.assignedOnly,
        canManage: mail.mailboxAccess.canManage,
      })
      .from(mail.mailboxAccess)
      .where(eq(mail.mailboxAccess.mailboxId, mailboxId)),
    db.query.threadState.findFirst({
      where: and(eq(mail.threadState.threadId, threadId), eq(mail.threadState.mailboxId, mailboxId)),
      columns: { assigneeUserId: true },
    }),
  ]);
  const assignee = state?.assigneeUserId ?? null;
  return access.filter((a) => !a.assignedOnly || a.canManage || a.userId === assignee).map((a) => a.userId);
}

/** The user opened/read a thread from the LIST (not the bell) — clear their
 * unread new_mail notifications for it and ping their stream so the bell +
 * sidebar drop live. No-op (and no ping) when nothing was unread. */
export async function markThreadNotificationsRead(
  db: Db,
  userId: string,
  threadId: string,
  hub?: EventHubNamespace,
): Promise<void> {
  const cleared = await db
    .update(mail.notification)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(mail.notification.userId, userId),
        eq(mail.notification.threadId, threadId),
        eq(mail.notification.type, "new_mail"),
        isNull(mail.notification.readAt),
      ),
    )
    .returning({ id: mail.notification.id });
  if (cleared.length) await notifyNotification(hub, userId);
}

/** New mail landed in a thread — one unread row per eligible recipient,
 * collapsing a reply burst per (user, thread). `excludeUserId` drops the sender
 * on an INTERNAL (in-system) delivery so they don't notify themselves. */
export async function recordNewMail(
  db: Db,
  input: { orgId: string; mailboxId: string; threadId: string; excludeUserId?: string },
  push?: WebPushEnv,
): Promise<void> {
  let userIds = await newMailRecipients(db, input.mailboxId, input.threadId);
  if (input.excludeUserId) userIds = userIds.filter((u) => u !== input.excludeUserId);
  if (!userIds.length) return;
  // Bump an existing unread new_mail row (reset seenAt so the bell re-lights)
  // instead of stacking a second row for the same thread.
  const existing = await db
    .select({ id: mail.notification.id, userId: mail.notification.userId })
    .from(mail.notification)
    .where(
      and(
        eq(mail.notification.threadId, input.threadId),
        eq(mail.notification.type, "new_mail"),
        isNull(mail.notification.readAt),
        inArray(mail.notification.userId, userIds),
      ),
    );
  if (existing.length) {
    await db
      .update(mail.notification)
      .set({ createdAt: new Date(), seenAt: null })
      .where(inArray(mail.notification.id, existing.map((e) => e.id)));
  }
  const bumped = new Set(existing.map((e) => e.userId));
  const fresh = userIds.filter((u) => !bumped.has(u));
  if (fresh.length) {
    // onConflictDoNothing collapses the race where two concurrent consumers both
    // SELECT-miss above and both insert for the same (user, thread): the unique
    // partial index (notification_dedupe_idx, new_mail + unread) keeps one row.
    await db
      .insert(mail.notification)
      .values(
        fresh.map((userId) => ({
          userId,
          orgId: input.orgId,
          type: "new_mail",
          mailboxId: input.mailboxId,
          threadId: input.threadId,
        })),
      )
      .onConflictDoNothing();
  }
  // OS push (app closed) for every eligible recipient — tag per thread so a
  // reply burst collapses. Best-effort; no-op without VAPID.
  if (push) {
    const subject = await orgSubject(db, input.orgId);
    const payload = {
      title: "New message",
      body: "You have new mail",
      url: threadUrl(input.mailboxId, input.threadId),
      tag: `thread-${input.threadId}`,
    };
    await Promise.all(userIds.map((u) => sendPushToUser(db, push, u, payload, subject).catch(() => {})));
  }
}

/** A thread was assigned to someone (not a self-assign). */
export async function recordAssigned(
  db: Db,
  input: {
    orgId: string;
    mailboxId: string;
    threadId: string;
    assigneeUserId: string;
    actorUserId: string | null;
  },
  hub?: EventHubNamespace,
  push?: WebPushEnv,
): Promise<void> {
  if (input.actorUserId === input.assigneeUserId) return; // assigning to yourself: no notify
  await db.insert(mail.notification).values({
    userId: input.assigneeUserId,
    orgId: input.orgId,
    type: "assigned",
    mailboxId: input.mailboxId,
    threadId: input.threadId,
    actorUserId: input.actorUserId,
  });
  await notifyNotification(hub, input.assigneeUserId); // live bell ping (no-op without a hub)
  if (push)
    await sendPushToUser(
      db,
      push,
      input.assigneeUserId,
      {
        title: "Assigned to you",
        body: "A thread was assigned to you",
        url: threadUrl(input.mailboxId, input.threadId),
        tag: `thread-${input.threadId}`,
      },
      await orgSubject(db, input.orgId),
    ).catch(() => {});
}

/** Drop read notifications older than the retention window (default 30d). Run
 * from the cron sweep; unread rows are always kept. */
export async function pruneStaleNotifications(db: Db, olderThanMs = 30 * 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const dropped = await db
    .delete(mail.notification)
    .where(and(isNotNull(mail.notification.readAt), lt(mail.notification.readAt, cutoff)))
    .returning({ id: mail.notification.id });
  return dropped.length;
}

/** A teammate left an internal note — notify the thread's current assignee (if
 * any, and not the note author). Unassigned threads ping no one; @mentions will
 * cover targeted pings once that feature lands. */
export async function recordNote(
  db: Db,
  input: { orgId: string; mailboxId: string; threadId: string; actorUserId: string },
  hub?: EventHubNamespace,
  push?: WebPushEnv,
): Promise<void> {
  const state = await db.query.threadState.findFirst({
    where: and(eq(mail.threadState.threadId, input.threadId), eq(mail.threadState.mailboxId, input.mailboxId)),
    columns: { assigneeUserId: true },
  });
  const assignee = state?.assigneeUserId;
  if (!assignee || assignee === input.actorUserId) return;
  await db.insert(mail.notification).values({
    userId: assignee,
    orgId: input.orgId,
    type: "note",
    mailboxId: input.mailboxId,
    threadId: input.threadId,
    actorUserId: input.actorUserId,
  });
  await notifyNotification(hub, assignee); // live bell ping (no-op without a hub)
  if (push)
    await sendPushToUser(
      db,
      push,
      assignee,
      {
        title: "New note",
        body: "A teammate left a note",
        url: threadUrl(input.mailboxId, input.threadId),
        tag: `thread-${input.threadId}`,
      },
      await orgSubject(db, input.orgId),
    ).catch(() => {});
}

/** A send the user owns failed (hard/soft bounce, complaint, or send error).
 * Durable bell row + live ping + OS push (app closed) — a failed send is at
 * least as notify-worthy as new mail. Tagged per submission so distinct
 * failures don't collapse into one push. */
export async function recordSendFailed(
  db: Db,
  input: {
    orgId: string;
    userId: string;
    mailboxId: string | null;
    threadId: string | null;
    submissionId: string;
  },
  hub?: EventHubNamespace,
  push?: WebPushEnv,
): Promise<void> {
  await db.insert(mail.notification).values({
    userId: input.userId,
    orgId: input.orgId,
    type: "send_failed",
    mailboxId: input.mailboxId,
    threadId: input.threadId,
    submissionId: input.submissionId,
  });
  await notifyNotification(hub, input.userId); // live bell (no-op without a hub)
  if (push)
    await sendPushToUser(
      db,
      push,
      input.userId,
      {
        title: "Delivery failed",
        body: "A message you sent couldn't be delivered",
        url: threadUrl(input.mailboxId, input.threadId),
        tag: `send-failed-${input.submissionId}`,
      },
      await orgSubject(db, input.orgId),
    ).catch(() => {});
}
