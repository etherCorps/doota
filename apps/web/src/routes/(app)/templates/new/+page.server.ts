// SPDX-License-Identifier: Apache-2.0
import { error, redirect } from "@sveltejs/kit";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import { serviceMailboxManagerOrgIds } from "$lib/server/templates.js";

export const load = async ({ locals }) => {
  const user = locals.user;
  if (!user) redirect(302, "/login");
  const [admin, svc] = await Promise.all([
    actorOrgAdminOf(locals.db, user.id),
    serviceMailboxManagerOrgIds(locals.db, user.id),
  ]);
  const orgId = [...new Set([...admin, ...svc])][0] ?? null;
  if (!orgId) error(403, "You need to manage an organization or service account to create templates.");
  return { orgId };
};
