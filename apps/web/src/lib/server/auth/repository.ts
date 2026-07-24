// SPDX-License-Identifier: Apache-2.0
/**
 * AUTH BOUNDARY — repository reads.
 *
 * Reads that join Better Auth-owned tables with app data. Reads may use Drizzle,
 * but ONLY from here (or other files under src/lib/server/auth/). Intention-named,
 * not generic CRUD.
 */
import { eq } from "drizzle-orm";
import { getRequestEvent } from "$app/server";
import * as schema from "@doota/db/schema";

/** Minimal user fields used to validate a recovery-email token. */
export async function getUserForRecovery(
  userId: string,
): Promise<{ id: string; email: string; recoveryEmail: string | null } | null> {
  const { locals } = getRequestEvent();
  const user = await locals.db.query.user.findFirst({
    where: eq(schema.user.id, userId),
    columns: { id: true, email: true, recoveryEmail: true },
  });
  return user ?? null;
}
