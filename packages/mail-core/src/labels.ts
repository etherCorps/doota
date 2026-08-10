// SPDX-License-Identifier: Apache-2.0
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Folders = labels (build guide, Phase 1). The schema is multi-membership
 * (`thread_label`); folder-like behaviour lives in one action — moveToFolder
 * replaces a thread's labels — so relaxing it later is a UI change, not a
 * migration. `label` is mailbox-scoped (privacy: folder names must not leak
 * across mailboxes; a personal mailbox's folders are nobody else's business);
 * application is per (thread, mailbox). Placement stays system-only
 * (inbox/archived/spam/trash). Nesting caps at depth 2; deeper trees are where
 * folder UIs become unnavigable.
 */

export class LabelError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "depth" | "cycle" | "duplicate",
  ) {
    super(message);
    this.name = "LabelError";
  }
}

async function mailboxLabel(db: Db, mailboxId: string, labelId: string) {
  const row = await db.query.label.findFirst({
    where: and(eq(schema.label.id, labelId), eq(schema.label.mailboxId, mailboxId)),
  });
  if (!row) throw new LabelError("Folder not found.", "not_found");
  return row;
}

export async function listLabels(db: Db, mailboxId: string) {
  return db.query.label.findMany({
    where: eq(schema.label.mailboxId, mailboxId),
    orderBy: asc(schema.label.name),
  });
}

export async function createLabel(
  db: Db,
  input: {
    mailboxId: string;
    orgId: string; // denormalized org check, stored alongside mailboxId
    name: string;
    color?: string | null;
    parentId?: string | null;
  },
) {
  if (input.parentId) {
    const parent = await mailboxLabel(db, input.mailboxId, input.parentId);
    if (parent.parentId) throw new LabelError("Folders nest at most two levels.", "depth");
  }
  const existing = await db.query.label.findFirst({
    where: and(eq(schema.label.mailboxId, input.mailboxId), eq(schema.label.name, input.name)),
    columns: { id: true },
  });
  if (existing) throw new LabelError("A folder with that name already exists.", "duplicate");
  const [row] = await db
    .insert(mail.label)
    .values({
      orgId: input.orgId,
      mailboxId: input.mailboxId,
      name: input.name,
      color: input.color ?? null,
      parentId: input.parentId ?? null,
    })
    .returning();
  return row;
}

export async function updateLabel(
  db: Db,
  input: {
    mailboxId: string;
    labelId: string;
    name?: string;
    color?: string | null;
    parentId?: string | null;
    notifyNewMail?: boolean;
  },
) {
  const current = await mailboxLabel(db, input.mailboxId, input.labelId);
  const set: Record<string, unknown> = {};
  if (input.name !== undefined && input.name !== current.name) {
    const dupe = await db.query.label.findFirst({
      where: and(eq(schema.label.mailboxId, input.mailboxId), eq(schema.label.name, input.name)),
      columns: { id: true },
    });
    if (dupe && dupe.id !== input.labelId)
      throw new LabelError("A folder with that name already exists.", "duplicate");
    set.name = input.name;
  }
  if (input.color !== undefined) set.color = input.color;
  if (input.notifyNewMail !== undefined) set.notifyNewMail = input.notifyNewMail;
  if (input.parentId !== undefined) {
    if (input.parentId === input.labelId) throw new LabelError("A folder can't contain itself.", "cycle");
    if (input.parentId) {
      const parent = await mailboxLabel(db, input.mailboxId, input.parentId);
      if (parent.parentId) throw new LabelError("Folders nest at most two levels.", "depth");
      const child = await db.query.label.findFirst({
        where: and(eq(schema.label.mailboxId, input.mailboxId), eq(schema.label.parentId, input.labelId)),
        columns: { id: true },
      });
      if (child) throw new LabelError("Folders nest at most two levels.", "depth");
    }
    set.parentId = input.parentId;
  }
  if (Object.keys(set).length === 0) return current;
  const [row] = await db
    .update(mail.label)
    .set(set)
    .where(and(eq(mail.label.id, input.labelId), eq(mail.label.mailboxId, input.mailboxId)))
    .returning();
  return row;
}

