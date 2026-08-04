// SPDX-License-Identifier: Apache-2.0
import { query, command, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { getAuthz } from "$lib/server/authz.js";
import {
  listLabels,
  createLabel,
  updateLabel,
  deleteLabel,
  applyLabel,
  removeLabel,
  moveThreadToFolder,
  undoMoveToFolder,
  labelsForThreads,
  LabelError,
  type MoveSnapshot,
} from "@doota/mail-core/labels";
import { countUnreadByLabel } from "@doota/mail-core/read";

/**
 * Folders (labels) rpc. `label` is org-scoped — the vocabulary is shared across
 * the org — while application (`thread_label`) is per (thread, mailbox). Any
 * mailbox GRANT in the org is enough to manage the shared folder list; thread
 * filing additionally requires a grant on that mailbox (same chokepoints as
 * thread.remote.ts, never a parallel permission path).
 */

async function grantOn(mailboxId: string) {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  const box = await locals.db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, mailboxId),
    columns: { id: true, orgId: true },
  });
  if (!box) error(404, "Mailbox not found");
  const { mailboxIds } = await getAuthz();
  if (!mailboxIds.includes(mailboxId)) error(403, "You need access to this mailbox.");
  return { box, user: locals.user, db: locals.db };
}

function rethrow(e: unknown): never {
  if (e instanceof LabelError) {
    error(e.code === "not_found" ? 404 : 400, e.message);
  }
  throw e;
}

/** Org folder tree + per-mailbox unread counts, one call for the sidebar. */
export const myFolders = query(z.object({ mailboxId: z.string().min(1) }), async ({ mailboxId }) => {
  const { box, user, db } = await grantOn(mailboxId);
  const [labels, unread, rules] = await Promise.all([
    listLabels(db, box.orgId),
    countUnreadByLabel(db, { mailboxId, userId: user.id }),
    db.query.rule.findMany({
      where: and(eq(schema.rule.mailboxId, mailboxId), eq(schema.rule.enabled, true)),
      columns: { id: true, actions: true },
    }),
  ]);
  // Folders fed by a rule (moveTo/addLabel target) get the ✱ badge; the badge
  // links to the first rule that feeds them.
  const fedBy = new Map<string, string>();
  for (const ruleRow of rules) {
    try {
      for (const action of JSON.parse(ruleRow.actions) as { type: string; labelId?: string }[]) {
        if ((action.type === "moveTo" || action.type === "addLabel") && action.labelId && !fedBy.has(action.labelId)) {
          fedBy.set(action.labelId, ruleRow.id);
        }
      }
    } catch {
      // unreadable actions: no badge
    }
  }
  return labels.map((labelRow) => ({
    id: labelRow.id,
    name: labelRow.name,
    color: labelRow.color,
    parentId: labelRow.parentId,
    notifyNewMail: labelRow.notifyNewMail,
    unread: unread.get(labelRow.id) ?? 0,
    ruleFed: fedBy.has(labelRow.id),
    fedByRuleId: fedBy.get(labelRow.id) ?? null,
  }));
});

export const createFolder = command(
  z.object({
    mailboxId: z.string().min(1),
    name: z.string().trim().min(1).max(60),
    color: z.string().max(30).nullish(),
    parentId: z.string().nullish(),
  }),
  async ({ mailboxId, name, color, parentId }) => {
    const { box, db } = await grantOn(mailboxId);
    try {
      const row = await createLabel(db, { orgId: box.orgId, name, color, parentId });
      return { ok: true as const, id: row.id };
    } catch (e) {
      rethrow(e);
    }
  },
);

export const updateFolder = command(
  z.object({
    mailboxId: z.string().min(1),
    labelId: z.string().min(1),
    name: z.string().trim().min(1).max(60).optional(),
    color: z.string().max(30).nullish().optional(),
    parentId: z.string().nullable().optional(),
    notifyNewMail: z.boolean().optional(),
  }),
  async ({ mailboxId, labelId, name, color, parentId, notifyNewMail }) => {
    const { box, db } = await grantOn(mailboxId);
    try {
      await updateLabel(db, { orgId: box.orgId, labelId, name, color, parentId, notifyNewMail });
      return { ok: true as const };
    } catch (e) {
      rethrow(e);
    }
  },
);

export const deleteFolder = command(
  z.object({
    mailboxId: z.string().min(1),
    labelId: z.string().min(1),
    /** Where the folder's threads go; omitted = they just lose the label
     * (mail keeps its placement — never orphaned, never deleted). */
    moveContentsToLabelId: z.string().nullish(),
  }),
  async ({ mailboxId, labelId, moveContentsToLabelId }) => {
    const { box, db } = await grantOn(mailboxId);
    try {
      await deleteLabel(db, { orgId: box.orgId, labelId, moveContentsToLabelId });
      return { ok: true as const };
    } catch (e) {
      rethrow(e);
    }
  },
);

/** Folder chips for the visible list rows. */
export const threadFolders = query(
  z.object({ mailboxId: z.string().min(1), threadIds: z.array(z.string().min(1)).max(100) }),
  async ({ mailboxId, threadIds }) => {
    const { db } = await grantOn(mailboxId);
    const map = await labelsForThreads(db, { mailboxId, threadIds });
    return Object.fromEntries(map);
  },
);

/** "Add label" — additive, for the cross-cutting case. */
export const addThreadLabel = command(
  z.object({ mailboxId: z.string().min(1), threadId: z.string().min(1), labelId: z.string().min(1) }),
  async ({ mailboxId, threadId, labelId }) => {
    const { box, db } = await grantOn(mailboxId);
    try {
      await applyLabel(db, { orgId: box.orgId, threadId, mailboxId, labelId });
      return { ok: true as const };
    } catch (e) {
      rethrow(e);
    }
  },
);

export const removeThreadLabel = command(
  z.object({ mailboxId: z.string().min(1), threadId: z.string().min(1), labelId: z.string().min(1) }),
  async ({ mailboxId, threadId, labelId }) => {
    const { db } = await grantOn(mailboxId);
    await removeLabel(db, { threadId, mailboxId, labelId });
    return { ok: true as const };
  },
);

/** "Move to…" — replaces the thread's folders with the target (null = Inbox).
 * Returns the prior state; the undo snackbar posts it back to undoMove. */
export const moveToFolder = command(
  z.object({
    mailboxId: z.string().min(1),
    threadId: z.string().min(1),
    labelId: z.string().min(1).nullable(),
  }),
  async ({ mailboxId, threadId, labelId }) => {
    const { box, user, db } = await grantOn(mailboxId);
    try {
      const snapshot = await moveThreadToFolder(db, {
        orgId: box.orgId,
        threadId,
        mailboxId,
        labelId,
        userId: user.id,
      });
      return { ok: true as const, snapshot };
    } catch (e) {
      rethrow(e);
    }
  },
);

const snapshotSchema = z.object({
  threadId: z.string().min(1),
  mailboxId: z.string().min(1),
  labelIds: z.array(z.string()),
  placement: z.string(),
  placementOrigin: z.string(),
  placementRuleId: z.string().nullable(),
  placementUserId: z.string().nullable(),
  placementAt: z.number().nullable(),
});

export const undoMove = command(snapshotSchema, async (snapshot) => {
  const { db } = await grantOn(snapshot.mailboxId);
  await undoMoveToFolder(db, snapshot as MoveSnapshot);
  return { ok: true as const };
});
