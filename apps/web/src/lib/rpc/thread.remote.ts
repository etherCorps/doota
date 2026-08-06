// SPDX-License-Identifier: Apache-2.0
import { query, command, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, eq, inArray, isNull, isNotNull, count } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { can } from "@doota/db/can";
import { getAuthz } from "$lib/server/authz.js";
import {
  assignedOnlyFor,
  assignedOnlyMailboxIds,
  manageGrantUserIds,
} from "@doota/mail-core/mailbox";
import { importKey } from "@doota/mail-core/crypto";
import { markThreadNotificationsRead } from "@doota/mail-core/notify";
import { tryLog, log } from "@doota/mail-core/log";
import { listThreads, getThread, countUnread, recentUnread } from "@doota/mail-core/read";
import { createNote, editNote, softDeleteNote } from "@doota/mail-core/notes";
import {
  trustSenderImages,
  untrustSenderImages,
  loadsAllRemoteImages,
  setLoadAllRemoteImages,
} from "@doota/mail-core/sender-trust";
import { assignThread as doAssign, emitPlacementEvent } from "@doota/mail-core/collab";
import { addSenderListEntry, latestSenderOf } from "@doota/mail-core/spam";

/**
 * Mailbox read paths. Access resolves through can() + mailbox_access grants —
 * never a parallel permission path. Content is decrypted on read with the DEK
 * from the Worker secret (platform.env), never persisted.
 */

function contentKey() {
  const env = getRequestEvent().platform?.env;
  const dek = env?.MAIL_DEK;
  if (!dek) error(500, "Mail encryption key is not configured.");
  return importKey(dek);
}

/**
 * Assert the current user may read this mailbox. Returns the box, whether the
 * user holds an actual mailbox_access GRANT (distinct from org-admin read —
 * internal notes + system events follow the grant, NOT org read: an admin
 * reading a mailbox they aren't a member of sees the mail but never the notes),
 * and `assignedTo`: non-null when this is an assigned-only grantee, in which
 * case every read is narrowed to threads assigned to them.
 */
async function assertMailboxAccess(mailboxId: string) {
  const { locals } = getRequestEvent();
  const user = locals.user;
  if (!user) error(401, "Not authenticated");

  const box = await locals.db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, mailboxId),
    columns: { id: true, orgId: true },
  });
  if (!box) error(404, "Mailbox not found");

  const { mailboxIds, orgAdminOf } = await getAuthz();
  const hasGrant = mailboxIds.includes(mailboxId);
  // Only fall back to the org-admin read check when there's no grant — otherwise
  // a plain member (never an org admin) trips a spurious can() deny on every
  // thread list/open. A grant is already sufficient.
  if (!hasGrant) {
    const orgRead = can(
      { id: user.id, role: user.role, orgAdminOf },
      "read",
      { type: "mailbox", ownerId: "", organizationId: box.orgId },
    );
    if (!orgRead) error(403, "You can't read this mailbox.");
  }
  const assignedTo = hasGrant ? await assignedOnlyFor(locals.db, user.id, mailboxId) : null;
  return { box, hasGrant, assignedTo };
}

/** Assert the user holds a mailbox_access GRANT (required to read/write notes,
 * assign, or otherwise touch the collaboration layer). */
async function assertMailboxGrant(mailboxId: string) {
  const { box, hasGrant, assignedTo } = await assertMailboxAccess(mailboxId);
  if (!hasGrant) error(403, "You need access to this mailbox.");
  return { ...box, assignedTo };
}

/**
 * Grant + per-thread check: an assigned-only member may only act on threads
 * assigned to them. Every thread-scoped mutation routes through here, so the
 * restriction can't be dodged by posting a threadId the member can't see.
 */
async function assertThreadGrant(mailboxId: string, threadId: string) {
  const box = await assertMailboxGrant(mailboxId);
  const { locals } = getRequestEvent();
  const state = await locals.db.query.threadState.findFirst({
    where: and(
      eq(schema.threadState.threadId, threadId),
      eq(schema.threadState.mailboxId, mailboxId),
    ),
    columns: { id: true, placement: true, assigneeUserId: true },
  });
  if (!state) error(404, "Thread is not in this mailbox.");
  if (box.assignedTo && state.assigneeUserId !== box.assignedTo) {
    error(404, "Thread is not in this mailbox."); // never leak its existence
  }
  return { box, state };
}

