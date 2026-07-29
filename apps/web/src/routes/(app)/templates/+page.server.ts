// SPDX-License-Identifier: Apache-2.0
import { redirect } from "@sveltejs/kit";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import { listTemplates } from "$lib/server/templates.js";

// Org-scoped template library. Managed by org admins (see docs open questions).
export const load = async ({ locals }) => {
  const user = locals.user;
  if (!user) redirect(302, "/login");
  const orgIds = await actorOrgAdminOf(locals.db, user.id);
  const orgId = orgIds[0] ?? null;
  const templates = orgId ? await listTemplates(locals.db, orgId) : [];
  return { orgId, templates };
};
