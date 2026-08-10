// SPDX-License-Identifier: Apache-2.0
import { query, command, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import type { ScanVerdict } from "@doota/mail-core/attachment-scan";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { can } from "@doota/db/can";
import { getAuthz } from "$lib/server/authz.js";

/**
 * Attachment scan verdicts: advisory display signal only. The verdict is
 * never an authorization input. `recordScanVerdict` records what the client's
 * scan found so a teammate sees it without rescanning, and nothing gates on it.
 *
 * Access mirrors the attachment bytes route (api/attachments/[id]): the caller
 * must hold a delivery to one of the message's mailboxes, or be able to read the
 * message's org through can(). Same gate, no parallel permission path.
 */
async function assertAttachmentAccess(attachmentId: string) {
  const { locals } = getRequestEvent();
  const user = locals.user;
  if (!user) error(401, "Not authenticated");

  const att = await locals.db.query.attachment.findFirst({
    where: eq(schema.attachment.id, attachmentId),
    columns: { id: true, messageId: true },
  });
  if (!att) error(404, "Attachment not found");

  const message = await locals.db.query.message.findFirst({
    where: eq(schema.message.id, att.messageId),
    columns: { orgId: true },
  });
  if (!message) error(404, "Attachment not found");

  const { mailboxIds, orgAdminOf } = await getAuthz();
  let allowed = false;
  if (mailboxIds.length) {
    const del = await locals.db.query.delivery.findFirst({
      where: and(
        eq(schema.delivery.messageId, att.messageId),
        inArray(schema.delivery.mailboxId, mailboxIds),
      ),
      columns: { id: true },
    });
    allowed = !!del;
  }
  if (!allowed) {
    allowed = can(
      { id: user.id, role: user.role, orgAdminOf },
      "read",
      { type: "mailbox", ownerId: "", organizationId: message.orgId },
    );
  }
  if (!allowed) error(403, "You can't access this attachment.");
  return { db: locals.db };
}

/** The persisted verdict for an attachment, or null if never scanned, so a
 * teammate reuses another's scan instead of rescanning. */
export const attachmentScanState = query(
  z.object({ attachmentId: z.string().min(1) }),
  async ({ attachmentId }) => {
    const { db } = await assertAttachmentAccess(attachmentId);
    const row = await db.query.attachment.findFirst({
      where: eq(schema.attachment.id, attachmentId),
      columns: { scanVerdict: true, scanRule: true, scannedAt: true, scannerVersion: true },
    });
    if (!row?.scanVerdict) return null;
    return {
      // Column is untyped `text`, but only `recordScanVerdict` (enum-validated)
      // ever writes it, so the stored value is always one of the four verdicts.
      verdict: row.scanVerdict as ScanVerdict,
      rule: row.scanRule,
      scannedAt: row.scannedAt,
      scannerVersion: row.scannerVersion,
    };
  },
);

/** Record what the client's scan found. Advisory only: this write records the
 * display signal and gates nothing. Never trust it as authz. */
export const recordScanVerdict = command(
  z.object({
    attachmentId: z.string().min(1),
    sha256: z.string().optional(),
    verdict: z.enum(["clean", "matched", "skipped", "error"]),
    rule: z.string().nullable(),
    scannerVersion: z.string(),
  }),
  async ({ attachmentId, sha256, verdict, rule, scannerVersion }) => {
    const { db } = await assertAttachmentAccess(attachmentId);
    await db
      .update(schema.attachment)
      .set({
        sha256: sha256 ?? null,
        scanVerdict: verdict,
        scanRule: rule,
        scannedAt: new Date(),
        scannerVersion,
      })
      .where(eq(schema.attachment.id, attachmentId));
  },
);
