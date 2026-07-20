import { error, type RequestHandler } from "@sveltejs/kit";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "$lib/server/db/schema.js";
import { can } from "$lib/server/can.js";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import { accessibleMailboxIds } from "$lib/server/mail/mailbox.js";

/**
 * Serve a message attachment's bytes from R2. Access mirrors thread read: the
 * user must hold a delivery to one of the message's mailboxes, or be able to
 * read the message's org through can(). Streams straight from R2 — the raw is
 * canonical, this is just a gated pipe.
 */
export const GET: RequestHandler = async ({ params, locals, platform }) => {
  const user = locals.user;
  if (!user) error(401, "Not authenticated");
  const env = platform?.env;
  if (!env?.MAIL_RAW) error(500, "Attachment storage is not configured.");

  const att = await locals.db.query.attachment.findFirst({
    where: eq(schema.attachment.id, params.id!),
    columns: { id: true, messageId: true, filename: true, contentType: true, r2Key: true },
  });
  if (!att || !att.r2Key) error(404, "Attachment not found");

  const message = await locals.db.query.message.findFirst({
    where: eq(schema.message.id, att.messageId),
    columns: { orgId: true },
  });
  if (!message) error(404, "Attachment not found");

  // Access: a delivery to one of the user's mailboxes, or org-level read.
  const myBoxes = await accessibleMailboxIds(locals.db, user.id);
  let allowed = false;
  if (myBoxes.length) {
    const del = await locals.db.query.delivery.findFirst({
      where: and(
        eq(schema.delivery.messageId, att.messageId),
        inArray(schema.delivery.mailboxId, myBoxes),
      ),
      columns: { id: true },
    });
    allowed = !!del;
  }
  if (!allowed) {
    const orgAdminOf = await actorOrgAdminOf(locals.db, user.id);
    allowed = can(
      { id: user.id, role: user.role, orgAdminOf },
      "read",
      { type: "mailbox", ownerId: "", organizationId: message.orgId },
    );
  }
  if (!allowed) error(403, "You can't access this attachment.");

  const obj = await env.MAIL_RAW.get(att.r2Key);
  if (!obj) error(404, "Attachment bytes are missing.");

  const filename = (att.filename ?? "attachment").replace(/["\\\r\n]/g, "_");
  return new Response(obj.body, {
    headers: {
      "Content-Type": att.contentType ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
};
