// SPDX-License-Identifier: Apache-2.0
import { json, error, type RequestHandler } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { svgProblem } from "$lib/server/bimi/validate";

/**
 * Self-hosted BIMI logo. POST (superadmin) validates + stores the SVG in R2;
 * GET serves it publicly — inbox providers and BIMI validators fetch the `l=`
 * URL anonymously, so the read path has no auth.
 *
 * We serve user-supplied SVG from our own origin, so the upload gate is also a
 * security boundary: no scripts, no event handlers, no external references.
 * The GET adds a deny-all CSP + nosniff as defence in depth.
 */

// BIMI guidance caps the logo well under this; 32 KB is the common ceiling.
const MAX_SVG_BYTES = 32 * 1024;

export const POST: RequestHandler = async ({ request, params, locals, platform }) => {
  const user = locals.user;
  if (!user) error(401, "Not authenticated");
  // Consistent with every other DNS/branding write: superadmin only.
  if (user.role !== "superadmin") error(403, "Super-admin only");
  const env = platform?.env;
  if (!env?.MAIL_RAW) error(500, "Storage is not configured.");

  const org = await locals.db.query.organization.findFirst({
    where: eq(schema.organization.id, params.orgId!),
    columns: { id: true },
  });
  if (!org) error(404, "Organization not found");

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) error(400, "file is required");
  if (file.size > MAX_SVG_BYTES) error(413, "The logo must be 32 KB or smaller.");

  const text = await file.text();
  const problem = svgProblem(text);
  if (problem) error(422, problem);

  await env.MAIL_RAW.put(`bimi/${org.id}.svg`, text, {
    httpMetadata: { contentType: "image/svg+xml" },
  });

  // Absolute HTTPS URL for the DNS record's l= tag. Cache-busting query params
  // would break BIMI validators that compare exact URLs, so the URL is stable;
  // the edge cache ages out within a day.
  const url = `${new URL(request.url).origin}/api/bimi/${org.id}.svg`;
  return json({ url });
};

export const GET: RequestHandler = async ({ params, platform }) => {
  const env = platform?.env;
  if (!env?.MAIL_RAW) error(500, "Storage is not configured.");

  const obj = await env.MAIL_RAW.get(`bimi/${params.orgId}.svg`);
  if (!obj) error(404, "No BIMI logo");

  return new Response(obj.body, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
      // Defence in depth for origin-served user SVG (validated at upload).
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": 'inline; filename="bimi.svg"',
    },
  });
};
