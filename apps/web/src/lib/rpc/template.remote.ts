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
} from "$lib/server/templates.js";
import { compileTemplate, variablesSchemaJson, type BlockDoc } from "$lib/server/mjml.js";
import { render } from "@ethercorps/un-jinja";

/**
 * Hosted-template management — org-scoped library reusable by the org's service
 * accounts. Gated to org managers (admin-provisioned; see docs open questions).
 * Content authoring (raw subject/html with Jinja `{{ }}`, or the Phase-3 builder
 * JSON) flows through the pure helpers in server/templates.ts.
 */

async function assertManageOrg(orgId: string) {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  const orgAdminOf = await actorOrgAdminOf(locals.db, locals.user.id);
  const a = { id: locals.user.id, role: locals.user.role, orgAdminOf };
  if (!can(a, "manage", { type: "mailbox", ownerId: "", organizationId: orgId })) {
    error(403, "You don't manage this organization.");
  }
  return locals.user;
}

/** Resolve a template's org, then assert the actor manages it. Returns orgId. */
async function assertManageTemplate(templateId: string): Promise<string> {
  const { locals } = getRequestEvent();
  const row = await locals.db.query.template.findFirst({
    where: eq(mail.template.id, templateId),
    columns: { orgId: true },
  });
  if (!row) error(404, "Template not found");
  await assertManageOrg(row.orgId);
  return row.orgId;
}

const contentShape = {
  subjectTemplate: z.string().max(500),
  // Builder blocks (source of truth). When present, the server compiles them to
  // compiledHtml + variablesSchema (MRML). Code authors may pass compiledHtml
  // directly instead. One of the two must be supplied.
  editorJson: z.string().max(2_000_000).optional(),
  compiledHtml: z.string().max(500_000).optional(),
  variablesSchema: z.string().max(50_000).optional(),
  // Variable names to mark sensitive (redacted from the send log).
  sensitive: z.array(z.string()).max(200).optional(),
};

type Content = {
  subjectTemplate: string;
  editorJson?: string;
  compiledHtml?: string;
  variablesSchema?: string;
  sensitive?: string[];
};

/** Compile builder blocks to sendable HTML, or accept code-authored HTML as-is. */
function resolveContent(input: Content): {
  compiledHtml: string;
  editorJson: string | null;
  variablesSchema: string | null;
} {
  if (input.editorJson) {
    const doc = JSON.parse(input.editorJson) as BlockDoc;
    const compiled = compileTemplate(doc, input.subjectTemplate);
    return {
      compiledHtml: compiled.html,
      editorJson: input.editorJson,
      variablesSchema: variablesSchemaJson(compiled.variables, input.sensitive ?? []),
    };
  }
  if (!input.compiledHtml) error(400, "Provide either builder blocks or compiledHtml.");
  return {
    compiledHtml: input.compiledHtml,
    editorJson: null,
    variablesSchema: input.variablesSchema ?? null,
  };
}

export const listOrgTemplates = query(z.string().min(1), async (orgId) => {
  await assertManageOrg(orgId);
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
  async ({ orgId, name, ...content }) => {
    const user = await assertManageOrg(orgId);
    const { locals } = getRequestEvent();
    const resolved = resolveContent(content);
    const res = await createTemplate(locals.db, {
      orgId,
      name,
      subjectTemplate: content.subjectTemplate,
      compiledHtml: resolved.compiledHtml,
      editorJson: resolved.editorJson,
      variablesSchema: resolved.variablesSchema,
      userId: user.id,
    });
    return { success: true as const, ...res };
  },
);

export const updateOrgTemplate = command(
  z.object({ templateId: z.string().min(1), name: z.string().trim().min(1).max(120).optional(), ...contentShape }),
  async ({ templateId, name, ...content }) => {
    await assertManageTemplate(templateId);
    const { locals } = getRequestEvent();
    const resolved = resolveContent(content);
    const res = await updateTemplate(locals.db, templateId, {
      name,
      subjectTemplate: content.subjectTemplate,
      compiledHtml: resolved.compiledHtml,
      editorJson: resolved.editorJson,
      variablesSchema: resolved.variablesSchema,
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

/**
 * Live preview for the builder — compile blocks to HTML and (optionally) render
 * with sample data. Ephemeral: touches no stored data, so it only needs an
 * authenticated user.
 */
export const previewTemplate = command(
  z.object({
    editorJson: z.string().max(2_000_000),
    subjectTemplate: z.string().max(500).optional(),
    sampleData: z.record(z.string(), z.unknown()).optional(),
  }),
  async ({ editorJson, subjectTemplate, sampleData }) => {
    const { locals } = getRequestEvent();
    if (!locals.user) error(401, "Not authenticated");
    const doc = JSON.parse(editorJson) as BlockDoc;
    const compiled = compileTemplate(doc, subjectTemplate ?? "");
    const data = sampleData ?? {};
    return {
      subject: subjectTemplate ? render(subjectTemplate, data) : "",
      html: sampleData ? render(compiled.html, data) : compiled.html,
      variables: compiled.variables,
      warnings: compiled.warnings,
    };
  },
);
