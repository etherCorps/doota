// SPDX-License-Identifier: Apache-2.0
import { error, type RequestHandler } from "@sveltejs/kit";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { can } from "@doota/db/can";
import { cachedAccessibleMailboxIds, cachedActorOrgAdminOf } from "$lib/server/authz-cache.js";
import { renderETag, isNotModified, revalidateHeaders } from "$lib/server/render-cache.js";
import { sanitizeFilename } from "$lib/utils/filename";
import { verifyResourceToken } from "$lib/server/resource-token.js";

// Content types we'll serve as declared. Everything else (HTML, SVG, XML, …) is
// forced to octet-stream so it can't be rendered/executed even if opened directly.
// (SVG is deliberately absent — it can carry script when navigated to.)
const SAFE_CONTENT_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
  "image/x-icon", "image/vnd.microsoft.icon", "application/pdf",
]);

/**
 * Serve a message attachment's bytes from R2. Access mirrors thread read: the
 * user must hold a delivery to one of the message's mailboxes, or be able to
 * read the message's org through can(). Streams straight from R2 — the raw is
 * canonical, this is just a gated pipe.
 */
export const GET: RequestHandler = async ({ params, url, request, locals, platform }) => {
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

  // Two ways in. (1) A signed token minted by the authenticated body route — the
  // ONLY path that works from the sandboxed MailFrame, whose cross-site subresource
  // requests carry no session cookie. It authorizes this message's attachments and
  // nothing else. (2) A normal session (app UI, direct open) with delivery/org read.
  let allowed = await verifyResourceToken(env.MAIL_SEARCH_KEY, `att:msg:${att.messageId}`, url.searchParams.get("t"));
  const user = locals.user;
  if (!allowed) {
    if (!user) error(401, "Not authenticated");
    const myBoxes = await cachedAccessibleMailboxIds(locals.db, user.id);
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
      const orgAdminOf = await cachedActorOrgAdminOf(locals.db, user.id);
      allowed = can(
        { id: user.id, role: user.role, orgAdminOf },
        "read",
        { type: "mailbox", ownerId: "", organizationId: message.orgId },
      );
    }
    if (!allowed) error(403, "You can't access this attachment.");
  }

  // Revalidation after auth (a revoked user 403s, never 304s). The bytes for an
  // id never change, but no-cache keeps us able to push a serving/security patch
  // (via RENDER_CACHE_VERSION) and re-check access on every view.
  const etag = renderETag(att.id);
  if (isNotModified(request, etag)) {
    return new Response(null, { status: 304, headers: revalidateHeaders(etag) });
  }

  const obj = await env.MAIL_RAW.get(att.r2Key);
  if (!obj) error(404, "Attachment bytes are missing.");

  // Never trust the email's declared type — serve known-safe media as-is, force
  // everything else to octet-stream. Disposition:attachment forces a download
  // (an <img src> still renders images), nosniff stops type-guessing, and the CSP
  // + no-same-origin sandbox neuter anything the browser might still try to run.
  const declared = (att.contentType ?? "").split(";")[0].trim().toLowerCase();
  const serveType = SAFE_CONTENT_TYPES.has(declared) ? declared : "application/octet-stream";
  const filename = sanitizeFilename(att.filename);
  return new Response(obj.body, {
    headers: {
      "Content-Type": serveType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Referrer-Policy": "no-referrer",
      // Private + always-revalidate (see render-cache.ts): cache the bytes but
      // re-check with us every view, so a revoked grant or a serving-rule patch
      // takes effect on the next view instead of lingering behind a long TTL.
      ...revalidateHeaders(etag),
    },
  });
};
