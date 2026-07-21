import { error, redirect } from "@sveltejs/kit";
import { loadMailboxDetail, isMailboxManager } from "@doota/mail-core/mailbox-detail";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";

// Manager-facing mailbox management. Unlike the admin route, this is reachable by
// a non-admin member who holds a can_manage grant on the mailbox (org-admins and
// superadmin also pass). Authorization is per-mailbox — no org-section access.
export const load = async ({ locals, params, platform }) => {
  const user = locals.user;
  if (!user) redirect(302, "/login");

  const detail = await loadMailboxDetail(locals.db, params.mailboxId, platform?.env?.MAIL_DEK);
  if (!detail) error(404, "Mailbox not found");

  const orgAdminOf = await actorOrgAdminOf(locals.db, user.id);
  const allowed =
    user.role === "superadmin" ||
    orgAdminOf.includes(detail.orgId) ||
    (await isMailboxManager(locals.db, user.id, params.mailboxId));
  if (!allowed) error(403, "You don't manage this mailbox.");

  return {
    mailbox: detail.mailbox,
    members: detail.members,
    grants: detail.grants,
    activity: detail.activity,
  };
};