/** Assert the user MANAGES this mailbox — a can_manage grant or org-admin.
 * Assignment is a manager action: restricted members can't hand threads around. */
async function assertMailboxManage(mailboxId: string) {
  const { locals } = getRequestEvent();
  const user = locals.user;
  if (!user) error(401, "Not authenticated");
  const box = await locals.db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, mailboxId),
    columns: { id: true, orgId: true },
  });
  if (!box) error(404, "Mailbox not found");
  const grantedManagerIds = await manageGrantUserIds(locals.db, mailboxId);
  const { orgAdminOf } = await getAuthz();
  const ok = can(
    { id: user.id, role: user.role, orgAdminOf },
    "manage",
    { type: "mailbox", ownerId: "", organizationId: box.orgId, grantedManagerIds },
  );
  if (!ok) error(403, "Only a mailbox manager can do that.");
  return box;
}

// Real placements a thread can be MOVED to. `sent` is a view (threads this
// mailbox sent something in), listable but never a move target.
const MOVE_PLACEMENTS = ["inbox", "archived", "spam", "trash"] as const;
// `sent` and `snoozed` are views, not move targets (see listThreads).
const VIEW_PLACEMENTS = [...MOVE_PLACEMENTS, "sent", "snoozed"] as const;

// Kept local: a remote-function module may export ONLY remote functions.
const PAGE_SIZE = 30;

export const mailboxThreads = query(
  z.object({
    mailboxId: z.string().min(1),
    // .catch (not .default): an unknown ?folder= value (e.g. "archive" vs
    // "archived", or a stale bookmark) clamps to inbox instead of failing the
    // enum — a rejected view query throws client-side and paints a blank list.
    placement: z.enum(VIEW_PLACEMENTS).catch("inbox"),
    offset: z.number().int().min(0).default(0),
    /** Folder view: threads carrying this label (placement is ignored). */
    labelId: z.string().min(1).optional(),
  }),
  async ({ mailboxId, placement, offset, labelId }) => {
    const { hasGrant, assignedTo } = await assertMailboxAccess(mailboxId);
    const { locals } = getRequestEvent();
    const ck = await contentKey();
    return listThreads(locals.db, {
      mailboxId,
      placement,
      ck,
      limit: PAGE_SIZE,
      offset,
      includeCollab: hasGrant,
      userId: locals.user!.id,
      assignedTo,
      labelId,
    });
  },
);

/**
 * The pinned threads of a view — a SEPARATE small list (partial index), merged
 * atop the main list client-side. Not folded into the main sort, so the list
 * index's backward-scan-to-LIMIT is preserved.
 */
export const mailboxThreadsPinned = query(
  z.object({
    mailboxId: z.string().min(1),
    placement: z.enum(VIEW_PLACEMENTS).catch("inbox"),
    labelId: z.string().min(1).optional(),
  }),
  async ({ mailboxId, placement, labelId }) => {
    const { hasGrant, assignedTo } = await assertMailboxAccess(mailboxId);
    const { locals } = getRequestEvent();
    return listThreads(locals.db, {
      mailboxId,
      placement,
      ck: await contentKey(),
      includeCollab: hasGrant,
      userId: locals.user!.id,
      assignedTo,
      labelId,
      pinnedOnly: true,
    });
  },
);

/** Unread inbox count for the badge/title — refreshed by live inbound events. */
export const unreadCount = query(z.object({ mailboxId: z.string().min(1) }), async ({ mailboxId }) => {
  const { assignedTo } = await assertMailboxAccess(mailboxId);
  const { locals } = getRequestEvent();
  return countUnread(locals.db, { mailboxId, userId: locals.user!.id, assignedTo });
});

