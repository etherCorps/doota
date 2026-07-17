import { eq } from "drizzle-orm";
import * as schema from "$lib/server/db/schema.js";

export const load = async ({ locals }) => {
  const user = locals.user!;
  const isSuperadmin = user.role === "superadmin";

  // The deferred email-verify action is only offered to an unverified
  // super-admin once a domain is active (there is a real sending path).
  let hasActiveDomain = false;
  if (isSuperadmin && !user.emailVerified) {
    const active = await locals.db.query.organization.findFirst({
      where: eq(schema.organization.status, "active"),
      columns: { id: true },
    });
    hasActiveDomain = !!active;
  }

  return {
    isSuperadmin,
    emailVerified: !!user.emailVerified,
    email: user.email,
    hasActiveDomain,
  };
};