/**
 * Delete a folder. Its threads are re-filed to `moveContentsToLabelId` when
 * given, otherwise their label rows are removed — the threads keep their
 * placement either way, mail is never orphaned or deleted. Children hop up to
 * the deleted folder's parent (root when none).
 */
export async function deleteLabel(
  db: Db,
  input: { mailboxId: string; labelId: string; moveContentsToLabelId?: string | null },
): Promise<void> {
  const current = await mailboxLabel(db, input.mailboxId, input.labelId);
  const target = input.moveContentsToLabelId
    ? await mailboxLabel(db, input.mailboxId, input.moveContentsToLabelId)
    : null;
  if (target) {
    // A mailbox-scoped label's rows are all in its own mailbox already.
    const rows = await db
      .select({ threadId: mail.threadLabel.threadId })
      .from(mail.threadLabel)
      .where(eq(mail.threadLabel.labelId, input.labelId));
    if (rows.length) {
      await db
        .insert(mail.threadLabel)
        .values(rows.map((r) => ({ threadId: r.threadId, mailboxId: input.mailboxId, labelId: target.id })))
        .onConflictDoNothing();
    }
  }
  await db
    .update(mail.label)
    .set({ parentId: current.parentId ?? null })
    .where(and(eq(mail.label.mailboxId, input.mailboxId), eq(mail.label.parentId, input.labelId)));
  // thread_label rows cascade via FK on label delete.
  await db
    .delete(mail.label)
    .where(and(eq(mail.label.id, input.labelId), eq(mail.label.mailboxId, input.mailboxId)));
}

/** "Add label" — the additive, cross-cutting action (multi-membership). */
export async function applyLabel(
  db: Db,
  input: { threadId: string; mailboxId: string; labelId: string },
): Promise<void> {
  // Ownership check closes the cross-mailbox apply hole: a label id from
  // another mailbox must read as nonexistent, not get silently attached.
  await mailboxLabel(db, input.mailboxId, input.labelId);
  await db
    .insert(mail.threadLabel)
    .values({ threadId: input.threadId, mailboxId: input.mailboxId, labelId: input.labelId })
    .onConflictDoNothing();
}

export async function removeLabel(
  db: Db,
  input: { threadId: string; mailboxId: string; labelId: string },
): Promise<void> {
  await db
    .delete(mail.threadLabel)
    .where(
      and(
        eq(mail.threadLabel.threadId, input.threadId),
        eq(mail.threadLabel.mailboxId, input.mailboxId),
        eq(mail.threadLabel.labelId, input.labelId),
      ),
    );
}

/** Everything moveToFolder changes, captured for the undo snackbar. */
export type MoveSnapshot = {
  threadId: string;
  mailboxId: string;
  labelIds: string[];
  placement: string;
  placementOrigin: string;
  placementRuleId: string | null;
  placementUserId: string | null;
  placementAt: number | null;
};

/**
 * "Move to folder" — replaces the thread's labels with the one target (folder
 * behaviour on a multi-membership table; the constraint lives here, not in the
 * schema). Filing is moving: the thread leaves the inbox (placement
 * `archived`); `labelId: null` moves it back to Inbox and clears its folders.
 * Stamps `user` origin: rules never re-file a user-placed thread, and a new
 * reply resurfaces it. Returns the prior state for undo.
 */
