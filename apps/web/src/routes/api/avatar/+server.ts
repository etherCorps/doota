import { json, error, type RequestHandler } from "@sveltejs/kit";

/**
 * Avatar upload. Receives the already-cropped square image (multipart `file`),
 * stores it in R2 under a per-user key, and points the user's `image` at the
 * serve route via the sanctioned auth.api.updateUser (the user.update hook
 * re-asserts session/KV coherence — never a raw D1 write).
 */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB (cropped output is small)

export const POST: RequestHandler = async ({ request, locals, platform }) => {
  const user = locals.user;
  if (!user) error(401, "Not authenticated");
  const env = platform?.env;
  if (!env?.MAIL_RAW) error(500, "Storage is not configured.");

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) error(400, "file is required");
  if (file.size > MAX_AVATAR_BYTES) error(413, "Image is too large.");
  if (!file.type.startsWith("image/")) error(415, "Expected an image.");

  const key = `avatars/${user.id}`;
  await env.MAIL_RAW.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });

  // Cache-bust so the new bytes show immediately behind the stable URL.
  const image = `/api/avatar/${user.id}?v=${Date.now()}`;
  await locals.auth.api.updateUser({ body: { image }, headers: request.headers });

  return json({ image });
};
