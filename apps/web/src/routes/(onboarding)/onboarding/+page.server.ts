import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";

export const load = async ({ locals }) => {
  const user = locals.user!;
  const passkeys = await locals.db.query.passkey.findMany({
    where: eq(schema.passkey.userId, user.id),
    columns: { id: true, name: true },
  });
  return {
    passkeys,
    account: {
      email: user.email,
      twoFactorEnabled: user.twoFactorEnabled ?? false,
      recoveryEmail: user.recoveryEmail ?? null,
      recoveryEmailVerified: user.recoveryEmailVerified ?? false,
    },
  };
};
