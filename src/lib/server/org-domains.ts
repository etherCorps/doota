import type { DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "./db/schema";

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

export type MailFrom = { name: string; email: string };

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
      columns: { name: true, status: true },
    });
    if (org?.status === "active") {
      return { name: org.name || "Doota", email: `${localPart}@${wanted}` };
    }
  }
  // No (or inactive) specific org — send from whichever domain is live.
  const any = await db.query.organization.findFirst({
    where: eq(schema.organization.status, "active"),
    columns: { name: true, domain: true },
  });
  if (any) return { name: any.name || "Doota", email: `${localPart}@${any.domain}` };
  return undefined;
}

/** The org that owns a domain, or undefined. Used for member-login routing. */
export async function orgForDomain(
  db: DrizzleD1Database<typeof schema>,
  addressOrDomain: string,
): Promise<ServedOrg | undefined> {
  return (await getMap(db)).get(domainOf(addressOrDomain));
}
