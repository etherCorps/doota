// SPDX-License-Identifier: Apache-2.0
import { error, redirect } from "@sveltejs/kit";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";

export const load = async ({ locals }) => {
  const user = locals.user;
  if (!user) redirect(302, "/login");
  const orgIds = await actorOrgAdminOf(locals.db, user.id);
  const orgId = orgIds[0] ?? null;
  if (!orgId) error(403, "You need to manage an organization to create templates.");
  return { orgId };
};
