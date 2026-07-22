import { query, command, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { can } from "@doota/db/can";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import { accessibleMailboxIds } from "@doota/mail-core/mailbox";
import { importKey } from "@doota/mail-core/crypto";
import { listThreads, getThread } from "@doota/mail-core/read";
import { createNote, editNote, softDeleteNote } from "@doota/mail-core/notes";
import { assignThread as doAssign, emitPlacementEvent } from "@doota/mail-core/collab";

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
 * Assert the current user may read this mailbox. Returns the box + whether the
 * user holds an actual mailbox_access GRANT (distinct from org-admin read):
 * internal notes + system events follow the grant, NOT org read — an admin
 * reading a mailbox they aren't a member of sees the mail but never the notes.
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

  const hasGrant = (await accessibleMailboxIds(locals.db, user.id)).includes(mailboxId);
  // Only fall back to the org-admin read check when there's no grant — otherwise
  // a plain member (never an org admin) trips a spurious can() deny on every
  // thread list/open. A grant is already sufficient.
  if (!hasGrant) {
    const orgAdminOf = await actorOrgAdminOf(locals.db, user.id);
    const orgRead = can(
      { id: user.id, role: user.role, orgAdminOf },
      "read",
      { type: "mailbox", ownerId: "", organizationId: box.orgId },
    );
    if (!orgRead) error(403, "You can't read this mailbox.");
  }
  return { box, hasGrant };
}

/** Assert the user holds a mailbox_access GRANT (required to read/write notes,
 * assign, or otherwise touch the collaboration layer). */
async function assertMailboxGrant(mailboxId: string) {
  const { box, hasGrant } = await assertMailboxAccess(mailboxId);
  if (!hasGrant) error(403, "You need access to this mailbox.");
  return box;
}

const PLACEMENTS = ["inbox", "archived", "spam", "trash", "sent"] as const;

// Kept local: a remote-function module may export ONLY remote functions.
const PAGE_SIZE = 30;

export const mailboxThreads = query(
  z.object({
    mailboxId: z.string().min(1),
    placement: z.enum(PLACEMENTS).default("inbox"),
    offset: z.number().int().min(0).default(0),
  }),
  async ({ mailboxId, placement, offset }) => {
    const { hasGrant } = await assertMailboxAccess(mailboxId);
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
    });
  },
);

export const openThread = query(
  z.object({ mailboxId: z.string().min(1), threadId: z.string().min(1) }),
  async ({ mailboxId, threadId }) => {
    const { hasGrant } = await assertMailboxAccess(mailboxId);
    const { locals } = getRequestEvent();
    const ck = await contentKey();
    // Notes/events are included ONLY for grant holders (not org-admin readers).
    const dto = await getThread(locals.db, {
      mailboxId,
      threadId,
      ck,
      includeCollab: hasGrant,
      userId: locals.user!.id,
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
    const box = await assertMailboxGrant(mailboxId);
    const { locals } = getRequestEvent();
    // Thread must actually be in this mailbox (guards a bad threadId).
    const state = await locals.db.query.threadState.findFirst({
      where: and(eq(schema.threadState.threadId, threadId), eq(schema.threadState.mailboxId, mailboxId)),
      columns: { id: true },
    });
    if (!state) error(404, "Thread is not in this mailbox.");
    const now = new Date();
    await locals.db
      .insert(mail.threadRead)
      .values({ orgId: box.orgId, userId: locals.user!.id, threadId, mailboxId, lastReadAt: now })
      .onConflictDoUpdate({
        target: [mail.threadRead.userId, mail.threadRead.threadId, mail.threadRead.mailboxId],
        set: { lastReadAt: now },
      });
    return { ok: true as const };
  },
);

/** Move a thread to a placement (archive/spam/trash/inbox) for this mailbox. */
export const moveThread = command(
  z.object({
    mailboxId: z.string().min(1),
    threadId: z.string().min(1),
    placement: z.enum(PLACEMENTS),
  }),
  async ({ mailboxId, threadId, placement }) => {
    const box = await assertMailboxGrant(mailboxId);
    const { locals, locals: { user } } = getRequestEvent();
    const prev = await locals.db.query.threadState.findFirst({
      where: and(eq(schema.threadState.threadId, threadId), eq(schema.threadState.mailboxId, mailboxId)),
      columns: { placement: true },
    });
    await locals.db
      .update(mail.threadState)
      .set({ placement, hiddenAt: null }) // moving un-hides
      .where(
        and(eq(mail.threadState.threadId, threadId), eq(mail.threadState.mailboxId, mailboxId)),
      );
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

/** Bulk move — one query over the selection. ponytail: no per-thread system
 * events on bulk moves (the loop of prev-placement reads isn't worth it);
 * add them if shared-mailbox timelines miss them in practice. */
export const bulkMoveThreads = command(
  z.object({
    mailboxId: z.string().min(1),
    threadIds: z.array(z.string().min(1)).min(1).max(200),
    placement: z.enum(PLACEMENTS),
  }),
  async ({ mailboxId, threadIds, placement }) => {
    await assertMailboxGrant(mailboxId);
    const { locals } = getRequestEvent();
    await locals.db
      .update(mail.threadState)
      .set({ placement, hiddenAt: null }) // moving un-hides
      .where(and(eq(mail.threadState.mailboxId, mailboxId), inArray(mail.threadState.threadId, threadIds)));
    return { ok: true as const };
  },
);

/** "Empty trash/spam": hides every thread at the placement — never a hard
 * delete (messages, R2 content and other mailboxes' state are untouched). */
export const emptyFolder = command(
  z.object({ mailboxId: z.string().min(1), placement: z.enum(["trash", "spam"]) }),
  async ({ mailboxId, placement }) => {
    await assertMailboxGrant(mailboxId);
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
export const starThread = command(
  z.object({ mailboxId: z.string().min(1), threadId: z.string().min(1), starred: z.boolean() }),
  async ({ mailboxId, threadId, starred }) => {
    await assertMailboxGrant(mailboxId);
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
    const box = await assertMailboxGrant(mailboxId);
    const { locals } = getRequestEvent();
    const state = await locals.db.query.threadState.findFirst({
      where: and(eq(schema.threadState.threadId, threadId), eq(schema.threadState.mailboxId, mailboxId)),
      columns: { id: true },
    });
    if (!state) error(404, "Thread is not in this mailbox.");
    return createNote(locals.db, await contentKey(), searchKey(), {
      orgId: box.orgId,
      threadId,
      mailboxId,
      authorUserId: locals.user!.id,
      body,
    });
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

/** Assign / reassign / unassign a thread within a mailbox (grant holders only). */
export const assignThread = command(
  z.object({
    mailboxId: z.string().min(1),
    threadId: z.string().min(1),
    assigneeUserId: z.string().nullable(),
  }),
  async ({ mailboxId, threadId, assigneeUserId }) => {
    const box = await assertMailboxGrant(mailboxId);
    const { locals } = getRequestEvent();
    await doAssign(locals.db, {
      orgId: box.orgId,
      threadId,
      mailboxId,
      assigneeUserId,
      actorUserId: locals.user!.id,
    });
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
