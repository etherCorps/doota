// SPDX-License-Identifier: Apache-2.0
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";

type Db = DrizzleD1Database<typeof schema>;

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

/** New inbound mail landed in a thread — one unread row per eligible recipient,
 * collapsing a reply burst per (user, thread). */
export async function recordNewMail(
  db: Db,
  input: { orgId: string; mailboxId: string; threadId: string },
): Promise<void> {
  const userIds = await newMailRecipients(db, input.mailboxId, input.threadId);
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
    await db.insert(mail.notification).values(
      fresh.map((userId) => ({
        userId,
        orgId: input.orgId,
        type: "new_mail",
        mailboxId: input.mailboxId,
        threadId: input.threadId,
      })),
    );
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
}

/** A send the user owns failed (hard/soft bounce, complaint, or send error). */
export async function recordSendFailed(
  db: Db,
  input: {
    orgId: string;
    userId: string;
    mailboxId: string | null;
    threadId: string | null;
    submissionId: string;
  },
): Promise<void> {
  await db.insert(mail.notification).values({
    userId: input.userId,
    orgId: input.orgId,
    type: "send_failed",
    mailboxId: input.mailboxId,
    threadId: input.threadId,
    submissionId: input.submissionId,
  });
}
