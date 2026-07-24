// SPDX-License-Identifier: Apache-2.0
import { error, type RequestHandler } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";

/**
 * Sender avatar by email address. If the address belongs to one of OUR users
 * (org members log in with their served-domain address) and they've uploaded an
 * avatar, serve it; otherwise 404 and the client falls back to a locally
 * generated DiceBear image — external addresses never leave the browser.
 * Signed-in only; the browser HTTP cache absorbs repeat list renders.
 */
export const GET: RequestHandler = async ({ params, locals, platform }) => {
  if (!locals.user) error(401, "Not authenticated");
  const env = platform?.env;
  if (!env?.MAIL_RAW) error(500, "Storage is not configured.");

  const address = decodeURIComponent(params.address ?? "").trim().toLowerCase();
  if (!address.includes("@")) error(400, "Not an address");

  const owner = await locals.db.query.user.findFirst({
    where: eq(schema.user.email, address),
    columns: { id: true, image: true },
  });
  if (!owner) error(404, "Not one of our users");

  const obj = await env.MAIL_RAW.get(`avatars/${owner.id}`);
  if (!obj) {
    // No upload — provisioning seeds user.image with a remote (DiceBear thumbs)
    // URL; redirect so internal users still show their profile image.
    if (owner.image?.startsWith("http")) {
      return new Response(null, {
        status: 302,
        headers: { Location: owner.image, "Cache-Control": "private, max-age=3600" },
      });
    }
    error(404, "No avatar uploaded");
  }

  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "image/webp",
      // 1h staleness after an avatar change is fine; keeps list scrolling cheap.
      "Cache-Control": "private, max-age=3600",
    },
  });
};
