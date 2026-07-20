import { command, query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as schema from "$lib/server/db/schema.js";
import { can } from "$lib/server/can.js";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import {
  accessibleMailboxIds,
  createRandomAlias,
  setAliasEnabled,
  deleteAlias as deleteAliasRow,
} from "$lib/server/mail/mailbox.js";

/**
 * Hide-my-email alias management. An actor may manage a mailbox's aliases if
 * they hold mailbox access (personal or shared grant) or administer the org —
 * both resolved through can(), never a parallel permission path.
 */

async function requireMailboxActor(mailboxId: string) {
  const { locals } = getRequestEvent();
  const user = locals.user;
  if (!user) error(401, "Not authenticated");

  const box = await locals.db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, mailboxId),
    columns: { id: true, orgId: true, isActive: true, isPersonal: true },
  });
  if (!box) error(404, "Mailbox not found");

  const orgAdminOf = await actorOrgAdminOf(locals.db, user.id);
  const actor = { id: user.id, role: user.role, orgAdminOf };
  const hasGrant = (await accessibleMailboxIds(locals.db, user.id)).includes(mailboxId);
  const orgManage = can(actor, "manage", {
    type: "mailbox",
    ownerId: "",
    organizationId: box.orgId,
  });
  if (!hasGrant && !orgManage) error(403, "You can't manage aliases for this mailbox.");
  return box;
}

export const listAliases = query(z.string(), async (mailboxId) => {
  await requireMailboxActor(mailboxId);
  const { locals } = getRequestEvent();
  return locals.db.query.alias.findMany({
    where: eq(schema.alias.mailboxId, mailboxId),
    columns: { id: true, address: true, label: true, isEnabled: true, lastUsedAt: true },
  });
});

/** Generate a random, collision-safe alias on the org apex, forwarding here. */
export const generateAlias = command(
  z.object({ mailboxId: z.string().min(1), label: z.string().trim().max(120).optional() }),
  async ({ mailboxId, label }) => {
    const box = await requireMailboxActor(mailboxId);
    // Hide-my-email is a PERSONAL privacy feature. A shared mailbox (support@)
    // has many senders and no single owner, so a revocable per-person forwarding
    // alias is meaningless there and would leak/confuse routing. Personal only.
    if (!box.isPersonal) {
      error(400, "Aliases are only available on personal mailboxes.");
    }
    const { locals } = getRequestEvent();
    const org = await locals.db.query.organization.findFirst({
      where: eq(schema.organization.id, box.orgId),
      columns: { domain: true, status: true },
    });
    if (org?.status !== "active") error(400, "This domain isn't active yet.");
    const alias = await createRandomAlias(locals.db, {
      orgId: box.orgId,
      mailboxId,
      host: org.domain,
      label: label ?? null,
    });
    return { success: true as const, ...alias };
  },
);

async function aliasMailboxId(aliasId: string): Promise<string> {
  const { locals } = getRequestEvent();
  const row = await locals.db.query.alias.findFirst({
    where: eq(schema.alias.id, aliasId),
    columns: { mailboxId: true },
  });
  if (!row) error(404, "Alias not found");
  return row.mailboxId;
}

export const toggleAlias = command(
  z.object({ aliasId: z.string().min(1), enabled: z.boolean() }),
  async ({ aliasId, enabled }) => {
    await requireMailboxActor(await aliasMailboxId(aliasId));
    const { locals } = getRequestEvent();
    await setAliasEnabled(locals.db, aliasId, enabled);
    return { success: true as const };
  },
);

export const deleteAlias = command(z.string().min(1), async (aliasId) => {
  await requireMailboxActor(await aliasMailboxId(aliasId));
  const { locals } = getRequestEvent();
  await deleteAliasRow(locals.db, aliasId);
  return { success: true as const };
});
