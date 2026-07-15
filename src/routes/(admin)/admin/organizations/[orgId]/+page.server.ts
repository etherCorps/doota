import { error, redirect } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import * as schema from "$lib/server/db/schema.js";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";

function statusOf(u: {
  banned?: boolean | null;
  onboardedAt?: number | null;
  emailVerified?: boolean | null;
  recoveryEmailVerified?: boolean | null;
}): string {
  if (u.banned) return "paused";
  // "pending" = invite not yet accepted. Confirming the invite (verifying the
  // recovery address, or primary email for external accounts) or finishing
  // onboarding all flip the account to active.
  if (u.onboardedAt || u.recoveryEmailVerified || u.emailVerified) return "active";
  return "pending";
}

export const load = async ({ locals, params }) => {
  const actor = locals.user;
  if (!actor) redirect(302, "/login");

  const org = await locals.db.query.organization.findFirst({
    where: eq(schema.organization.id, params.orgId),
    columns: {
      id: true,
      name: true,
      domain: true,
    },
  });
  if (!org) error(404, "Organization not found");

  // superadmin sees any org; admins only those they administer.
  if (actor.role !== "superadmin") {
    const orgAdminOf = await actorOrgAdminOf(locals.db, actor.id);
    if (!orgAdminOf.includes(org.id)) error(403, "You don't manage this organization");
  }

  const rows = await locals.db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      banned: schema.user.banned,
      onboardedAt: schema.user.onboardedAt,
      emailVerified: schema.user.emailVerified,
      recoveryEmailVerified: schema.user.recoveryEmailVerified,
      role: schema.member.role,
    })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(eq(schema.member.organizationId, org.id));

  const members = rows.map((m) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    role: m.role,
    status: statusOf(m),
  }));

  return { org, members };
};