/** Recent unread mail across ALL the caller's mailboxes — feeds the bell's
 * "New mail" section. App-wide (not tied to the active mailbox). */
export const recentUnreadMail = query(async () => {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  const mailboxIds = (await getAuthz()).mailboxIds;
  return recentUnread(locals.db, {
    userId: locals.user.id,
    ck: await contentKey(),
    mailboxIds,
    assignedOnlyMailboxIds: await assignedOnlyMailboxIds(locals.db, locals.user.id),
  });
});

export const openThread = query(
  z.object({ mailboxId: z.string().min(1), threadId: z.string().min(1) }),
  async ({ mailboxId, threadId }) => {
    const tStart = Date.now();
    const { hasGrant, assignedTo } = await assertMailboxAccess(mailboxId);
    const tAuthz = Date.now();
    const { locals } = getRequestEvent();
    const ck = await contentKey();
    // Notes/events are included ONLY for grant holders (not org-admin readers).
    const dto = await getThread(locals.db, {
      mailboxId,
      threadId,
      ck,
      includeCollab: hasGrant,
      userId: locals.user!.id,
      assignedTo,
    });
    // Debug-only: splits the reported openThread latency into authz vs read
    // (read.thread_timing then splits the read into its waves).
    log.debug("rpc.open_thread_timing", {
      threadId,
      authzMs: tAuthz - tStart,
      readMs: Date.now() - tAuthz,
      totalMs: Date.now() - tStart,
    });
    if (!dto) error(404, "Thread not found in this mailbox");
    return dto;
  },
);

/**
 * Mark a thread read for the CURRENT USER in this mailbox (clears their unread
 * dot only — a shared mailbox tracks read state per person). Upsert on
 * (user, thread, mailbox). Requires an actual grant: triage is a member action,
 * an org-admin oversight reader doesn't mutate mailbox state.
 */
export const markThreadRead = command(
  z.object({ mailboxId: z.string().min(1), threadId: z.string().min(1) }),
  async ({ mailboxId, threadId }) => {
    const { box } = await assertThreadGrant(mailboxId, threadId);
    const { locals, platform } = getRequestEvent();
    const now = new Date();
    await locals.db
      .insert(mail.threadRead)
      .values({ orgId: box.orgId, userId: locals.user!.id, threadId, mailboxId, lastReadAt: now })
      .onConflictDoUpdate({
        target: [mail.threadRead.userId, mail.threadRead.threadId, mail.threadRead.mailboxId],
        set: { lastReadAt: now },
      });
    // Reading a thread from the list also clears its bell notifications (and
    // pings the stream so the bell + sidebar count drop live) — parity with
    // opening it from the notification panel. Best-effort; the read itself
    // already succeeded, so a failed bell-clear must not fail the request.
    await tryLog(
      "thread.mark_notifications_read_failed",
      markThreadNotificationsRead(locals.db, locals.user!.id, threadId, platform?.env?.MAIL_EVENTS),
      { threadId },
    );
    return { ok: true as const };
  },
);

/**
 * Record the viewer's LOCAL RSVP for a calendar invite (yes/no/maybe). This is
 * the app's own status only — it does NOT notify the organizer (that needs an
 * iMIP reply the provider can't emit yet, or the invite's own RSVP links). Authz:
 * the user must be able to see the thread AND the uid must belong to an invite in
 * it. Keyed per (user, uid) so the latest answer wins across the event's messages.
 */
export const setInviteRsvp = command(
  z.object({
    mailboxId: z.string().min(1),
    threadId: z.string().min(1),
    uid: z.string().min(1),
    status: z.enum(["accepted", "declined", "tentative"]),
  }),
  async ({ mailboxId, threadId, uid, status }) => {
    await assertThreadGrant(mailboxId, threadId);
    const { locals } = getRequestEvent();
    // The uid must name an invite actually carried by a message in this thread —
    // never let a client write RSVP for an arbitrary uid.
    const owns = await locals.db
      .select({ id: mail.calendarEvent.id })
      .from(mail.calendarEvent)
      .innerJoin(mail.message, eq(mail.message.id, mail.calendarEvent.messageId))
      .where(and(eq(mail.calendarEvent.uid, uid), eq(mail.message.threadId, threadId)))
      .limit(1);
    if (!owns.length) error(404, "Invite not found");
    const now = new Date();
    await locals.db
      .insert(mail.calendarRsvp)
      .values({ userId: locals.user!.id, uid, status, updatedAt: now })
      .onConflictDoUpdate({
        target: [mail.calendarRsvp.userId, mail.calendarRsvp.uid],
        set: { status, updatedAt: now },
      });
    return { ok: true as const, status };
  },
);

