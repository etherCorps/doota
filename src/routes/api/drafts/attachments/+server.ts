import { json, error, type RequestHandler } from "@sveltejs/kit";
import type { OutboundEnv } from "$lib/server/mail/outbound.js";
import { stageDraftAttachment, MAX_ATTACHMENT_BYTES } from "$lib/server/mail/drafts.js";

/**
 * Draft attachment upload (Part C). Multipart POST: `draftId` + `file`. Auth is
 * the interactive session (locals.user); ownership + count/size limits are
 * enforced server-side in stageDraftAttachment before the bytes hit R2. Bytes
 * land under the draft's R2 prefix and are copied to an outbound key on send.
 */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
  if (!locals.user) error(401, "Not authenticated");

  const env = platform?.env;
  if (!env?.MAIL_DEK || !env?.MAIL_SEARCH_KEY || !env?.MAIL_RAW || !env?.MAIL_OUT_QUEUE) {
    error(500, "Outbound mail is not configured.");
  }
  const outbound: OutboundEnv = {
    MAIL_DEK: env.MAIL_DEK,
    MAIL_SEARCH_KEY: env.MAIL_SEARCH_KEY,
    MAIL_RAW: env.MAIL_RAW,
    MAIL_OUT_QUEUE: env.MAIL_OUT_QUEUE,
  };

  const form = await request.formData().catch(() => null);
  if (!form) error(400, "Expected multipart form data");
  const draftId = form.get("draftId");
  const file = form.get("file");
  if (typeof draftId !== "string" || !draftId) error(400, "draftId is required");
  if (!(file instanceof File)) error(400, "file is required");
  // Cheap pre-check; stageDraftAttachment is the authority (also checks totals).
  if (file.size > MAX_ATTACHMENT_BYTES) error(413, "Attachment is too large.");

  const attachments = await stageDraftAttachment(locals.db, outbound, draftId, locals.user.id, {
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    bytes: await file.arrayBuffer(),
  });
  return json({ attachments }, { status: 201 });
};
