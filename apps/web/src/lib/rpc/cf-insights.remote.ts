import { query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { can } from "@doota/db/can";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import {
  zoneEmailAnalytics,
  zoneEmailEvents,
  zoneAuditLogs,
  zoneSendUsage,
  zoneSendingReputation,
  accountSendLimits,
} from "$lib/server/cloudflare.js";

/**
 * Per-zone observability for org admins: outbound analytics, email logs, and
 * Cloudflare audit logs — all read LIVE from the Cloudflare API (cached in the
 * CF module with a short TTL to respect rate limits). The client only sends an
 * orgId; the zone is resolved server-side (never trust a client-supplied zone).
 * Manage-gated through the same can() chokepoint as the other org admin surfaces.
 */

async function orgForInsights(orgId: string) {
  const { locals } = getRequestEvent();
  const user = locals.user;
  if (!user) error(401, "Not authenticated");
  const orgAdminOf = await actorOrgAdminOf(locals.db, user.id);
  if (!can({ id: user.id, role: user.role, orgAdminOf }, "manage", { type: "mailbox", ownerId: "", organizationId: orgId })) {
    error(403, "You don't manage this organization.");
  }
  const org = await locals.db.query.organization.findFirst({
    where: eq(schema.organization.id, orgId),
    columns: { id: true, domain: true, zoneId: true },
  });
  if (!org) error(404, "Organization not found");
  return org;
}

// Range presets (days). Clamped again in the CF fetchers to the 31-day window.
const arg = z.object({ orgId: z.string().min(1), days: z.union([z.literal(1), z.literal(7), z.literal(30)]) });

export const zoneAnalytics = query(arg, async ({ orgId, days }) => {
  const org = await orgForInsights(orgId);
  if (!org.zoneId) return [];
  return zoneEmailAnalytics(org.zoneId, days);
});

export const zoneEmailLogs = query(arg, async ({ orgId, days }) => {
  const org = await orgForInsights(orgId);
  if (!org.zoneId) return [];
  return zoneEmailEvents(org.zoneId, days);
});

export const zoneAudit = query(arg, async ({ orgId, days }) => {
  const org = await orgForInsights(orgId);
  return zoneAuditLogs(org.domain, days);
});

/** Domain sending reputation (24h + 7d), the Cloudflare dashboard's widget
 * numbers — delivered vs failed vs spam-rejected, last-event-only, no NDRs. */
export const sendingReputation = query(z.string().min(1), async (orgId) => {
  const org = await orgForInsights(orgId);
  if (!org.zoneId) return null;
  return zoneSendingReputation(org.zoneId, org.domain);
});

/** This zone's sends today (per-domain context for the overview). The daily
 * LIMIT is account-wide (see accountLimits on the dashboard), not shown per-org. */
export const zoneUsage = query(z.string().min(1), async (orgId) => {
  const org = await orgForInsights(orgId);
  if (!org.zoneId) return { today: 0 };
  return zoneSendUsage(org.zoneId);
});

/** The account's live daily sending limit + usage. Superadmin only — this is the
 * operator's whole Cloudflare account. */
export const accountLimits = query(async () => {
  const { locals } = getRequestEvent();
  const user = locals.user;
  if (!user) error(401, "Not authenticated");
  if (user.role !== "superadmin") error(403, "Superadmin only.");
  return accountSendLimits();
});