/** Move a thread to a placement (archive/spam/trash/inbox) for this mailbox. */
export const moveThread = command(
  z.object({
    mailboxId: z.string().min(1),
    threadId: z.string().min(1),
    placement: z.enum(MOVE_PLACEMENTS),
  }),
  async ({ mailboxId, threadId, placement }) => {
    const { box, state: prev } = await assertThreadGrant(mailboxId, threadId);
    const { locals, locals: { user } } = getRequestEvent();
    await locals.db
      .update(mail.threadState)
      .set({
        placement,
        hiddenAt: null, // moving un-hides
        // An explicit move ends any snooze — a snoozed thread parks in the inbox
        // (placement 'inbox' + snoozedUntil), so "move to inbox" would otherwise
        // no-op and leave it hidden in the Snoozed view; and archiving/junking a
        // snoozed thread shouldn't let the cron wake it back.
        snoozedUntil: null,
        // Explicit user decision: rules may never re-file this thread, and a
        // new reply returns it to the inbox. Records WHO for the "why is this
        // here?" sheet on shared mailboxes.
        placementOrigin: "user",
        placementUserId: user?.id ?? null,
        placementRuleId: null,
        placementAt: new Date(),
      })
      .where(
        and(eq(mail.threadState.threadId, threadId), eq(mail.threadState.mailboxId, mailboxId)),
      );
    // Moving OUT of Junk is a ham vote: implicit allow-list entry for the
    // sender (Phase 5) so the classifier never junks them again. Best-effort.
    if (prev?.placement === "spam" && placement !== "spam" && placement !== "trash") {
      await tryLog(
        "spam.unjunk_allow_failed",
        (async () => {
          const sender = await latestSenderOf(locals.db, threadId);
          if (sender) await addSenderListEntry(locals.db, { mailboxId, address: sender, kind: "allow" });
        })(),
        { threadId },
      );
    }
    // Quiet system event on shared mailboxes only (Task 5); no-op otherwise.
    if (prev && user) {
      await emitPlacementEvent(locals.db, {
        orgId: box.orgId,
        threadId,
        mailboxId,
        actorUserId: user.id,
        fromPlacement: prev.placement,
        toPlacement: placement,
      });
    }
    return { ok: true as const };
  },
);

/** Snooze: park the thread out of the inbox until `until` (ms epoch, future).
 * The 5-min cron wakes it back to the inbox top, unread (see sweepDueSnoozes).
 * Per-mailbox, like placement — on a shared mailbox it snoozes for the team. */
export const snoozeThread = command(
  z.object({
    mailboxId: z.string().min(1),
    threadId: z.string().min(1),
    until: z.number().int().positive(),
  }),
  async ({ mailboxId, threadId, until }) => {
    await assertThreadGrant(mailboxId, threadId);
    if (until <= Date.now()) error(400, "Snooze time must be in the future.");
    const { locals } = getRequestEvent();
    // Park in the inbox (so it returns here on wake) and hide it via snoozedUntil.
    await locals.db
      .update(mail.threadState)
      .set({ snoozedUntil: new Date(until), placement: "inbox", hiddenAt: null })
      .where(and(eq(mail.threadState.threadId, threadId), eq(mail.threadState.mailboxId, mailboxId)));
    return { ok: true as const, until };
  },
);

/** Manual un-snooze: bring the thread back to the inbox now. Keeps its read
 * state (the user chose to surface it) — unlike the cron wake, which marks unread. */
