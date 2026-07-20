import { redirect } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import * as schema from "$lib/server/db/schema.js";

export const load = async ({ locals }) => {
  const user = locals.user;
  if (!user) redirect(302, "/login");

  const passkeys = await locals.db.query.passkey.findMany({
    where: eq(schema.passkey.userId, user.id),
    columns: { id: true, name: true, createdAt: true },
  });

  return {
    user: {
      name: user.name,
      image: user.image ?? null,
      email: user.email,
      role: user.role,
      twoFactorEnabled: user.twoFactorEnabled ?? false,
      recoveryEmail: user.recoveryEmail ?? null,
      recoveryEmailVerified: user.recoveryEmailVerified ?? false,
    },
    passkeys,
  };
};
