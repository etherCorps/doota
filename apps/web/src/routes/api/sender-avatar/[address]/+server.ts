// SPDX-License-Identifier: Apache-2.0
import { error, type RequestHandler } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";

/**
 * Sender avatar by email address. If the address belongs to one of our users
 * (org members log in with their served-domain address) and they've uploaded an
 * avatar, serve it; otherwise 404 and the client falls back to a locally
 * generated DiceBear image — external addresses never leave the browser.
 * Signed-in only; the browser HTTP cache absorbs repeat list renders.
 */

// Avatars change rarely — cache a day so a scrolling list (and repeat visits)
// don't re-query the DB + R2 per sender. The negative ("not our user" / no
// upload) is cached two days so external senders — the bulk of a mailbox — stop
// re-requesting a 404 on every reload before falling back to local DiceBear.
const HIT = "private, max-age=86400";
const MISS = "private, max-age=172800";
const notOurUser = () =>
  new Response(null, { status: 404, headers: { "Cache-Control": MISS } });

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
  if (!owner) return notOurUser();

  const obj = await env.MAIL_RAW.get(`avatars/${owner.id}`);
  if (!obj) {
    // No upload — provisioning seeds user.image with a remote (DiceBear thumbs)
    // URL; redirect so internal users still show their profile image.
    if (owner.image?.startsWith("http")) {
      return new Response(null, {
        status: 302,
        headers: { Location: owner.image, "Cache-Control": HIT },
      });
    }
    return notOurUser();
  }

  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "image/webp",
      "Cache-Control": HIT,
    },
  });
};