export async function moveThreadToFolder(
  db: Db,
  input: {
    threadId: string;
    mailboxId: string;
    labelId: string | null;
    userId: string;
  },
): Promise<MoveSnapshot> {
  if (input.labelId) await mailboxLabel(db, input.mailboxId, input.labelId);
  const state = await db.query.threadState.findFirst({
    where: and(
      eq(schema.threadState.threadId, input.threadId),
      eq(schema.threadState.mailboxId, input.mailboxId),
    ),
  });
  if (!state) throw new LabelError("Thread is not in this mailbox.", "not_found");
  const prevLabels = await db
    .select({ labelId: mail.threadLabel.labelId })
    .from(mail.threadLabel)
    .where(
      and(eq(mail.threadLabel.threadId, input.threadId), eq(mail.threadLabel.mailboxId, input.mailboxId)),
    );
  const snapshot: MoveSnapshot = {
    threadId: input.threadId,
    mailboxId: input.mailboxId,
    labelIds: prevLabels.map((l) => l.labelId),
    placement: state.placement,
    placementOrigin: state.placementOrigin,
    placementRuleId: state.placementRuleId,
    placementUserId: state.placementUserId,
    placementAt: state.placementAt ? state.placementAt.getTime() : null,
  };

  await db
    .delete(mail.threadLabel)
    .where(
      and(eq(mail.threadLabel.threadId, input.threadId), eq(mail.threadLabel.mailboxId, input.mailboxId)),
    );
  if (input.labelId) {
    await db
      .insert(mail.threadLabel)
      .values({ threadId: input.threadId, mailboxId: input.mailboxId, labelId: input.labelId })
      .onConflictDoNothing();
  }
  await db
    .update(mail.threadState)
    .set({
      placement: input.labelId ? "archived" : "inbox",
      hiddenAt: null,
      placementOrigin: "user",
      placementUserId: input.userId,
      placementRuleId: null,
      placementAt: new Date(),
    })
    .where(eq(mail.threadState.id, state.id));
  return snapshot;
}

/** Undo a moveToFolder: restore labels, placement, and its origin stamps. */
export async function undoMoveToFolder(db: Db, snap: MoveSnapshot): Promise<void> {
  await db
    .delete(mail.threadLabel)
    .where(and(eq(mail.threadLabel.threadId, snap.threadId), eq(mail.threadLabel.mailboxId, snap.mailboxId)));
  if (snap.labelIds.length) {
    await db
      .insert(mail.threadLabel)
      .values(snap.labelIds.map((labelId) => ({ threadId: snap.threadId, mailboxId: snap.mailboxId, labelId })))
      .onConflictDoNothing();
  }
  await db
    .update(mail.threadState)
    .set({
      placement: snap.placement,
      placementOrigin: snap.placementOrigin,
      placementRuleId: snap.placementRuleId,
      placementUserId: snap.placementUserId,
      placementAt: snap.placementAt ? new Date(snap.placementAt) : null,
    })
    .where(
      and(eq(mail.threadState.threadId, snap.threadId), eq(mail.threadState.mailboxId, snap.mailboxId)),
    );
}

/** Labels on a set of threads for one mailbox — the list rows' folder chips. */
export async function labelsForThreads(
  db: Db,
  input: { mailboxId: string; threadIds: string[] },
): Promise<Map<string, { labelId: string; name: string; color: string | null }[]>> {
  if (!input.threadIds.length) return new Map();
  const rows = await db
    .select({
      threadId: mail.threadLabel.threadId,
      labelId: mail.threadLabel.labelId,
      name: mail.label.name,
      color: mail.label.color,
    })
    .from(mail.threadLabel)
    .innerJoin(mail.label, eq(mail.threadLabel.labelId, mail.label.id))
    .where(
      and(
        eq(mail.threadLabel.mailboxId, input.mailboxId),
        inArray(mail.threadLabel.threadId, input.threadIds),
      ),
    );
  const out = new Map<string, { labelId: string; name: string; color: string | null }[]>();
  for (const row of rows) {
    const list = out.get(row.threadId) ?? [];
    list.push({ labelId: row.labelId, name: row.name, color: row.color });
    out.set(row.threadId, list);
  }
  return out;
}
