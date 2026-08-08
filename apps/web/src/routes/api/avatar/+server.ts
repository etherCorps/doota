// SPDX-License-Identifier: Apache-2.0
import { json, error, type RequestHandler } from "@sveltejs/kit";
import { svgSafetyProblem } from "$lib/server/bimi/validate.js";

/**
 * Avatar upload. Receives the already-cropped square image (multipart `file`),
 * stores it in R2 under a per-user key, and points the user's `image` at the
 * serve route via the sanctioned auth.api.updateUser (the user.update hook
 * re-asserts session/KV coherence — never a raw D1 write).
 *
 * We serve user-supplied files from our own origin, so the upload gate is a
 * security boundary: raster passes as-is; SVG is safety-checked (no scripts /
 * handlers / external refs) and the GET adds nosniff + a deny-all CSP for SVG.
 */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB (cropped output is small)
const ALLOWED = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];

export const POST: RequestHandler = async ({ request, locals, platform }) => {
  const user = locals.user;
  if (!user) error(401, "Not authenticated");
  const env = platform?.env;
  if (!env?.MAIL_RAW) error(500, "Storage is not configured.");

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) error(400, "file is required");
  if (file.size > MAX_AVATAR_BYTES) error(413, "Image is too large.");
  if (!ALLOWED.includes(file.type)) error(415, "Use a PNG, JPG, WEBP, GIF, or SVG image.");

  // SVG is active content, so it's only allowed after a safety check (no scripts,
  // event handlers, or external references). Raster is stored as-is.
  const isSvg = file.type === "image/svg+xml";
  const body = isSvg ? await file.text() : await file.arrayBuffer();
  if (isSvg) {
    const problem = svgSafetyProblem(body as string);
    if (problem) error(422, problem);
  }

  const key = `avatars/${user.id}`;
  await env.MAIL_RAW.put(key, body, {
    httpMetadata: { contentType: file.type },
  });

  // Cache-bust so the new bytes show immediately behind the stable URL.
  const image = `/api/avatar/${user.id}?v=${Date.now()}`;
  await locals.auth.api.updateUser({ body: { image }, headers: request.headers });

  return json({ image });
};
