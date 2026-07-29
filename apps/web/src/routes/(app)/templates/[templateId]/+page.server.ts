// SPDX-License-Identifier: Apache-2.0
import { error, redirect } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import * as mail from "@doota/db/mail.schema";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import { getTemplate, serviceMailboxManagerOrgIds } from "$lib/server/templates.js";

export const load = async ({ locals, params }) => {
  const user = locals.user;
  if (!user) redirect(302, "/login");
  const row = await locals.db.query.template.findFirst({
    where: eq(mail.template.id, params.templateId),
    columns: { orgId: true },
  });
  if (!row) error(404, "Template not found");
  const [admin, svc] = await Promise.all([
    actorOrgAdminOf(locals.db, user.id),
    serviceMailboxManagerOrgIds(locals.db, user.id),
  ]);
  if (![...admin, ...svc].includes(row.orgId)) error(403, "You don't manage this template.");
  const template = await getTemplate(locals.db, row.orgId, params.templateId);
  if (!template) error(404, "Template not found");
  return { orgId: row.orgId, template };
};
