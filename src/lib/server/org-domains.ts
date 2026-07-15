import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import { MAIL_DOMAIN } from "$app/env/public";

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

const TTL_MS = 30_000;

let cache: Map<string, ServedOrg> | null = null;
let loadedAt = 0;

export function invalidateDomainCache() {
  cache = null;
  loadedAt = 0;
}

async function getMap(
  db: DrizzleD1Database<typeof schema>,
): Promise<Map<string, ServedOrg>> {
  const now = Date.now();
  if (cache && now - loadedAt < TTL_MS) return cache;

  const rows = await db
    .select({ id: schema.organization.id, domain: schema.organization.domain })
    .from(schema.organization);

  const map = new Map<string, ServedOrg>();
  for (const row of rows) {
    if (row.domain) map.set(row.domain.toLowerCase(), { id: row.id, domain: row.domain });
  }
  cache = map;
  loadedAt = now;
  return map;
}

/** Lowercased domain part of an email, or the input if it has no `@`. */
export function domainOf(addressOrDomain: string): string {
  const at = addressOrDomain.lastIndexOf("@");
  const domain = at === -1 ? addressOrDomain : addressOrDomain.slice(at + 1);
  return domain.trim().toLowerCase();
}

/**
 * True if the address/domain is on a domain this deployment serves — either a
 * registered org domain or the system `MAIL_DOMAIN` (the no-reply domain, which
 * must never be a valid recovery/external-login target either).
 */
export async function isServedDomain(
  db: DrizzleD1Database<typeof schema>,
  addressOrDomain: string,
): Promise<boolean> {
  const domain = domainOf(addressOrDomain);
  if (!domain) return false;
  if (domain === MAIL_DOMAIN.toLowerCase()) return true;
  return (await getMap(db)).has(domain);
}

/** The org that owns a domain, or undefined. Used for member-login routing. */
export async function orgForDomain(
  db: DrizzleD1Database<typeof schema>,
  addressOrDomain: string,
): Promise<ServedOrg | undefined> {
  return (await getMap(db)).get(domainOf(addressOrDomain));
}
