// SPDX-License-Identifier: Apache-2.0
import { error, type RequestHandler } from "@sveltejs/kit";

/** Serve a user's uploaded avatar from R2. Any signed-in user may view avatars. */
export const GET: RequestHandler = async ({ params, locals, platform }) => {
  if (!locals.user) error(401, "Not authenticated");
  const env = platform?.env;
  if (!env?.MAIL_RAW) error(500, "Storage is not configured.");

  const obj = await env.MAIL_RAW.get(`avatars/${params.userId}`);
  if (!obj) error(404, "No avatar");

  const type = obj.httpMetadata?.contentType ?? "image/webp";
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Cache-Control": "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  };
  // Origin-served SVG is safety-checked at upload; the deny-all CSP is defence in depth.
  if (type === "image/svg+xml") headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'";

  return new Response(obj.body, { headers });
};