export const unsnoozeThread = command(
  z.object({ mailboxId: z.string().min(1), threadId: z.string().min(1) }),
  async ({ mailboxId, threadId }) => {
    await assertThreadGrant(mailboxId, threadId);
    const { locals } = getRequestEvent();
    await locals.db
      .update(mail.threadState)
      .set({ snoozedUntil: null })
      .where(and(eq(mail.threadState.threadId, threadId), eq(mail.threadState.mailboxId, mailboxId)));
    return { ok: true as const };
  },
);

/** Bulk move — one query over the selection. ponytail: no per-thread system
 * events on bulk moves (the loop of prev-placement reads isn't worth it);
 * add them if shared-mailbox timelines miss them in practice. */
export const bulkMoveThreads = command(
  z.object({
    mailboxId: z.string().min(1),
    threadIds: z.array(z.string().min(1)).min(1).max(200),
    placement: z.enum(MOVE_PLACEMENTS),
  }),
  async ({ mailboxId, threadIds, placement }) => {
    const box = await assertMailboxGrant(mailboxId);
    const { locals, locals: { user } } = getRequestEvent();
    await locals.db
      .update(mail.threadState)
      .set({
        placement,
        hiddenAt: null, // moving un-hides
        snoozedUntil: null, // an explicit move ends any snooze (see moveThread)
        placementOrigin: "user",
        placementUserId: user?.id ?? null,
        placementRuleId: null,
        placementAt: new Date(),
      })
      .where(
        and(
          eq(mail.threadState.mailboxId, mailboxId),
          inArray(mail.threadState.threadId, threadIds),
          // Assigned-only member: the WHERE itself limits the bulk to their own
          // threads, so a padded selection silently no-ops on the rest.
          box.assignedTo ? eq(mail.threadState.assigneeUserId, box.assignedTo) : undefined,
        ),
      );
    return { ok: true as const };
  },
);

/** "Empty trash/spam": hides every thread at the placement — never a hard
 * delete (messages, R2 content and other mailboxes' state are untouched). */
export const emptyFolder = command(
  z.object({ mailboxId: z.string().min(1), placement: z.enum(["trash", "spam"]) }),
  async ({ mailboxId, placement }) => {
    const box = await assertMailboxGrant(mailboxId);
    // Emptying hides the folder for everyone — a mailbox-wide act, not one an
    // assigned-only member may perform.
    if (box.assignedTo) error(403, "Only a mailbox manager can empty this folder.");
    const { locals } = getRequestEvent();
    await locals.db
      .update(mail.threadState)
      .set({ hiddenAt: new Date() })
      .where(
        and(
          eq(mail.threadState.mailboxId, mailboxId),
          eq(mail.threadState.placement, placement),
          isNull(mail.threadState.hiddenAt),
        ),
      );
    return { ok: true as const };
  },
);

/** Bulk read/unread for the calling user (per-user threadRead rows). */
export const bulkMarkRead = command(
  z.object({
    mailboxId: z.string().min(1),
    threadIds: z.array(z.string().min(1)).min(1).max(200),
    read: z.boolean(),
  }),
  async ({ mailboxId, threadIds, read }) => {
    const box = await assertMailboxGrant(mailboxId);
    const { locals } = getRequestEvent();
    const userId = locals.user!.id;
    if (box.assignedTo) {
      // Narrow to the member's own threads before writing read cursors.
      const mine = await locals.db
        .select({ threadId: schema.threadState.threadId })
        .from(schema.threadState)
        .where(
          and(
            eq(schema.threadState.mailboxId, mailboxId),
            inArray(schema.threadState.threadId, threadIds),
            eq(schema.threadState.assigneeUserId, box.assignedTo),
          ),
        );
      threadIds = mine.map((row) => row.threadId);
      if (!threadIds.length) return { ok: true as const };
    }
    if (read) {
      const now = new Date();
      await locals.db
        .insert(mail.threadRead)
        .values(threadIds.map((threadId) => ({ orgId: box.orgId, userId, threadId, mailboxId, lastReadAt: now })))
        .onConflictDoUpdate({
          target: [mail.threadRead.userId, mail.threadRead.threadId, mail.threadRead.mailboxId],
          set: { lastReadAt: now },
        });
    } else {
      // Unread = no read marker newer than the thread; deleting the marker restores it.
      await locals.db
        .delete(mail.threadRead)
        .where(
          and(
            eq(mail.threadRead.userId, userId),
            eq(mail.threadRead.mailboxId, mailboxId),
            inArray(mail.threadRead.threadId, threadIds),
          ),
        );
    }
    return { ok: true as const };
  },
);

