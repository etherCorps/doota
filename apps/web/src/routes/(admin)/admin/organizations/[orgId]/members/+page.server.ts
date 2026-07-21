import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";

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

// Access + org context come from the parent layout; here we just list members.
export const load = async ({ locals, params }) => {
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
    .where(eq(schema.member.organizationId, params.orgId));

  const members = rows.map((m) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    role: m.role,
    status: statusOf(m),
  }));
  return { members };
};
