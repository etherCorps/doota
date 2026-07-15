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
      dkimStatus: schema.organization.dkimStatus,
      sendingStatus: schema.organization.sendingStatus,
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
  return { orgs };
};
