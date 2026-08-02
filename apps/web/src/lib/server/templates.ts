// SPDX-License-Identifier: Apache-2.0
/**
 * Hosted mail templates (docs/service-accounts.md § Templates). Org-scoped
 * library; edits create immutable versions. Rendered at send with un-jinja
 * (Jinja2-like, auto-escaping) — the SAME engine as system email
 * (src/lib/server/email/index.ts). Pure DB helpers so they're unit-testable;
 * the remote functions in rpc/template.remote.ts wrap these with auth guards.
 */
import { render } from "@ethercorps/un-jinja";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";

type Db = DrizzleD1Database<typeof schema>;

/** Per-variable metadata derived from the template's merge tags. */
export type VariableSpec = { required?: boolean; sensitive?: boolean };
export type VariablesSchema = Record<string, VariableSpec>;

/**
 * Orgs where the user manages templates by virtue of managing a **service
 * mailbox** there (a `canManage` grant on an `isService` box) — the delegated
 * path, alongside org-admins. Distinct org ids.
 */
export async function serviceMailboxManagerOrgIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ orgId: mail.mailbox.orgId })
    .from(mail.mailboxAccess)
    .innerJoin(mail.mailbox, eq(mail.mailbox.id, mail.mailboxAccess.mailboxId))
    .where(
      and(
        eq(mail.mailboxAccess.userId, userId),
        eq(mail.mailboxAccess.canManage, true),
        eq(mail.mailbox.isService, true),
      ),
    );
  return [...new Set(rows.map((row) => row.orgId))];
}

/** name → url-safe slug, the stable id the API references. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "template"
  );
}

/** The sensitive variable names for a template version (dropped from the log). */
export function sensitiveKeysOf(variablesSchema: string | null): string[] {
  if (!variablesSchema) return [];
  try {
    const schema = JSON.parse(variablesSchema) as VariablesSchema;
    return Object.entries(schema)
      .filter(([, spec]) => spec?.sensitive)
      .map(([key]) => key);
  } catch {
    return [];
  }
}

export type TemplateContent = {
  templateId: string;
  version: number;
  subjectTemplate: string;
  compiledHtml: string;
  variablesSchema: string | null;
};

/**
 * The live version of a template for sending — scoped to `orgId` so a key can
 * only render its own org's templates, and never an archived one. Null if
 * missing / archived / cross-org.
 */
export async function loadTemplateForSend(
  db: Db,
  orgId: string,
  templateId: string,
): Promise<TemplateContent | null> {
  const tmpl = await db.query.template.findFirst({
    where: and(
      eq(mail.template.id, templateId),
      eq(mail.template.orgId, orgId),
      isNull(mail.template.archivedAt),
    ),
    columns: { id: true, currentVersionId: true },
  });
  if (!tmpl?.currentVersionId) return null;
  const ver = await db.query.templateVersion.findFirst({
    where: eq(mail.templateVersion.id, tmpl.currentVersionId),
    columns: {
      version: true,
      subjectTemplate: true,
      compiledHtml: true,
      variablesSchema: true,
    },
  });
  if (!ver) return null;
  return {
    templateId: tmpl.id,
    version: ver.version,
    subjectTemplate: ver.subjectTemplate,
    compiledHtml: ver.compiledHtml,
    variablesSchema: ver.variablesSchema,
  };
}

/** Render a template's subject + html with the merge payload (auto-escaped). */
export function renderTemplate(
  tmpl: Pick<TemplateContent, "subjectTemplate" | "compiledHtml">,
  data: Record<string, unknown>,
): { subject: string; html: string } {
  return {
    subject: render(tmpl.subjectTemplate, data),
    html: render(tmpl.compiledHtml, data),
  };
}

// ---- CRUD (wrapped by the remote functions) ---------------------------------

export type TemplateInput = {
  orgId: string;
  name: string;
  subjectTemplate: string;
  compiledHtml: string;
  editorJson?: string | null;
  variablesSchema?: string | null;
  userId: string;
};

