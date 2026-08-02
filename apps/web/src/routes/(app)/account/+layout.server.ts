// SPDX-License-Identifier: Apache-2.0
import { redirect } from "@sveltejs/kit";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { cachedAccessibleMailboxIds } from "$lib/server/authz-cache.js";

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

  // Developer tab is a SERVICE-mailbox feature (programmatic send keys). Show it
  // only when the user can reach a service mailbox, or still holds a legacy key
  // they may want to revoke — hide it for personal/shared-only users.
  const accessibleIds = await cachedAccessibleMailboxIds(locals.db, user.id);
  const serviceMailbox = accessibleIds.length
    ? await locals.db.query.mailbox.findFirst({
        where: and(inArray(schema.mailbox.id, accessibleIds), eq(schema.mailbox.isService, true)),
        columns: { id: true },
      })
    : null;
  const legacyKey = await locals.db.query.apiKey.findFirst({
    where: eq(schema.apiKey.userId, user.id),
    columns: { id: true },
  });
  const canDeveloper = !!serviceMailbox || !!legacyKey;

  const createdAt = (user as { createdAt?: Date | number | string }).createdAt;

  return {
    canDeveloper,
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
