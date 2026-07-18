import { and, eq, inArray } from "drizzle-orm";
import * as schema from "$lib/server/db/schema.js";

// Super-admin "view all orgs" is an aggregate over the orgs they OWN — resolved
// through membership (owner/admin role), NOT a non-member override.
export const load = async ({ locals }) => {
  const user = locals.user!;
  const orgs = await locals.db
    .select({
      id: schema.organization.id,
      name: schema.organization.name,
      domain: schema.organization.domain,
      membershipRole: schema.member.role,
    })
    .from(schema.organization)
    .innerJoin(schema.member, eq(schema.member.organizationId, schema.organization.id))
    .where(
      and(
        eq(schema.member.userId, user.id),
        inArray(schema.member.role, ["owner", "admin"]),
      ),
    );

  // Deferred super-admin email verify: only offer it to an unverified
  // super-admin once a domain is active (there is a real sending path).
  const isSuperadmin = user.role === "superadmin";
  let hasActiveDomain = false;
  if (isSuperadmin && !user.emailVerified) {
    const active = await locals.db.query.organization.findFirst({
      where: eq(schema.organization.status, "active"),
      columns: { id: true },
    });
    hasActiveDomain = !!active;
  }

  return {
    orgs,
    isSuperadmin,
    emailVerified: !!user.emailVerified,
    email: user.email,
    hasActiveDomain,
  };
};
