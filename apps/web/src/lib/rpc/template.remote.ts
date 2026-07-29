// SPDX-License-Identifier: Apache-2.0
import { command, query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as mail from "@doota/db/mail.schema";
import { can } from "@doota/db/can";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import {
  createTemplate,
  updateTemplate,
  archiveTemplate,
  listTemplates,
  getTemplate,
  serviceMailboxManagerOrgIds,
} from "$lib/server/templates.js";

/**
 * Hosted-template management — org-scoped library reusable by the org's service
 * accounts. Blocks are compiled to HTML in the browser (mrml/bundler); the
 * server just stores the client-supplied compiledHtml + editorJson +
 * variablesSchema. Gated to org admins OR service-mailbox managers.
 */

/** Assert the actor may manage templates in this org (org admin or svc manager). */
async function assertCanManageTemplates(orgId: string) {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  const orgAdminOf = await actorOrgAdminOf(locals.db, locals.user.id);
  const a = { id: locals.user.id, role: locals.user.role, orgAdminOf };
  if (can(a, "manage", { type: "mailbox", ownerId: "", organizationId: orgId })) {
    return locals.user;
  }
  const svcOrgs = await serviceMailboxManagerOrgIds(locals.db, locals.user.id);
  if (svcOrgs.includes(orgId)) return locals.user;
  error(403, "You don't manage templates for this organization.");
}

/** Resolve a template's org, then assert the actor manages it. Returns orgId. */
async function assertManageTemplate(templateId: string): Promise<string> {
  const { locals } = getRequestEvent();
  const row = await locals.db.query.template.findFirst({
    where: eq(mail.template.id, templateId),
    columns: { orgId: true },
  });
  if (!row) error(404, "Template not found");
  await assertCanManageTemplates(row.orgId);
  return row.orgId;
}

const contentShape = {
  subjectTemplate: z.string().max(500),
  // Compiled by the builder in the browser (mrml/bundler) — the server stores it.
  compiledHtml: z.string().max(500_000),
  // Builder block document (source of truth) + its derived variables schema.
  editorJson: z.string().max(2_000_000).optional(),
  variablesSchema: z.string().max(50_000).optional(),
};

export const listOrgTemplates = query(z.string().min(1), async (orgId) => {
  await assertCanManageTemplates(orgId);
  const { locals } = getRequestEvent();
  return listTemplates(locals.db, orgId);
});

export const getOrgTemplate = query(z.string().min(1), async (templateId) => {
  const orgId = await assertManageTemplate(templateId);
  const { locals } = getRequestEvent();
  return getTemplate(locals.db, orgId, templateId);
});

export const createOrgTemplate = command(
  z.object({ orgId: z.string().min(1), name: z.string().trim().min(1).max(120), ...contentShape }),
  async ({ orgId, name, subjectTemplate, compiledHtml, editorJson, variablesSchema }) => {
    const user = await assertCanManageTemplates(orgId);
    const { locals } = getRequestEvent();
    const res = await createTemplate(locals.db, {
      orgId,
      name,
      subjectTemplate,
      compiledHtml,
      editorJson: editorJson ?? null,
      variablesSchema: variablesSchema ?? null,
      userId: user.id,
    });
    return { success: true as const, ...res };
  },
);

export const updateOrgTemplate = command(
  z.object({ templateId: z.string().min(1), name: z.string().trim().min(1).max(120).optional(), ...contentShape }),
  async ({ templateId, name, subjectTemplate, compiledHtml, editorJson, variablesSchema }) => {
    await assertManageTemplate(templateId);
    const { locals } = getRequestEvent();
    const res = await updateTemplate(locals.db, templateId, {
      name,
      subjectTemplate,
      compiledHtml,
      editorJson: editorJson ?? null,
      variablesSchema: variablesSchema ?? null,
      userId: locals.user!.id,
    });
    return { success: true as const, ...res };
  },
);

export const archiveOrgTemplate = command(z.object({ templateId: z.string().min(1) }), async ({ templateId }) => {
  await assertManageTemplate(templateId);
  const { locals } = getRequestEvent();
  await archiveTemplate(locals.db, templateId);
  return { success: true as const };
});
