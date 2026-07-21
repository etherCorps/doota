import { redirect } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";

// Shared account context for every /account sub-page (Profile / Security / Mail /
// Developer). The tab nav + the "second factor required" gate live in the layout,
// so both need the user + passkeys here.
export const load = async ({ locals }) => {
  const user = locals.user;
  if (!user) redirect(302, "/login");

  const passkeys = await locals.db.query.passkey.findMany({
    where: eq(schema.passkey.userId, user.id),
    columns: { id: true, name: true, createdAt: true },
  });

  const createdAt = (user as { createdAt?: Date | number | string }).createdAt;

  return {
    user: {
      id: user.id,
      name: user.name,
      image: user.image ?? null,
      email: user.email,
      role: user.role ?? "member",
      twoFactorEnabled: user.twoFactorEnabled ?? false,
      recoveryEmail: user.recoveryEmail ?? null,
      recoveryEmailVerified: user.recoveryEmailVerified ?? false,
      createdAt: createdAt ? new Date(createdAt).getTime() : null,
    },
    passkeys,
  };
};
