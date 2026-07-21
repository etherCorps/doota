import { error, redirect } from "@sveltejs/kit";
import { loadMailboxDetail } from "@doota/mail-core/mailbox-detail";

// Detail/management view for a single shared mailbox. Access is already gated by
// the org [orgId] layout (superadmin or org-admin). Personal mailboxes have no
// management surface here — bounce back to the list.
export const load = async ({ locals, params, platform }) => {
  const detail = await loadMailboxDetail(locals.db, params.mailboxId, platform?.env?.MAIL_DEK);
  if (!detail) redirect(307, `/admin/organizations/${params.orgId}/mailboxes`);
  if (detail.orgId !== params.orgId) error(404, "Mailbox not found");
  return { mailbox: detail.mailbox, members: detail.members, grants: detail.grants, activity: detail.activity };
};
