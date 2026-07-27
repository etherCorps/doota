// SPDX-License-Identifier: Apache-2.0
import { query, command, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";

/**
 * The notification bell (docs/notifications.md, Phase A). Rows are structural;
 * display fields (the sender name, the actor name) are resolved HERE from
 * cleartext columns, never stored. Scoped to the caller only — NOT org-scoped:
 * the app has no org switcher yet, so a bell count that shifted as you moved
 * between orgs would be more confusing than useful. `orgId` is on the row for
 * when a switcher lands.
 */

export type NotificationType = "new_mail" | "send_failed" | "assigned" | "note" | "mention";
export type NotificationDTO = {
  id: string;
  type: NotificationType;
  mailboxId: string | null;
  threadId: string | null;
  submissionId: string | null;
  /** new_mail: the sender, for the client to format ("New message from …"). */
  from: string | null;
  fromName: string | null;
  /** assigned/mention: the internal actor's display name. */
  actorName: string | null;
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
    // names (assigned) from the user table — both cleartext, batched.
    const threadIds = [...new Set(rows.filter((r) => r.type === "new_mail" && r.threadId).map((r) => r.threadId!))];
    const senderByThread = new Map<string, { from: string | null; fromName: string | null }>();
    if (threadIds.length) {
      // Latest message PER thread — one indexed (thread_id, sent_at) read each,
      // not a scan of every message in these threads. Bounded to the page (≤20).
      const latest = await Promise.all(
        threadIds.map((tid) =>
          locals.db.query.message
            .findFirst({
              where: eq(schema.message.threadId, tid),
              orderBy: desc(schema.message.sentAt),
              columns: { fromAddr: true, fromName: true },
            })
            .then((m) => [tid, m] as const),
        ),
      );
      for (const [tid, m] of latest)
        if (m) senderByThread.set(tid, { from: m.fromAddr, fromName: m.fromName });
    }
    const actorIds = [...new Set(rows.filter((r) => r.actorUserId).map((r) => r.actorUserId!))];
    const actorName = new Map<string, string>();
    if (actorIds.length) {
      const users = await locals.db
        .select({ id: schema.user.id, name: schema.user.name })
        .from(schema.user)
        .where(inArray(schema.user.id, actorIds));
      for (const u of users) actorName.set(u.id, u.name);
    }

    return rows.map((r) => {
      const s = r.threadId ? senderByThread.get(r.threadId) : undefined;
      return {
        id: r.id,
        type: r.type as NotificationType,
        mailboxId: r.mailboxId,
        threadId: r.threadId,
        submissionId: r.submissionId,
        from: s?.from ?? null,
        fromName: s?.fromName ?? null,
        actorName: r.actorUserId ? (actorName.get(r.actorUserId) ?? null) : null,
        createdAt: r.createdAt.getTime(),
        readAt: r.readAt ? r.readAt.getTime() : null,
        seenAt: r.seenAt ? r.seenAt.getTime() : null,
      };
    });
  },
);

/** Unread badge — served by the partial (userId) WHERE read_at IS NULL index. */
export const unreadNotificationCount = query(async (): Promise<number> => {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  const [row] = await locals.db
    .select({ n: sql<number>`count(*)` })
    .from(mail.notification)
    .where(and(eq(mail.notification.userId, locals.user.id), isNull(mail.notification.readAt)));
  return row?.n ?? 0;
});

/** Bell opened — clear the unseen state (dot), leaving unread (bold) intact. */
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

/** A notification was clicked — mark it read (ownership enforced). */
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

/** The VAPID PUBLIC key (safe to expose) — the client needs it to subscribe.
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
