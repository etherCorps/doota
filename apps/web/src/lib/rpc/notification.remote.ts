// SPDX-License-Identifier: Apache-2.0
import { query, command, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";

/**
 * The notification bell (docs/notifications.md, Phase A). Rows are structural;
 * display fields (the sender name, the actor name) are resolved here from
 * cleartext columns, never stored. Scoped to the caller only, not org-scoped:
 * the app has no org switcher yet, so a bell count that shifted as you moved
 * between orgs would be more confusing than useful. `orgId` is on the row for
 * when a switcher lands.
 */

export type NotificationType = "new_mail" | "send_failed" | "assigned" | "note" | "mention" | "routing_issue";
export type NotificationDTO = {
  id: string;
  type: NotificationType;
  orgId: string;
  mailboxId: string | null;
  threadId: string | null;
  submissionId: string | null;
  /** new_mail: the sender, for the client to format ("New message from …"). */
  from: string | null;
  fromName: string | null;
  /** assigned/mention: the internal actor's display name. */
  actorName: string | null;
  /** Which mailbox this is about, so a multi-mailbox user knows where it landed. */
  mailboxLabel: string | null;
  /** routing_issue: the affected org's domain, for "Mail to acme.com isn't arriving". */
  orgDomain: string | null;
  createdAt: number;
  readAt: number | null;
  seenAt: number | null;
};

const PAGE = 20;

export const myNotifications = query(
  z.object({ offset: z.number().int().min(0).default(0) }),
  async ({ offset }): Promise<NotificationDTO[]> => {
    const { locals } = getRequestEvent();
    if (!locals.user) error(401, "Not authenticated");
    const userId = locals.user.id;

    const rows = await locals.db
      .select()
      .from(mail.notification)
      .where(eq(mail.notification.userId, userId))
      .orderBy(desc(mail.notification.createdAt))
      .limit(PAGE)
      .offset(offset);
    if (!rows.length) return [];

    // Resolve sender names (new_mail) from the thread's latest message, and actor
    // names (assigned) from the user table. Both cleartext, batched.
    const threadIds = [...new Set(rows.filter((row) => row.type === "new_mail" && row.threadId).map((row) => row.threadId!))];
    const senderByThread = new Map<string, { from: string | null; fromName: string | null }>();
    if (threadIds.length) {
      // Latest message per thread: one indexed (thread_id, sent_at) read each,
      // not a scan of every message in these threads. Bounded to the page (≤20).
      const latest = await Promise.all(
        threadIds.map((threadId) =>
          locals.db.query.message
            .findFirst({
              where: eq(schema.message.threadId, threadId),
              orderBy: desc(schema.message.sentAt),
              columns: { fromAddr: true, fromName: true },
            })
            .then((message) => [threadId, message] as const),
        ),
      );
      for (const [threadId, message] of latest)
        if (message) senderByThread.set(threadId, { from: message.fromAddr, fromName: message.fromName });
    }
    const actorIds = [...new Set(rows.filter((row) => row.actorUserId).map((row) => row.actorUserId!))];
    const actorName = new Map<string, string>();
    if (actorIds.length) {
      const users = await locals.db
        .select({ id: schema.user.id, name: schema.user.name })
        .from(schema.user)
        .where(inArray(schema.user.id, actorIds));
      for (const actor of users) actorName.set(actor.id, actor.name);
    }

    // Mailbox labels (name, else address) so the client can show which mailbox a
    // notification is about. Batched over the page's distinct mailbox ids.
    const mailboxIds = [...new Set(rows.filter((row) => row.mailboxId).map((row) => row.mailboxId!))];
    const mailboxLabel = new Map<string, string>();
    if (mailboxIds.length) {
      const boxes = await locals.db
        .select({ id: mail.mailbox.id, address: mail.mailbox.address, displayName: mail.mailbox.displayName })
        .from(mail.mailbox)
        .where(inArray(mail.mailbox.id, mailboxIds));
      for (const box of boxes) mailboxLabel.set(box.id, box.displayName?.trim() || box.address);
    }

    // Org domains for routing_issue rows (superadmin health alerts). The row is
    // org-scoped, not mailbox/thread-scoped, so the domain is the display context.
    const issueOrgIds = [...new Set(rows.filter((row) => row.type === "routing_issue").map((row) => row.orgId))];
    const orgDomain = new Map<string, string>();
    if (issueOrgIds.length) {
      const orgs = await locals.db
        .select({ id: schema.organization.id, domain: schema.organization.domain })
        .from(schema.organization)
        .where(inArray(schema.organization.id, issueOrgIds));
      for (const org of orgs) orgDomain.set(org.id, org.domain);
    }

    return rows.map((row) => {
      const sender = row.threadId ? senderByThread.get(row.threadId) : undefined;
      return {
        id: row.id,
        type: row.type as NotificationType,
        orgId: row.orgId,
        mailboxId: row.mailboxId,
        threadId: row.threadId,
        submissionId: row.submissionId,
        from: sender?.from ?? null,
        fromName: sender?.fromName ?? null,
        actorName: row.actorUserId ? (actorName.get(row.actorUserId) ?? null) : null,
        mailboxLabel: row.mailboxId ? (mailboxLabel.get(row.mailboxId) ?? null) : null,
        orgDomain: row.type === "routing_issue" ? (orgDomain.get(row.orgId) ?? null) : null,
        createdAt: row.createdAt.getTime(),
        readAt: row.readAt ? row.readAt.getTime() : null,
        seenAt: row.seenAt ? row.seenAt.getTime() : null,
      };
    });
  },
);

/** Unread badge, served by the partial (userId) WHERE read_at IS NULL index. */
export const unreadNotificationCount = query(async (): Promise<number> => {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  const [row] = await locals.db
    .select({ n: sql<number>`count(*)` })
    .from(mail.notification)
    .where(and(eq(mail.notification.userId, locals.user.id), isNull(mail.notification.readAt)));
  return row?.n ?? 0;
});

/** Bell opened: clear the unseen state (dot), leaving unread (bold) intact. */
export const markNotificationsSeen = command(async () => {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  await locals.db
    .update(mail.notification)
    .set({ seenAt: new Date() })
    .where(and(eq(mail.notification.userId, locals.user.id), isNull(mail.notification.seenAt)));
  return { ok: true as const };
});

/** Clear the whole unread set for the caller (the "Mark all read" action). */
export const markAllNotificationsRead = command(async () => {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  await locals.db
    .update(mail.notification)
    .set({ readAt: new Date() })
    .where(and(eq(mail.notification.userId, locals.user.id), isNull(mail.notification.readAt)));
  return { ok: true as const };
});

/** A notification was clicked: mark it read (ownership enforced). */
export const markNotificationRead = command(z.object({ id: z.string().min(1) }), async ({ id }) => {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  await locals.db
    .update(mail.notification)
    .set({ readAt: new Date() })
    .where(and(eq(mail.notification.id, id), eq(mail.notification.userId, locals.user.id)));
  return { ok: true as const };
});

// --- Web Push subscriptions (Phase B) --------------------------------------

/** The VAPID public key (safe to expose); the client needs it to subscribe.
 * Empty string when push isn't configured, so the client just skips. */
export const pushPublicKey = query(async (): Promise<string> => {
  const { platform } = getRequestEvent();
  return platform?.env?.VAPID_PUBLIC_KEY ?? "";
});

/** Store/refresh this browser's push subscription (upsert on endpoint; a device
 * that re-subscribes or changes hands reassigns to the current user). */
export const savePushSubscription = command(
  z.object({
    endpoint: z.string().url().max(2048),
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
    userAgent: z.string().max(512).optional(),
  }),
  async ({ endpoint, p256dh, auth, userAgent }) => {
    const { locals } = getRequestEvent();
    if (!locals.user) error(401, "Not authenticated");
    const now = new Date();
    await locals.db
      .insert(mail.pushSubscription)
      .values({ userId: locals.user.id, endpoint, p256dh, auth, userAgent: userAgent ?? null, lastSeenAt: now })
      .onConflictDoUpdate({
        target: mail.pushSubscription.endpoint,
        set: { userId: locals.user.id, p256dh, auth, userAgent: userAgent ?? null, lastSeenAt: now },
      });
    return { ok: true as const };
  },
);

/** Drop this browser's subscription (logout / user turned notifications off). */
export const deletePushSubscription = command(z.object({ endpoint: z.string().min(1) }), async ({ endpoint }) => {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  await locals.db
    .delete(mail.pushSubscription)
    .where(and(eq(mail.pushSubscription.endpoint, endpoint), eq(mail.pushSubscription.userId, locals.user.id)));
  return { ok: true as const };
});
