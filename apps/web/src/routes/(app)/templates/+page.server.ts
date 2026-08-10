// SPDX-License-Identifier: Apache-2.0
import { redirect } from "@sveltejs/kit";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import { listTemplates, serviceMailboxManagerOrgIds } from "$lib/server/templates.js";

// Org-scoped template library — managed by org admins or service-mailbox managers.
export const load = async ({ locals }) => {
  const user = locals.user;
  if (!user) redirect(302, "/login");
  const [admin, svc] = await Promise.all([
    actorOrgAdminOf(locals.db, user.id),
    serviceMailboxManagerOrgIds(locals.db, user.id),
  ]);
  const orgId = [...new Set([...admin, ...svc])][0] ?? null;
  const templates = orgId ? await listTemplates(locals.db, orgId) : [];
  return { orgId, templates };
};
