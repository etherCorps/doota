// SPDX-License-Identifier: Apache-2.0
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "./schema";

/**
 * domain → organization map.
 *
 * One organization == one mail domain. This map is the single source of truth
 * for "which domains does this deployment serve", and drives:
 *   - inbound recipient routing (future mailbox pipeline),
 *   - login-domain validation (a member's address must be on a served domain),
 *   - rejecting recovery / external-login addresses that land on ANY served domain.
 *
 * Cached in module scope (per Worker isolate). Invalidated explicitly when an
 * org/domain is added or removed (same isolate), and bounded by a short TTL so
 * staleness self-heals across other isolates — domain changes are rare, so a
 * few seconds of cross-isolate lag is fine.
 *
 * ponytail: TTL + explicit invalidate. If cross-isolate freshness ever needs to
 * be instant, back this with a KV/DO version stamp instead.
 */
export type ServedOrg = { id: string; domain: string };

/**
 * An org's routing facts, keyed in the cache by EVERY host that routes to it —
 * the apex plus each configured routing subdomain. `subaddressing` and the
 * subdomain list are the D1 mirror of Cloudflare Email Routing (write-through
 * from domains.remote.ts); CF stays source of truth, this is the read-replica
 * the inbound hot path uses so it never calls the CF API.
 */
export type OrgRouting = {
  id: string;
  /** the apex domain (org identity) */
  domain: string;
  subaddressing: boolean;
};

const TTL_MS = 30_000;

// host (apex OR routing subdomain) → org routing facts.
let cache: Map<string, OrgRouting> | null = null;
let loadedAt = 0;

export function invalidateDomainCache() {
  cache = null;
  loadedAt = 0;
}

function parseHosts(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
}

async function getMap(
  db: DrizzleD1Database<typeof schema>,
): Promise<Map<string, OrgRouting>> {
  const now = Date.now();
  if (cache && now - loadedAt < TTL_MS) return cache;

  const rows = await db
    .select({
      id: schema.organization.id,
      domain: schema.organization.domain,
      subaddressing: schema.orgMailSettings.subaddressingEnabled,
      subdomains: schema.orgMailSettings.routingSubdomains,
    })
    .from(schema.organization)
    .leftJoin(
      schema.orgMailSettings,
      eq(schema.orgMailSettings.orgId, schema.organization.id),
    );

  const map = new Map<string, OrgRouting>();
  for (const row of rows) {
    if (!row.domain) continue;
    const org: OrgRouting = {
      id: row.id,
      domain: row.domain.toLowerCase(),
      subaddressing: !!row.subaddressing,
    };
    // Index the apex and every configured routing subdomain to the same org.
    map.set(org.domain, org);
    for (const host of parseHosts(row.subdomains)) map.set(host.toLowerCase(), org);
  }
  cache = map;
  loadedAt = now;
  return map;
}

/** Org routing facts for a host (apex or routing subdomain), or undefined. */
export async function routingForHost(
  db: DrizzleD1Database<typeof schema>,
  addressOrHost: string,
): Promise<OrgRouting | undefined> {
  return (await getMap(db)).get(domainOf(addressOrHost));
}

/** Lowercased domain part of an email, or the input if it has no `@`. */
export function domainOf(addressOrDomain: string): string {
  const at = addressOrDomain.lastIndexOf("@");
  const domain = at === -1 ? addressOrDomain : addressOrDomain.slice(at + 1);
  return domain.trim().toLowerCase();
}

/**
 * True if the address/domain is a registered org domain — i.e. one this
 * deployment serves. Such addresses must never be a valid recovery/external-login
 * target (they're internal mailboxes, not reachable external inboxes).
 */
export async function isServedDomain(
  db: DrizzleD1Database<typeof schema>,
  addressOrDomain: string,
): Promise<boolean> {
  const domain = domainOf(addressOrDomain);
  if (!domain) return false;
  return (await getMap(db)).has(domain);
}

export type MailFrom = { name: string; email: string; logo?: string | null };

/**
 * From-address for mail *about* an org. Sending must always originate from an
 * onboarded domain whose sending path is live on Cloudflare (`status ===
 * 'active'`) — a domain that isn't DKIM-wired gets marked spam or bounced.
 *
 * Resolution order:
 *   1. the requested org's own domain, if it's active;
 *   2. otherwise ANY active org domain (system/superadmin mail, or invites for
 *      an org not yet active — we still need a wired domain to send from);
 *   3. `undefined` if no domain is active yet (fresh deploy) — the caller can't
 *      send until at least one domain is onboarded.
 *
 * ponytail: `localPart` defaults to `no-reply` — no real inbox to provision.
 * Switch to a monitored mailbox once inbound routing (T3) exists.
 */
export async function senderAddress(
  db: DrizzleD1Database<typeof schema>,
  orgDomain?: string,
  localPart = "no-reply",
): Promise<MailFrom | undefined> {
  const wanted = orgDomain ? domainOf(orgDomain) : "";
  if (wanted) {
    const org = await db.query.organization.findFirst({
      where: eq(schema.organization.domain, wanted),
      columns: { name: true, status: true, logo: true },
    });
    if (org?.status === "active") {
      return { name: org.name || "Doota", email: `${localPart}@${wanted}`, logo: org.logo };
    }
  }
  // No (or inactive) specific org — send from whichever domain is live.
  const any = await db.query.organization.findFirst({
    where: eq(schema.organization.status, "active"),
    columns: { name: true, domain: true, logo: true },
  });
  if (any) return { name: any.name || "Doota", email: `${localPart}@${any.domain}`, logo: any.logo };
  return undefined;
}

/** The org that owns a domain, or undefined. Used for member-login routing. */
export async function orgForDomain(
  db: DrizzleD1Database<typeof schema>,
  addressOrDomain: string,
): Promise<ServedOrg | undefined> {
  const org = (await getMap(db)).get(domainOf(addressOrDomain));
  return org && { id: org.id, domain: org.domain };
}
