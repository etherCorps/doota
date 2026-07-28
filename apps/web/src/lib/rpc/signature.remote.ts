// SPDX-License-Identifier: Apache-2.0
import { command, query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import * as mail from "@doota/db/mail.schema";
import { listSendIdentities } from "@doota/mail-core/identities";
import { sanitizeEmailHtml } from "@doota/mail-core/sanitize-email";

/**
 * Per-(user, mailbox) email signatures. A signature belongs to the SENDER, so a
 * user can only read/write signatures for mailboxes they may send from
 * (listSendIdentities = the canSend + can() basis). Injected into the composer
 * client-side; sanitized here on write so a stored signature can't smuggle
 * script/handlers into the composer or the outbound mail.
 */

function requireUser() {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  return locals.user;
}

/** Distinct mailbox ids the caller may send from (identities include aliases;
 * signatures are per mailbox, so collapse to the mailbox set). */
async function sendableMailboxIds(): Promise<string[]> {
  const { locals } = getRequestEvent();
  const ids = (await listSendIdentities(locals.db, requireUser().id)).map((i) => i.mailboxId);
  return [...new Set(ids)];
}

export type MailboxSignature = { mailboxId: string; address: string; displayName: string | null; bodyHtml: string };

/** The caller's signature per sendable mailbox (empty string where unset),
 * labelled with the mailbox address for the settings UI. */
export const myMailboxSignatures = query(async (): Promise<MailboxSignature[]> => {
  const { locals } = getRequestEvent();
  const user = requireUser();
  const mailboxIds = await sendableMailboxIds();
  if (!mailboxIds.length) return [];
  const [sigs, boxes] = await Promise.all([
    locals.db.query.mailboxSignature.findMany({
      where: and(eq(mail.mailboxSignature.userId, user.id), inArray(mail.mailboxSignature.mailboxId, mailboxIds)),
      columns: { mailboxId: true, bodyHtml: true },
    }),
    locals.db.query.mailbox.findMany({
      where: inArray(mail.mailbox.id, mailboxIds),
      columns: { id: true, address: true, displayName: true },
    }),
  ]);
  const byMailbox = new Map(sigs.map((r) => [r.mailboxId, r.bodyHtml]));
  return boxes.map((b) => ({
    mailboxId: b.id,
    address: b.address,
    displayName: b.displayName,
    bodyHtml: byMailbox.get(b.id) ?? "",
  }));
});

/** Set (or clear, with "") the caller's signature for a mailbox they send from. */
export const setMailboxSignature = command(
  z.object({ mailboxId: z.string().min(1), bodyHtml: z.string().max(20_000) }),
  async ({ mailboxId, bodyHtml }) => {
    const { locals } = getRequestEvent();
    const user = requireUser();
    if (!(await sendableMailboxIds()).includes(mailboxId)) {
      error(403, "You can't set a signature for this mailbox.");
    }
    // Sanitize on the trust boundary — the stored HTML is re-injected into the
    // composer and rides out with the mail. Empty stays empty (cleared).
    let clean = "";
    if (bodyHtml.trim()) {
      const r = sanitizeEmailHtml(bodyHtml);
      if (!r.ok) error(400, "Signature is too large.");
      clean = r.html;
    }
    await locals.db
      .insert(mail.mailboxSignature)
      .values({ userId: user.id, mailboxId, bodyHtml: clean, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [mail.mailboxSignature.userId, mail.mailboxSignature.mailboxId],
        set: { bodyHtml: clean, updatedAt: new Date() },
      });
    return { mailboxId, bodyHtml: clean };
  },
);