/** Create a template + its first version, and point the template at it. */
export async function createTemplate(
  db: Db,
  input: TemplateInput,
): Promise<{ id: string; slug: string }> {
  const slug = await uniqueSlug(db, input.orgId, slugify(input.name));
  const rows = await db
    .insert(mail.template)
    .values({
      orgId: input.orgId,
      name: input.name,
      slug,
      createdByUserId: input.userId,
    })
    .returning({ id: mail.template.id });
  const templateId = rows[0].id;
  await addVersion(db, templateId, input, 1);
  return { id: templateId, slug };
}

/** Append a new version to an existing template and make it live. */
export async function updateTemplate(
  db: Db,
  templateId: string,
  input: Omit<TemplateInput, "orgId" | "name"> & { name?: string },
): Promise<{ version: number }> {
  const latest = await db.query.templateVersion.findFirst({
    where: eq(mail.templateVersion.templateId, templateId),
    orderBy: desc(mail.templateVersion.version),
    columns: { version: true },
  });
  const nextVersion = (latest?.version ?? 0) + 1;
  await addVersion(db, templateId, input, nextVersion);
  if (input.name) {
    await db
      .update(mail.template)
      .set({ name: input.name })
      .where(eq(mail.template.id, templateId));
  }
  return { version: nextVersion };
}

/** Soft-archive a template (keeps versions + the send log's pinned reference). */
export async function archiveTemplate(db: Db, templateId: string): Promise<void> {
  await db
    .update(mail.template)
    .set({ archivedAt: new Date() })
    .where(eq(mail.template.id, templateId));
}

export type TemplateSummary = {
  id: string;
  name: string;
  slug: string;
  updatedAt: number;
  archived: boolean;
};

/** The org's templates, newest-updated first. */
export async function listTemplates(db: Db, orgId: string): Promise<TemplateSummary[]> {
  const rows = await db
    .select({
      id: mail.template.id,
      name: mail.template.name,
      slug: mail.template.slug,
      updatedAt: mail.template.updatedAt,
      archivedAt: mail.template.archivedAt,
    })
    .from(mail.template)
    .where(eq(mail.template.orgId, orgId))
    .orderBy(desc(mail.template.updatedAt));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    updatedAt: row.updatedAt.getTime(),
    archived: row.archivedAt != null,
  }));
}

/** One template with its current version's editable content (for the builder). */
export async function getTemplate(db: Db, orgId: string, templateId: string) {
  const tmpl = await db.query.template.findFirst({
    where: and(eq(mail.template.id, templateId), eq(mail.template.orgId, orgId)),
    columns: { id: true, name: true, slug: true, currentVersionId: true, archivedAt: true },
  });
  if (!tmpl) return null;
  const ver = tmpl.currentVersionId
    ? await db.query.templateVersion.findFirst({
        where: eq(mail.templateVersion.id, tmpl.currentVersionId),
        columns: {
          version: true,
          subjectTemplate: true,
          compiledHtml: true,
          editorJson: true,
          variablesSchema: true,
        },
      })
    : null;
  return { ...tmpl, archived: tmpl.archivedAt != null, version: ver };
}

// ---- internals --------------------------------------------------------------

async function addVersion(
  db: Db,
  templateId: string,
  input: Pick<TemplateInput, "subjectTemplate" | "compiledHtml" | "editorJson" | "variablesSchema" | "userId">,
  version: number,
): Promise<void> {
  const rows = await db
    .insert(mail.templateVersion)
    .values({
      templateId,
      version,
      subjectTemplate: input.subjectTemplate,
      compiledHtml: input.compiledHtml,
      editorJson: input.editorJson ?? null,
      variablesSchema: input.variablesSchema ?? null,
      createdByUserId: input.userId,
    })
    .returning({ id: mail.templateVersion.id });
  await db
    .update(mail.template)
    .set({ currentVersionId: rows[0].id, updatedAt: new Date() })
    .where(eq(mail.template.id, templateId));
}

/** Ensure the slug is unique within the org (append -2, -3, … on collision). */
async function uniqueSlug(db: Db, orgId: string, base: string): Promise<string> {
  for (let n = 1; n < 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const clash = await db.query.template.findFirst({
      where: and(eq(mail.template.orgId, orgId), eq(mail.template.slug, slug)),
      columns: { id: true },
    });
    if (!clash) return slug;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}
