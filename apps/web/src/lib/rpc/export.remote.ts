// SPDX-License-Identifier: Apache-2.0
import { query, command, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { getAuthz } from "$lib/server/authz.js";
import { kickExport, type MailboxExportJob } from "@doota/mail-core/export";
import { signResourceToken } from "$lib/server/resource-token.js";

/**
 * Mailbox export rpc (build guide, Phase 6). The export is plaintext by
 * definition (it decrypts everything), so:
 *  - gated behind a fresh authentication (session younger than 30 min; an
 *    older session must re-login first),
 *  - the capability URL lives minutes, not days,
 *  - the mail_export row + export.requested log are the audit trail.
 */

const FRESH_SESSION_MS = 30 * 60 * 1000;
const DOWNLOAD_TTL_MS = 15 * 60 * 1000;

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
  return { box, user: locals.user, db: locals.db, session: locals.session };
}

function requireFreshAuth(session: { createdAt?: Date | string | null } | undefined) {
  const created = session?.createdAt ? new Date(session.createdAt).getTime() : 0;
  if (!created || Date.now() - created > FRESH_SESSION_MS) {
    error(403, "Re-authentication required: sign in again to export this mailbox.");
  }
}

export const startExport = command(z.object({ mailboxId: z.string().min(1) }), async ({ mailboxId }) => {
  const { box, user, db, session } = await grantOn(mailboxId);
  requireFreshAuth(session);
  const queue = getRequestEvent().platform?.env?.MAIL_QUEUE as Queue<MailboxExportJob> | undefined;
  if (!queue) error(500, "Mail queue is not configured.");
  const exportId = await kickExport(db, queue, {
    orgId: box.orgId,
    mailboxId,
    requestedByUserId: user.id,
  });
  return { ok: true as const, exportId };
});

export const exportStatus = query(
  z.object({ mailboxId: z.string().min(1) }),
  async ({ mailboxId }) => {
    const { db } = await grantOn(mailboxId);
    const rows = await db.query.mailExport.findMany({
      where: eq(schema.mailExport.mailboxId, mailboxId),
      orderBy: desc(schema.mailExport.createdAt),
      limit: 5,
    });
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      messageCount: r.messageCount,
      error: r.error,
      createdAt: r.createdAt.getTime(),
      completedAt: r.completedAt ? r.completedAt.getTime() : null,
    }));
  },
);

/** Mint the short-lived capability URL for a finished export. */
export const exportDownloadUrl = command(
  z.object({ mailboxId: z.string().min(1), exportId: z.string().min(1) }),
  async ({ mailboxId, exportId }) => {
    const { db, session } = await grantOn(mailboxId);
    requireFreshAuth(session);
    const row = await db.query.mailExport.findFirst({ where: eq(schema.mailExport.id, exportId) });
    if (!row || row.mailboxId !== mailboxId) error(404, "Export not found");
    if (row.status !== "done") error(409, "Export is not finished yet.");
    const secret = getRequestEvent().platform?.env?.MAIL_SEARCH_KEY;
    if (!secret) error(500, "Signing key is not configured.");
    const token = await signResourceToken(secret, `export:${exportId}`, DOWNLOAD_TTL_MS);
    return { ok: true as const, url: `/api/export/${exportId}?token=${encodeURIComponent(token)}` };
  },
);
