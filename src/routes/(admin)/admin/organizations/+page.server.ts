import { and, eq, inArray } from "drizzle-orm";
import * as schema from "$lib/server/db/schema.js";

// Orgs the actor owns or administers — the entry point for member management.
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
    .innerJoin(
      schema.member,
      eq(schema.member.organizationId, schema.organization.id),
    )
    .where(
      and(
        eq(schema.member.userId, user.id),
        inArray(schema.member.role, ["owner", "admin"]),
      ),
    );
  return { orgs, canCreate: user.role === "superadmin" };
};
