// SPDX-License-Identifier: Apache-2.0
import { and, desc, eq, inArray, isNull, isNotNull, lt } from "drizzle-orm";
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

type PushPayload = { title: string; body: string; url: string; tag: string };

/** Send one payload to many users, resolving the org VAPID subject once. Every
 * send is best-effort (a dead subscription must not fail the others). */
async function pushToUsers(db: Db, push: WebPushEnv, orgId: string, userIds: string[], payload: PushPayload): Promise<void> {
  if (!userIds.length) return;
  const subject = await orgSubject(db, orgId);
  await Promise.all(userIds.map((userId) => sendPushToUser(db, push, userId, payload, subject).catch(() => {})));
}

/** Display label for a mailbox (its name, else its address). Null when unknown —
 * so a multi-mailbox recipient can see WHICH mailbox a notification is about. */
async function mailboxLabel(db: Db, mailboxId: string | null): Promise<string | null> {
  if (!mailboxId) return null;
  const box = await db.query.mailbox.findFirst({
    where: eq(mail.mailbox.id, mailboxId),
    columns: { address: true, displayName: true },
  });
  return box ? box.displayName?.trim() || box.address : null;
}

/** An internal actor's display name (assigned / note / mention). */
async function actorName(db: Db, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const user = await db.query.user.findFirst({ where: eq(schema.user.id, userId), columns: { name: true } });
  return user?.name?.trim() || null;
}

/** Pure: the two-line push text for new mail — sender on top, sender address +
 * which mailbox below (subject stays out; it's encrypted at rest). Kept pure so
 * the branching is unit-testable without a DB. */
export function newMailPushText(
  fromName: string | null,
  fromAddr: string | null,
  boxLabel: string | null,
): { title: string; body: string } {
  const name = fromName?.trim();
  const addr = fromAddr?.trim();
  const title = name || addr || "New message";
  const to = boxLabel ? `to ${boxLabel}` : "";
  // Show the address on the second line only when the first line was the name
  // (otherwise it's already the title). Append the mailbox when known.
  const detail = name && addr ? [addr, to].filter(Boolean).join(" · ") : to;
  return { title, body: detail || "You have new mail" };
}

/** Pure: append the mailbox to an internal-action line when known. */
function withMailbox(text: string, boxLabel: string | null): string {
  return boxLabel ? `${text} · ${boxLabel}` : text;
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
      columns: { assigneeUserId: true, muted: true },
    }),
  ]);
  // Muted thread: stays put and stays SILENT (chat mute semantics) — the
  // unread count still shows, but no bell row and no OS push.
  if (state?.muted) return [];
  const assignee = state?.assigneeUserId ?? null;
  return access.filter((a) => !a.assignedOnly || a.canManage || a.userId === assignee).map((a) => a.userId);
}

/**
 * Per-folder notification setting: a thread filed into folders that are ALL
 * set to notify_new_mail = false is silent (bell + push). A thread with no
 * labels, or with any notify-on label, notifies normally. Rule-fed folders
 * default to off at rule creation (Phase 2) — filing away mail that still
 * buzzes achieves nothing.
 */