/** Star / unstar a thread for this mailbox. */
/** "Always load images from this sender" — per-user display preference, keyed
 * on the caller's identity only (nothing mailbox-scoped to authorize). */
export const setSenderImageTrust = command(
  z.object({ sender: z.string().min(3).max(320), trusted: z.boolean() }),
  async ({ sender, trusted }) => {
    const { locals } = getRequestEvent();
    if (!locals.user) error(401, "Not authenticated");
    if (trusted) await trustSenderImages(locals.db, locals.user.id, sender);
    else await untrustSenderImages(locals.db, locals.user.id, sender);
    return { trusted };
  },
);

/** Global "always show remote images" — a user-wide default that overrides the
 * per-message block for EVERY sender. Off by default (privacy: remote images are
 * tracking beacons). Reads/writes are keyed on the caller's identity only. */
export const imagesLoadAll = query(async (): Promise<boolean> => {
  const { locals } = getRequestEvent();
  if (!locals.user) return false;
  return loadsAllRemoteImages(locals.db, locals.user.id);
});

export const setImagesLoadAll = command(z.object({ on: z.boolean() }), async ({ on }) => {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  await setLoadAllRemoteImages(locals.db, locals.user.id, on);
  return { on };
});

export const starThread = command(
  z.object({ mailboxId: z.string().min(1), threadId: z.string().min(1), starred: z.boolean() }),
  async ({ mailboxId, threadId, starred }) => {
    await assertThreadGrant(mailboxId, threadId);
    const { locals } = getRequestEvent();
    await locals.db
      .update(mail.threadState)
      .set({ isStarred: starred })
      .where(
        and(eq(mail.threadState.threadId, threadId), eq(mail.threadState.mailboxId, mailboxId)),
      );
    return { ok: true as const };
  },
);

/** Max pins per mailbox — keeps the pinned-list query (and its partial index) a
 * small set the client cheaply merges atop the main list. Enforced HERE, not
 * just in the UI. */
const MAX_PINS = 10;

export const pinThread = command(
  z.object({ mailboxId: z.string().min(1), threadId: z.string().min(1), pinned: z.boolean() }),
  async ({ mailboxId, threadId, pinned }) => {
    await assertThreadGrant(mailboxId, threadId);
    const { locals } = getRequestEvent();
    if (pinned) {
      const [{ count: pinnedCount }] = await locals.db
        .select({ count: count() })
        .from(mail.threadState)
        .where(and(eq(mail.threadState.mailboxId, mailboxId), isNotNull(mail.threadState.pinnedAt)));
      if (pinnedCount >= MAX_PINS) error(409, `You can pin up to ${MAX_PINS} conversations per mailbox.`);
    }
    await locals.db
      .update(mail.threadState)
      .set({ pinnedAt: pinned ? new Date() : null })
      .where(and(eq(mail.threadState.threadId, threadId), eq(mail.threadState.mailboxId, mailboxId)));
    return { ok: true as const, pinned };
  },
);

// ---- Collaboration layer (Task 5) -------------------------------------------

function searchKey(): string {
  const k = getRequestEvent().platform?.env?.MAIL_SEARCH_KEY;
  if (!k) error(500, "Search key is not configured.");
  return k;
}

