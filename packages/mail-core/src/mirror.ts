import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { invalidateDomainCache } from "@doota/db/org-domains";

type Db = DrizzleD1Database<typeof schema>;

/**
 * D1 mirror of the two Cloudflare Email Routing facts the inbound hot path needs
 * but must not fetch from CF: subaddressing on/off, and the routing-subdomain
 * set. Written through by the superadmin CF commands AFTER Cloudflare confirms
 * (domains.remote.ts), so CF stays the source of truth and D1 is a read-replica.
 * Every write invalidates the org-domains cache so the resolver sees it at once.
 *
 * ponytail: reconcile-on-view — the DNS-tab load re-syncs both from CF, so a
 * direct dashboard edit self-heals. Add a poller only if that becomes common.
 */
async function upsert(
  db: Db,
  orgId: string,
  patch: { subaddressingEnabled?: boolean; routingSubdomains?: string; returnPathDomain?: string | null },
): Promise<void> {
  await db
    .insert(mail.orgMailSettings)
    .values({ orgId, ...patch })
    .onConflictDoUpdate({ target: mail.orgMailSettings.orgId, set: patch });
  invalidateDomainCache();
}

export async function mirrorSubaddressing(db: Db, orgId: string, on: boolean): Promise<void> {
  await upsert(db, orgId, { subaddressingEnabled: on });
}

/**
 * Mirror the Cloudflare Email Sending return-path (bounce) subdomain for an org.
 * Written through from domain onboarding (onboardSendingDomain result). The
 * outbound envelope + the inbound DSN-recognition both read it, so it must live
 * in D1, not be re-fetched from CF on a hot path.
 */
export async function mirrorReturnPathDomain(
  db: Db,
  orgId: string,
  returnPathDomain: string | null,
): Promise<void> {
  await upsert(db, orgId, { returnPathDomain: returnPathDomain?.trim().toLowerCase() || null });
}

/** Persist the full routing-subdomain list (full hosts) for an org. */
export async function mirrorRoutingSubdomains(
  db: Db,
  orgId: string,
  hosts: string[],
): Promise<void> {
  const clean = [...new Set(hosts.map((h) => h.trim().toLowerCase()).filter(Boolean))].sort();
  await upsert(db, orgId, { routingSubdomains: JSON.stringify(clean) });
}

/** Current mirrored routing subdomains for an org (empty if unset). */
export async function currentRoutingSubdomains(db: Db, orgId: string): Promise<string[]> {
  const row = await db.query.orgMailSettings.findFirst({
    where: eq(schema.orgMailSettings.orgId, orgId),
    columns: { routingSubdomains: true },
  });
  if (!row?.routingSubdomains) return [];
  try {
    const v = JSON.parse(row.routingSubdomains);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
