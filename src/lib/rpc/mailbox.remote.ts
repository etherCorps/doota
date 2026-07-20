import { command, query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import * as schema from "$lib/server/db/schema.js";
import * as mail from "$lib/server/db/mail.schema.js";
import { can } from "$lib/server/can.js";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import { upsertMailbox, grantAccess, accessibleMailboxIds } from "$lib/server/mail/mailbox.js";
import { inArray } from "drizzle-orm";

/**
 * Mailbox management — shared mailboxes (support@) and access grants. Every
 * mutation is gated through the single can() chokepoint; the domain must be
 * active (a mailbox is useless until mail can flow). SvelteKit remote functions,
 * matching domains.remote.ts — no ad-hoc REST.
 */

const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

function requireUser() {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  return locals.user;
}

async function actor() {
  const { locals } = getRequestEvent();
  const user = requireUser();
  const orgAdminOf = await actorOrgAdminOf(locals.db, user.id);
  return { id: user.id, role: user.role, orgAdminOf };
}

/** Load an active org, or fail. */
async function activeOrg(orgId: string) {
  const { locals } = getRequestEvent();
  const org = await locals.db.query.organization.findFirst({
    where: eq(schema.organization.id, orgId),
    columns: { id: true, domain: true, status: true },
  });
  if (!org) error(404, "Organization not found");
  if (org.status !== "active") error(400, "This domain isn't active yet.");
  return org;
}

/** Assert the actor may manage mailboxes in `orgId`. */
async function assertManageOrg(orgId: string) {
  const a = await actor();
  if (!can(a, "manage", { type: "mailbox", ownerId: "", organizationId: orgId })) {
    error(403, "You don't manage mailboxes for this organization.");
  }
  return a;
}

export const listMailboxes = query(z.string(), async (orgId) => {
  await assertManageOrg(orgId);
  const { locals } = getRequestEvent();
  return locals.db.query.mailbox.findMany({
    where: eq(schema.mailbox.orgId, orgId),
    columns: {
      id: true,
      address: true,
      displayName: true,
      isActive: true,
      isPersonal: true,
    },
  });
});

/**
 * Mailboxes the current user can act on (personal + shared grants) — the mail
 * client's mailbox picker. User-scoped, not manage-gated: it only lists boxes
 * the user already holds an access grant on.
 */
export const myMailboxes = query(async () => {
  const user = requireUser();
  const { locals } = getRequestEvent();
  const ids = await accessibleMailboxIds(locals.db, user.id);
  if (!ids.length) return [];
  return locals.db.query.mailbox.findMany({
    where: inArray(schema.mailbox.id, ids),
    columns: { id: true, address: true, displayName: true, isActive: true, isPersonal: true },
  });
});

/** Create a shared mailbox (e.g. support@) on the org's apex domain. */
export const createSharedMailbox = command(
  z.object({
    orgId: z.string().min(1),
    localPart: z.string().trim().toLowerCase().min(1).max(64),
    displayName: z.string().trim().max(120).optional(),
  }),
  async ({ orgId, localPart, displayName }) => {
    await assertManageOrg(orgId);
    if (!LOCAL_RE.test(localPart)) {
      return { success: false as const, message: "Enter a valid mailbox name, e.g. support." };
    }
    const org = await activeOrg(orgId);
    const address = `${localPart}@${org.domain}`;
    const { locals } = getRequestEvent();
    const id = await upsertMailbox(locals.db, {
      orgId,
      address,
      displayName: displayName ?? null,
      isPersonal: false,
    });
    return { success: true as const, id, address };
  },
);

export const renameMailbox = command(
  z.object({ mailboxId: z.string().min(1), displayName: z.string().trim().max(120) }),
  async ({ mailboxId, displayName }) => {
    const { locals } = getRequestEvent();
    const box = await locals.db.query.mailbox.findFirst({
      where: eq(schema.mailbox.id, mailboxId),
      columns: { orgId: true },
    });
    if (!box) error(404, "Mailbox not found");
    await assertManageOrg(box.orgId);
    await locals.db.update(mail.mailbox).set({ displayName }).where(eq(mail.mailbox.id, mailboxId));
    return { success: true as const };
  },
);

export const deactivateMailbox = command(
  z.object({ mailboxId: z.string().min(1), active: z.boolean() }),
  async ({ mailboxId, active }) => {
    const { locals } = getRequestEvent();
    const box = await locals.db.query.mailbox.findFirst({
      where: eq(schema.mailbox.id, mailboxId),
      columns: { orgId: true, isPersonal: true },
    });
    if (!box) error(404, "Mailbox not found");
    if (box.isPersonal) error(400, "Personal mailboxes can't be deactivated here.");
    await assertManageOrg(box.orgId);
    await locals.db
      .update(mail.mailbox)
      .set({ isActive: active })
      .where(eq(mail.mailbox.id, mailboxId));
    return { success: true as const };
  },
);

export const grantMailboxAccess = command(
  z.object({
    mailboxId: z.string().min(1),
    userId: z.string().min(1),
    canManage: z.boolean().optional(),
  }),
  async ({ mailboxId, userId, canManage }) => {
    const { locals } = getRequestEvent();
    const box = await locals.db.query.mailbox.findFirst({
      where: eq(schema.mailbox.id, mailboxId),
      columns: { orgId: true },
    });
    if (!box) error(404, "Mailbox not found");
    await assertManageOrg(box.orgId);
    // The grantee must be a member of the same org.
    const membership = await locals.db.query.member.findFirst({
      where: and(
        eq(schema.member.userId, userId),
        eq(schema.member.organizationId, box.orgId),
      ),
      columns: { id: true },
    });
    if (!membership) error(400, "That user isn't a member of this organization.");
    await grantAccess(locals.db, { userId, mailboxId, canManage: canManage ?? false });
    return { success: true as const };
  },
);

export const revokeMailboxAccess = command(
  z.object({ mailboxId: z.string().min(1), userId: z.string().min(1) }),
  async ({ mailboxId, userId }) => {
    const { locals } = getRequestEvent();
    const box = await locals.db.query.mailbox.findFirst({
      where: eq(schema.mailbox.id, mailboxId),
      columns: { orgId: true, isPersonal: true },
    });
    if (!box) error(404, "Mailbox not found");
    if (box.isPersonal) error(400, "Can't revoke access to a personal mailbox.");
    await assertManageOrg(box.orgId);
    await locals.db
      .delete(mail.mailboxAccess)
      .where(
        and(
          eq(mail.mailboxAccess.mailboxId, mailboxId),
          eq(mail.mailboxAccess.userId, userId),
        ),
      );
    return { success: true as const };
  },
);