/** Write an internal note on a thread (grant holders only; never transmitted). */
export const addNote = command(
  z.object({ mailboxId: z.string().min(1), threadId: z.string().min(1), body: z.string().trim().min(1) }),
  async ({ mailboxId, threadId, body }) => {
    const { box } = await assertThreadGrant(mailboxId, threadId);
    const { locals, platform } = getRequestEvent();
    return createNote(
      locals.db,
      await contentKey(),
      searchKey(),
      {
        orgId: box.orgId,
        threadId,
        mailboxId,
        authorUserId: locals.user!.id,
        body,
      },
      platform?.env?.MAIL_EVENTS,
      platform?.env,
    );
  },
);

/** Teammates who can access this mailbox — the @mention candidate list for the
 * note composer. Fetched once per composer and filtered client-side (no
 * per-keystroke query). Excludes the caller; empty if the caller can't see the
 * mailbox (so it never leaks another mailbox's members). */
export const mentionCandidates = query(
  z.string().min(1),
  async (mailboxId): Promise<{ name: string; handle: string }[]> => {
    const { locals } = getRequestEvent();
    if (!locals.user) return [];
    const rows = await locals.db
      .select({ userId: schema.user.id, name: schema.user.name, email: schema.user.email })
      .from(schema.mailboxAccess)
      .innerJoin(schema.user, eq(schema.user.id, schema.mailboxAccess.userId))
      .where(eq(schema.mailboxAccess.mailboxId, mailboxId));
    if (!rows.some((row) => row.userId === locals.user!.id)) return []; // caller lacks access
    return rows
      .filter((row) => row.userId !== locals.user!.id)
      .map((row) => ({ name: row.name, handle: row.email.split("@")[0] }));
  },
);

export const editNoteById = command(
  z.object({ noteId: z.string().min(1), body: z.string().trim().min(1) }),
  async ({ noteId, body }) => {
    const { locals } = getRequestEvent();
    const note = await locals.db.query.internalNote.findFirst({
      where: eq(schema.internalNote.id, noteId),
      columns: { mailboxId: true },
    });
    if (!note) error(404, "Note not found");
    await assertMailboxGrant(note.mailboxId); // lost access → can't edit
    return editNote(locals.db, await contentKey(), searchKey(), {
      noteId,
      userId: locals.user!.id,
      body,
    });
  },
);

export const deleteNoteById = command(
  z.object({ noteId: z.string().min(1) }),
  async ({ noteId }) => {
    const { locals } = getRequestEvent();
    const note = await locals.db.query.internalNote.findFirst({
      where: eq(schema.internalNote.id, noteId),
      columns: { mailboxId: true },
    });
    if (!note) error(404, "Note not found");
    await assertMailboxGrant(note.mailboxId);
    await softDeleteNote(locals.db, { noteId, userId: locals.user!.id });
    return { ok: true as const };
  },
);

/**
 * Assign / reassign / unassign a thread within a mailbox. MANAGERS ONLY
 * (can_manage grant or org-admin): assignment is what grants an assigned-only
 * member sight of a thread, so it can't be self-served.
 */
export const assignThread = command(
  z.object({
    mailboxId: z.string().min(1),
    threadId: z.string().min(1),
    assigneeUserId: z.string().nullable(),
  }),
  async ({ mailboxId, threadId, assigneeUserId }) => {
    const box = await assertMailboxManage(mailboxId);
    const { locals, platform } = getRequestEvent();
    await doAssign(
      locals.db,
      {
        orgId: box.orgId,
        threadId,
        mailboxId,
        assigneeUserId,
        actorUserId: locals.user!.id,
      },
      platform?.env?.MAIL_EVENTS,
      platform?.env,
    );
    return { ok: true as const };
  },
);

/** Members who hold access to a mailbox — the assignment picker's options. */
export const mailboxMembers = query(z.string().min(1), async (mailboxId) => {
  await assertMailboxGrant(mailboxId);
  const { locals } = getRequestEvent();
  const rows = await locals.db
    .select({ userId: schema.mailboxAccess.userId, name: schema.user.name, email: schema.user.email })
    .from(schema.mailboxAccess)
    .innerJoin(schema.user, eq(schema.user.id, schema.mailboxAccess.userId))
    .where(eq(schema.mailboxAccess.mailboxId, mailboxId));
  return rows;
});
