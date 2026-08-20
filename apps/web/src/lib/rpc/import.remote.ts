// SPDX-License-Identifier: Apache-2.0
import { query, command, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { getAuthz } from "$lib/server/authz.js";
import { startImport, finishUpload, cancelImport, type MailboxImportJob } from "@doota/mail-core/import";

/**
 * Mailbox import rpc — export's mirror.
 *
 * The chunk bytes do NOT come through here; they go to /api/import, because a
 * remote function is the wrong shape for a multi-gigabyte body. This surface
 * only opens the import, closes it, reports on it, and cancels it.
 *
 * Unlike export there is no fresh-session gate: import writes mail *in*, it
 * doesn't decrypt anything out, so the risk it carries is clutter rather than
 * disclosure — and the dated label makes clutter reversible.
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

/** Live imports block a second one: two interleaving jobs into one mailbox is
 * a support ticket nobody can untangle afterwards. */
const LIVE = ["uploading", "queued", "running"] as const;

export const beginImport = command(
  z.object({
    mailboxId: z.string().min(1),
    filename: z.string().trim().min(1).max(200),
    sizeBytes: z.number().int().positive(),
  }),
  async ({ mailboxId, filename, sizeBytes }) => {
    const { box, user, db } = await grantOn(mailboxId);
    const live = await db.query.mailImport.findFirst({
      where: and(
        eq(schema.mailImport.mailboxId, mailboxId),
        inArray(schema.mailImport.status, LIVE as unknown as string[]),
      ),
      columns: { id: true },
    });
    if (live) error(409, "An import is already running for this mailbox.");
    const importId = await startImport(db, {
      orgId: box.orgId,
      mailboxId,
      requestedByUserId: user.id,
      filename,
      sizeBytes,
    });
    return { importId };
  },
);

export const completeImport = command(
  z.object({ mailboxId: z.string().min(1), importId: z.string().min(1) }),
  async ({ mailboxId, importId }) => {
    const { db } = await grantOn(mailboxId);
    const row = await db.query.mailImport.findFirst({
      where: and(eq(schema.mailImport.id, importId), eq(schema.mailImport.mailboxId, mailboxId)),
      columns: { id: true, partCount: true },
    });
    if (!row) error(404, "Import not found.");
    if (row.partCount === 0) error(400, "No chunks were uploaded.");
    const queue = getRequestEvent().platform?.env?.MAIL_QUEUE as Queue<MailboxImportJob> | undefined;
    if (!queue) error(500, "Mail queue is not configured.");
    await finishUpload(db, queue, importId);
    return { started: true as const };
  },
);

export const abortImport = command(
  z.object({ mailboxId: z.string().min(1), importId: z.string().min(1) }),
  async ({ mailboxId, importId }) => {
    const { db } = await grantOn(mailboxId);
    const row = await db.query.mailImport.findFirst({
      where: and(eq(schema.mailImport.id, importId), eq(schema.mailImport.mailboxId, mailboxId)),
      columns: { id: true },
    });
    if (!row) error(404, "Import not found.");
    await cancelImport(db, importId);
    return { canceled: true as const };
  },
);

/** Recent imports for a mailbox, newest first — the progress readout. */
export const importStatus = query(z.object({ mailboxId: z.string().min(1) }), async ({ mailboxId }) => {
  const { db } = await grantOn(mailboxId);
  const rows = await db.query.mailImport.findMany({
    where: eq(schema.mailImport.mailboxId, mailboxId),
    orderBy: [desc(schema.mailImport.createdAt)],
    limit: 5,
    columns: {
      id: true,
      status: true,
      filename: true,
      sizeBytes: true,
      partCount: true,
      cursor: true,
      messageCount: true,
      skippedCount: true,
      failedCount: true,
      labelId: true,
      error: true,
      createdAt: true,
      completedAt: true,
    },
  });
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt?.getTime() ?? 0,
    completedAt: row.completedAt?.getTime() ?? null,
    // Byte-based, because the message total isn't knowable until the file has
    // been read. Honest fraction beats a fake ETA.
    percent: row.sizeBytes > 0 ? Math.min(100, Math.round((row.cursor / row.sizeBytes) * 100)) : 0,
  }));
});
