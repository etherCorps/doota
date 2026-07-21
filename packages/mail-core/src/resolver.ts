import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { domainOf, routingForHost } from "@doota/db/org-domains";
import { sendGrantUserIds } from "./mailbox";
import { error } from "@sveltejs/kit";
import { can } from "@doota/db/can";

type Db = DrizzleD1Database<typeof schema>;

/**
 * A deliverable recipient, resolved entirely from D1 (never the Cloudflare API).
 * Used by BOTH the inbound worker hot path and app code, so there is exactly one
 * definition of "who does this address deliver to".
 */
export type ResolvedRecipient = {
  orgId: string;
  mailboxId: string;
  /** set when delivery came through a hide-my-email alias */
  viaAliasId: string | null;
  /** the `+tag` stripped from a subaddress, when the domain honors subaddressing */
  subaddressTag: string | null;
};

/** Split an address into local part + host (both lowercased). */
function splitAddress(address: string): { local: string; host: string } | null {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return {
    local: address.slice(0, at).trim().toLowerCase(),
    host: address.slice(at + 1).trim().toLowerCase(),
  };
}

/**
 * Resolve an inbound recipient to a mailbox, or null if not deliverable.
 *
 *   1. Match the host against the org's apex OR a configured routing subdomain
 *      (via the org-domains cache — no CF call).
 *   2. If subaddressing is enabled for that domain, strip `+tag` and resolve the
 *      base address, carrying the tag through to the delivery row.
 *   3. Resolve to an ACTIVE mailbox, else an ENABLED alias (→ its active mailbox).
 *   4. Unknown / disabled / inactive → null (the worker bounces).
 *
 * Domain facts are cached (they change rarely). The mailbox/alias lookup is a
 * FRESH indexed D1 read, never cached — a just-disabled alias must reject on the
 * next message, so correctness beats caching here.
 */
export async function resolveRecipient(
  db: Db,
  recipient: string,
): Promise<ResolvedRecipient | null> {
  const parts = splitAddress(recipient);
  if (!parts) return null;
  const { local, host } = parts;

  const org = await routingForHost(db, host);
  if (!org) return null;

  let baseLocal = local;
  let subaddressTag: string | null = null;
  if (org.subaddressing) {
    const plus = local.indexOf("+");
    if (plus !== -1) {
      baseLocal = local.slice(0, plus);
      subaddressTag = local.slice(plus + 1) || null;
    }
  }
  const baseAddress = `${baseLocal}@${host}`;

  // Direct mailbox hit (active only).
  const box = await db.query.mailbox.findFirst({
    where: and(
      eq(schema.mailbox.orgId, org.id),
      eq(schema.mailbox.address, baseAddress),
    ),
    columns: { id: true, isActive: true },
  });
  if (box?.isActive) {
    return { orgId: org.id, mailboxId: box.id, viaAliasId: null, subaddressTag };
  }
  // If a mailbox row exists but is inactive, it's not deliverable — stop (an
  // alias on the same address would be ambiguous; addresses are unique per org).
  if (box) return null;

  // Alias hit (enabled only) → its mailbox (must be active).
  const al = await db.query.alias.findFirst({
    where: and(
      eq(schema.alias.orgId, org.id),
      eq(schema.alias.address, baseAddress),
    ),
    columns: { id: true, isEnabled: true, mailboxId: true },
  });
  if (!al?.isEnabled) return null;

  const target = await db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, al.mailboxId),
    columns: { id: true, isActive: true },
  });
  if (!target?.isActive) return null;

  return {
    orgId: org.id,
    mailboxId: target.id,
    viaAliasId: al.id,
    subaddressTag,
  };
}

/**
 * Resolve the from-address for a mailbox (its own address, or an owned+enabled
 * alias) and assert the user may SEND as it. Shared by both trigger surfaces.
 */
export async function resolveSender(
  db: import("drizzle-orm/d1").DrizzleD1Database<typeof schema>,
  userId: string,
  mailboxId: string,
  fromAliasId?: string | null,
): Promise<{ orgId: string; fromAddress: string; fromName: string | null; fromAliasId: string | null }> {
  const box = await db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, mailboxId),
    columns: { id: true, orgId: true, address: true, displayName: true, isActive: true },
  });
  if (!box) error(404, "Mailbox not found");
  if (!box.isActive) error(409, "Mailbox is not active");

  const grantedSenderIds = await sendGrantUserIds(db, mailboxId);
  const allowed = can(
    { id: userId },
    "send",
    { type: "mailbox", ownerId: "", organizationId: box.orgId, grantedSenderIds },
  );
  if (!allowed) error(403, "You can't send as this mailbox.");

  let fromAddress = box.address;
  let resolvedAliasId: string | null = null;
  if (fromAliasId) {
    const al = await db.query.alias.findFirst({
      where: eq(schema.alias.id, fromAliasId),
      columns: { address: true, mailboxId: true, isEnabled: true },
    });
    if (!al || al.mailboxId !== mailboxId || !al.isEnabled) error(409, "Alias unavailable for this mailbox");
    fromAddress = al.address;
    resolvedAliasId = fromAliasId;
  }
  return { orgId: box.orgId, fromAddress, fromName: box.displayName, fromAliasId: resolvedAliasId };
}

/**
 * Resolve the from-address for a SERVICE-key send. The key itself is the
 * authorization (issued by an org admin against a service mailbox), so no
 * per-user grant is consulted — but the target MUST be an active service mailbox.
 */
export async function resolveServiceSender(
  db: import("drizzle-orm/d1").DrizzleD1Database<typeof schema>,
  mailboxId: string,
  fromAliasId?: string | null,
): Promise<{ orgId: string; fromAddress: string; fromName: string | null; fromAliasId: string | null }> {
  const box = await db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, mailboxId),
    columns: { id: true, orgId: true, address: true, displayName: true, isActive: true, isService: true },
  });
  if (!box) error(404, "Mailbox not found");
  if (!box.isService) error(403, "This key can only send as its service mailbox.");
  if (!box.isActive) error(409, "Mailbox is not active");

  let fromAddress = box.address;
  let resolvedAliasId: string | null = null;
  if (fromAliasId) {
    const al = await db.query.alias.findFirst({
      where: eq(schema.alias.id, fromAliasId),
      columns: { address: true, mailboxId: true, isEnabled: true },
    });
    if (!al || al.mailboxId !== mailboxId || !al.isEnabled) error(409, "Alias unavailable for this mailbox");
    fromAddress = al.address;
    resolvedAliasId = fromAliasId;
  }
  return { orgId: box.orgId, fromAddress, fromName: box.displayName, fromAliasId: resolvedAliasId };
}

/** Convenience for callers that only have an address string. */
export { domainOf };
