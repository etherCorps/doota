// SPDX-License-Identifier: Apache-2.0
import { json, error, type RequestHandler } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import { svgSafetyProblem } from "$lib/server/bimi/validate.js";

/**
 * Organization branding logo (distinct from the BIMI logo). POST (superadmin or
 * an org admin) validates + stores the image in R2; GET serves it — the logo can
 * appear in email/app branding, so the read path is public. Set the org's
 * `logo` to the returned URL via the normal updateOrgProfile save.
 *
 * We serve user-supplied files from our own origin, so the upload gate is a
 * security boundary: raster passes as-is; SVG is safety-checked (no scripts /
 * handlers / external refs) and the GET adds nosniff + a deny-all CSP for SVG.
 */
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED = ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"];

async function assertOrgAdmin(locals: App.Locals, orgId: string) {
  const user = locals.user;
  if (!user) error(401, "Not authenticated");
  if (user.role !== "superadmin") {
    const adminOf = await actorOrgAdminOf(locals.db, user.id);
    if (!adminOf.includes(orgId)) error(403, "You don't manage this organization");
  }
}

export const POST: RequestHandler = async ({ request, params, locals, platform }) => {
  const orgId = params.orgId!;
  await assertOrgAdmin(locals, orgId);
  const env = platform?.env;
  if (!env?.MAIL_RAW) error(500, "Storage is not configured.");

  const org = await locals.db.query.organization.findFirst({
    where: eq(schema.organization.id, orgId),
    columns: { id: true },
  });
  if (!org) error(404, "Organization not found");

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) error(400, "file is required");
  if (file.size > MAX_LOGO_BYTES) error(413, "The logo must be 2 MB or smaller.");
  if (!ALLOWED.includes(file.type)) error(415, "Use a PNG, JPG, WEBP, GIF, or SVG image.");

  const isSvg = file.type === "image/svg+xml";
  const body = isSvg ? await file.text() : await file.arrayBuffer();
  if (isSvg) {
    const problem = svgSafetyProblem(body as string);
    if (problem) error(422, problem);
  }

  await env.MAIL_RAW.put(`org-logos/${orgId}`, body, {
    httpMetadata: { contentType: file.type },
  });

  // Absolute URL: org.logo is validated as a URL and is rendered in emails (which
  // can't use relative paths). Cache-busted so new bytes show behind the stable path.
  return json({ url: `${new URL(request.url).origin}/api/org-logo/${orgId}?v=${Date.now()}` });
};

export const GET: RequestHandler = async ({ params, platform }) => {
  const env = platform?.env;
  if (!env?.MAIL_RAW) error(500, "Storage is not configured.");

  const obj = await env.MAIL_RAW.get(`org-logos/${params.orgId}`);
  if (!obj) error(404, "No logo");

  const type = obj.httpMetadata?.contentType ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Cache-Control": "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  };
  // Origin-served SVG is safety-checked at upload; the deny-all CSP is defence in depth.
  if (type === "image/svg+xml") headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'";

  return new Response(obj.body, { headers });
};
