import { error, type RequestHandler } from "@sveltejs/kit";

/** Serve a user's uploaded avatar from R2. Any signed-in user may view avatars. */
export const GET: RequestHandler = async ({ params, locals, platform }) => {
  if (!locals.user) error(401, "Not authenticated");
  const env = platform?.env;
  if (!env?.MAIL_RAW) error(500, "Storage is not configured.");

  const obj = await env.MAIL_RAW.get(`avatars/${params.userId}`);
  if (!obj) error(404, "No avatar");

  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "image/webp",
      "Cache-Control": "private, max-age=86400",
    },
  });
};
