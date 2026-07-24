// SPDX-License-Identifier: Apache-2.0
import { desc, eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";

// Access + org context come from the parent layout (superadmin / org-admin).
// Mutations re-gate through can() in the suppressions remote functions.
export const load = async ({ locals, params }) => {
  const suppressions = await locals.db
    .select({
      address: schema.suppression.address,
      reason: schema.suppression.reason,
      firstSeenAt: schema.suppression.firstSeenAt,
      lastSeenAt: schema.suppression.lastSeenAt,
    })
    .from(schema.suppression)
    .where(eq(schema.suppression.orgId, params.orgId))
    .orderBy(desc(schema.suppression.lastSeenAt));

  return { suppressions };
};