async function folderSilenced(db: Db, mailboxId: string, threadId: string): Promise<boolean> {
  const labels = await db
    .select({ notify: mail.label.notifyNewMail })
    .from(mail.threadLabel)
    .innerJoin(mail.label, eq(mail.threadLabel.labelId, mail.label.id))
    .where(and(eq(mail.threadLabel.threadId, threadId), eq(mail.threadLabel.mailboxId, mailboxId)));
  return labels.length > 0 && labels.every((l) => !l.notify);
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
  if (await folderSilenced(db, input.mailboxId, input.threadId)) return;
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
  // reply burst collapses. Best-effort; no-op without VAPID. Sender + mailbox
  // resolved once (cleartext) and reused for all recipients; subject omitted
  // (encrypted at rest).
  if (push) {
    const [latest, boxLabel] = await Promise.all([
      db.query.message.findFirst({
        where: eq(mail.message.threadId, input.threadId),
        orderBy: desc(mail.message.sentAt),
        columns: { fromAddr: true, fromName: true },
      }),
      mailboxLabel(db, input.mailboxId),
    ]);
    const { title, body } = newMailPushText(latest?.fromName ?? null, latest?.fromAddr ?? null, boxLabel);
    await pushToUsers(db, push, input.orgId, userIds, {
      title,
      body,
      url: threadUrl(input.mailboxId, input.threadId),
      tag: `thread-${input.threadId}`,
    });
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
  if (push) {
    const [actor, boxLabel] = await Promise.all([actorName(db, input.actorUserId), mailboxLabel(db, input.mailboxId)]);
    await pushToUsers(db, push, input.orgId, [input.assigneeUserId], {
      title: "Assigned to you",
      body: withMailbox(actor ? `${actor} assigned you a thread` : "A thread was assigned to you", boxLabel),
      url: threadUrl(input.mailboxId, input.threadId),
      tag: `thread-${input.threadId}`,
    });
  }
}

/**
 * Inbound-routing health → superadmin bells. `attached=false` raises one
 * unread `routing_issue` row per superadmin (deduped on an existing unread row
 * for the org, so repeated health checks don't stack); `attached=true`
 * resolves them (marks read). Called wherever the catch-all state is actually
 * inspected — admin config views and the reattach self-heal — since there is
 * no background prober. Best-effort at call sites: a bell failure must never
 * fail the config read.
 */
export async function syncRoutingIssue(db: Db, orgId: string, attached: boolean): Promise<void> {
  const unreadIssue = and(
    eq(mail.notification.orgId, orgId),
    eq(mail.notification.type, "routing_issue"),
    isNull(mail.notification.readAt),
  );
  if (attached) {
    await db.update(mail.notification).set({ readAt: new Date() }).where(unreadIssue);
    return;
  }
  const superadmins = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.role, "superadmin"));
  if (!superadmins.length) return;
  const existing = await db.select({ userId: mail.notification.userId }).from(mail.notification).where(unreadIssue);
  const alerted = new Set(existing.map((row) => row.userId));
  const fresh = superadmins.filter((admin) => !alerted.has(admin.id));
  if (fresh.length) {
    await db.insert(mail.notification).values(fresh.map((admin) => ({ userId: admin.id, orgId, type: "routing_issue" })));
  }
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
  if (push) {
    const [actor, boxLabel] = await Promise.all([actorName(db, input.actorUserId), mailboxLabel(db, input.mailboxId)]);
    await pushToUsers(db, push, input.orgId, [assignee], {
      title: "New note",
      body: withMailbox(actor ? `${actor} left a note` : "A teammate left a note", boxLabel),
      url: threadUrl(input.mailboxId, input.threadId),
      tag: `thread-${input.threadId}`,
    });
  }
}

/** A teammate was @mentioned in a note — notify them directly. Higher signal
 * than the assignee's note bell, so it's its own type; a self-mention no-ops. */
export async function recordMention(
  db: Db,
  input: { orgId: string; mailboxId: string; threadId: string; mentionedUserId: string; actorUserId: string | null },
  hub?: EventHubNamespace,
  push?: WebPushEnv,
): Promise<void> {
  if (input.actorUserId === input.mentionedUserId) return; // mentioning yourself: no notify
  await db.insert(mail.notification).values({
    userId: input.mentionedUserId,
    orgId: input.orgId,
    type: "mention",
    mailboxId: input.mailboxId,
    threadId: input.threadId,
    actorUserId: input.actorUserId,
  });
  await notifyNotification(hub, input.mentionedUserId); // live bell ping (no-op without a hub)
  if (push) {
    const [actor, boxLabel] = await Promise.all([actorName(db, input.actorUserId), mailboxLabel(db, input.mailboxId)]);
    await pushToUsers(db, push, input.orgId, [input.mentionedUserId], {
      title: actor ? `${actor} mentioned you` : "You were mentioned",
      body: withMailbox("in a note", boxLabel),
      url: threadUrl(input.mailboxId, input.threadId),
      tag: `thread-${input.threadId}`,
    });
  }
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
  if (push) {
    const boxLabel = await mailboxLabel(db, input.mailboxId);
    await pushToUsers(db, push, input.orgId, [input.userId], {
      title: "Delivery failed",
      body: withMailbox("A message you sent couldn't be delivered", boxLabel),
      url: threadUrl(input.mailboxId, input.threadId),
      tag: `send-failed-${input.submissionId}`,
    });
  }
}
