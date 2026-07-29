// SPDX-License-Identifier: Apache-2.0
import { error, type RequestHandler } from "@sveltejs/kit";

/**
 * Public template image serve. No auth — email images are fetched by the
 * recipient's client with no session. Only serves keys under the `tpl/` prefix
 * we wrote (segments validated), so it can't read arbitrary R2 objects.
 * Immutable, long-cached (the id is a fresh UUID per upload).
 */
const SEG = /^[a-zA-Z0-9-]{1,64}$/;

export const GET: RequestHandler = async ({ params, platform }) => {
  const env = platform?.env;
  if (!env?.MAIL_RAW) error(500, "Storage is not configured.");
  const { orgId, id } = params;
  if (!orgId || !id || !SEG.test(orgId) || !SEG.test(id)) error(404, "Not found");

  const obj = await env.MAIL_RAW.get(`tpl/${orgId}/${id}`);
  if (!obj) error(404, "Not found");

  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
};
