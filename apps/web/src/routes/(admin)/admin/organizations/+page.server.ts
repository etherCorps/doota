import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "@doota/db/schema";

// Organizations == mail domains. Superadmins see every org (they onboard them);
// admins/owners see only the ones they manage. This is the entry point for both
// onboarding a new domain and managing an existing org's members/DNS/settings.
export const load = async ({ locals }) => {
  const user = locals.user!;
  const isSuper = user.role === "superadmin";

  const base = locals.db
    .select({
      id: schema.organization.id,
      name: schema.organization.name,
      domain: schema.organization.domain,
      logo: schema.organization.logo,
      status: schema.organization.status,
      membershipRole: schema.member.role,
      members: sql<number>`count(distinct ${schema.member.userId})`,
    })
    .from(schema.organization)
    .leftJoin(
      schema.member,
      eq(schema.member.organizationId, schema.organization.id),
    )
    .groupBy(schema.organization.id);

  const orgs = isSuper
    ? await base
    : await base.where(
        and(
          eq(schema.member.userId, user.id),
          inArray(schema.member.role, ["owner", "admin"]),
        ),
      );

  return { orgs, canCreate: isSuper };
};
