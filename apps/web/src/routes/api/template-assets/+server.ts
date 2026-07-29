// SPDX-License-Identifier: Apache-2.0
import { json, error, type RequestHandler } from "@sveltejs/kit";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import { serviceMailboxManagerOrgIds } from "$lib/server/templates.js";
import { ORIGIN } from "$app/env/public";

/**
 * Template image upload. Multipart POST: `orgId` + `file`. Stored UNENCRYPTED
 * under `tpl/{orgId}/{id}` in R2 (email images must be publicly fetchable by the
 * recipient's client — see the public GET at [orgId]/[id]). Auth = a template
 * manager (org admin or service-mailbox manager). Returns a HOST-ABSOLUTE URL
 * (canonical ORIGIN, not the request origin) so it resolves in email clients and
 * CSS `url()` backgrounds regardless of which host served the upload.
 */
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const POST: RequestHandler = async ({ request, locals, platform, url }) => {
  if (!locals.user) error(401, "Not authenticated");
  const env = platform?.env;
  if (!env?.MAIL_RAW) error(500, "Storage is not configured.");

  const form = await request.formData().catch(() => null);
  if (!form) error(400, "Expected multipart form data");
  const orgId = form.get("orgId");
  const file = form.get("file");
  if (typeof orgId !== "string" || !orgId) error(400, "orgId is required");
  if (!(file instanceof File)) error(400, "file is required");
  if (!ALLOWED.has(file.type)) error(400, "Only PNG, JPEG, GIF or WebP images are allowed.");
  if (file.size > MAX_BYTES) error(413, "Image is too large (max 2 MB).");

  // Manager gate — same as template management.
  const [admin, svc] = await Promise.all([
    actorOrgAdminOf(locals.db, locals.user.id),
    serviceMailboxManagerOrgIds(locals.db, locals.user.id),
  ]);
  if (![...admin, ...svc].includes(orgId)) error(403, "You don't manage templates for this organization.");

  const id = crypto.randomUUID();
  await env.MAIL_RAW.put(`tpl/${orgId}/${id}`, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });

  return json({ url: `${ORIGIN || url.origin}/api/template-assets/${orgId}/${id}` }, { status: 201 });
};
