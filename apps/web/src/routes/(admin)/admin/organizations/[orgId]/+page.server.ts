// SPDX-License-Identifier: Apache-2.0
import { and, count, eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";

// Org overview — at-a-glance counts + domain status (from the layout). Access is
// gated by the [orgId] layout (superadmin / org-admin).
export const load = async ({ locals, params }) => {
  const orgId = params.orgId;
  const db = locals.db;

  const [members] = await db
    .select({ n: count() })
    .from(schema.member)
    .where(eq(schema.member.organizationId, orgId));

  const boxRows = await db
    .select({
      isPersonal: schema.mailbox.isPersonal,
      isService: schema.mailbox.isService,
      n: count(),
    })
    .from(schema.mailbox)
    .where(eq(schema.mailbox.orgId, orgId))
    .groupBy(schema.mailbox.isPersonal, schema.mailbox.isService);

  let shared = 0;
  let service = 0;
  let personal = 0;
  for (const r of boxRows) {
    if (r.isService) service += r.n;
    else if (r.isPersonal) personal += r.n;
    else shared += r.n;
  }

  const [aliases] = await db
    .select({ n: count() })
    .from(schema.alias)
    .innerJoin(schema.mailbox, eq(schema.mailbox.id, schema.alias.mailboxId))
    .where(and(eq(schema.mailbox.orgId, orgId)));

  return {
    counts: {
      members: members?.n ?? 0,
      shared,
      service,
      personal,
      aliases: aliases?.n ?? 0,
    },
  };
};
