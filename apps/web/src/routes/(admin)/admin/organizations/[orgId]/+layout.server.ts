import { error, redirect } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import * as schema from "$lib/server/db/schema.js";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import { addressHosts } from "$lib/server/mail/mailbox.js";

// Shared org context + access gate for every org sub-route (DNS / members /
// settings). Children inherit `org` via merged layout data.
export const load = async ({ locals, params }) => {
  const actor = locals.user;
  if (!actor) redirect(302, "/login");

  const org = await locals.db.query.organization.findFirst({
    where: eq(schema.organization.id, params.orgId),
    columns: {
      id: true,
      name: true,
      domain: true,
      logo: true,
      zoneId: true,
      status: true,
    },
  });
  if (!org) error(404, "Organization not found");

  // superadmin sees any org; admins only those they administer.
  if (actor.role !== "superadmin") {
    const orgAdminOf = await actorOrgAdminOf(locals.db, actor.id);
    if (!orgAdminOf.includes(org.id)) error(403, "You don't manage this organization");
  }

  // Hosts a new address may sit on (apex + routing subdomains) — offered in the
  // add-user / add-mailbox pickers so addresses can live on a subdomain.
  const mailHosts = await addressHosts(locals.db, org.id, org.domain);

  return { org, mailHosts };
};
