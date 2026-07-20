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

  // Org members — the pool that can be granted access to a shared mailbox.
  const members = await locals.db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
    })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(eq(schema.member.organizationId, params.orgId));

  // Current access grants across the org's mailboxes → drives the toggles.
  const grants = await locals.db
    .select({
      mailboxId: schema.mailboxAccess.mailboxId,
      userId: schema.mailboxAccess.userId,
      canManage: schema.mailboxAccess.canManage,
    })
    .from(schema.mailboxAccess)
    .innerJoin(schema.mailbox, eq(schema.mailbox.id, schema.mailboxAccess.mailboxId))
    .where(eq(schema.mailbox.orgId, params.orgId));

  return { mailboxes, members, grants };
};
