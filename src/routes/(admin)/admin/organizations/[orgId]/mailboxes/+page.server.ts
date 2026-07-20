import { eq } from "drizzle-orm";
import * as schema from "$lib/server/db/schema.js";

// Access + org context come from the parent layout (superadmin / org-admin).
// Mutations re-gate through can() in the mailbox remote functions.
export const load = async ({ locals, params }) => {
  const mailboxes = await locals.db
    .select({
      id: schema.mailbox.id,
      address: schema.mailbox.address,
      displayName: schema.mailbox.displayName,
      isActive: schema.mailbox.isActive,
      isPersonal: schema.mailbox.isPersonal,
    })
    .from(schema.mailbox)
    .where(eq(schema.mailbox.orgId, params.orgId))
    .orderBy(schema.mailbox.address);

  return { mailboxes };
};
