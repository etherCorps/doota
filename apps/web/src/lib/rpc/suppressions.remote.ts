// SPDX-License-Identifier: Apache-2.0
import { command, query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { can } from "@doota/db/can";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import { suppress, unsuppress } from "@doota/mail-core/bounce";

/**
 * Org suppression list management. This is the app-side list the outbound
 * consumer checks BEFORE calling Cloudflare's send endpoint, so a suppressed
 * address is dropped end-to-end. Cloudflare also keeps its own account-level
 * suppression list (auto-managed from bounces/complaints) as a backstop, but it
 * exposes no public API to read or mutate it — so this list is app-owned; there
 * is no two-way sync. Every mutation re-gates through can(), same chokepoint as
 * mailbox.remote.
 */

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

function requireUser() {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  return locals.user;
}

async function assertManageOrg(orgId: string) {
  const { locals } = getRequestEvent();
  const user = requireUser();
  const orgAdminOf = await actorOrgAdminOf(locals.db, user.id);
  const a = { id: user.id, role: user.role, orgAdminOf };
  if (!can(a, "manage", { type: "mailbox", ownerId: "", organizationId: orgId })) {
    error(403, "You don't manage this organization.");
  }
}

export const listSuppressions = query(z.string().min(1), async (orgId) => {
  await assertManageOrg(orgId);
  const { locals } = getRequestEvent();
  return locals.db
    .select({
      address: schema.suppression.address,
      reason: schema.suppression.reason,
      firstSeenAt: schema.suppression.firstSeenAt,
      lastSeenAt: schema.suppression.lastSeenAt,
    })
    .from(schema.suppression)
    .where(eq(schema.suppression.orgId, orgId))
    .orderBy(desc(schema.suppression.lastSeenAt));
});

/** Manually suppress an address (reason = manual). Idempotent upsert. */
export const addSuppression = command(
  z.object({ orgId: z.string().min(1), address: z.string().trim().toLowerCase().max(320) }),
  async ({ orgId, address }) => {
    await assertManageOrg(orgId);
    if (!EMAIL_RE.test(address)) {
      return { success: false as const, message: "Enter a valid email address." };
    }
    const { locals } = getRequestEvent();
    await suppress(locals.db, orgId, address, "manual");
    return { success: true as const };
  },
);

/** Remove an address from the suppression list (re-allow sending to it). */
export const removeSuppression = command(
  z.object({ orgId: z.string().min(1), address: z.string().trim().toLowerCase().max(320) }),
  async ({ orgId, address }) => {
    await assertManageOrg(orgId);
    const { locals } = getRequestEvent();
    const removed = await unsuppress(locals.db, orgId, address);
    if (!removed) error(404, "Not on the suppression list.");
    return { success: true as const };
  },
);
