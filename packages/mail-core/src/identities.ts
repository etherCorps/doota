import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { can } from "@doota/db/can";

type Db = DrizzleD1Database<typeof schema>;

/**
 * From-selector source (Part B) — every identity the current user may send as:
 * each mailbox they hold a SEND grant on, plus each enabled alias of those
 * mailboxes, plus whether the domain honors subaddressing (user+tag@). This is a
 * CONVENIENCE list; the send path re-checks the chosen identity through
 * resolveSender()/can() and is the authority.
 *
 * An identity whose sending domain isn't `active` (DKIM not wired) is returned
 * as unavailable WITH a reason, never silently dropped — a clear "why" beats a
 * mysteriously missing address.
 */
export type SendIdentity = {
  mailboxId: string;
  kind: "mailbox" | "alias";
  aliasId: string | null;
  address: string;
  displayName: string | null;
  /** the domain honors `+tag` subaddressing for this identity */
  subaddressable: boolean;
  available: boolean;
  reason?: string;
};

export async function listSendIdentities(db: Db, userId: string): Promise<SendIdentity[]> {
  // Mailboxes the user may SEND as (canSend grants only — owner/role never sends).
  const grants = await db
    .select({ mailboxId: schema.mailboxAccess.mailboxId })
    .from(schema.mailboxAccess)
    .where(and(eq(schema.mailboxAccess.userId, userId), eq(schema.mailboxAccess.canSend, true)));
  const mailboxIds = grants.map((g) => g.mailboxId);
  if (!mailboxIds.length) return [];

  const boxes = await db.query.mailbox.findMany({
    where: inArray(schema.mailbox.id, mailboxIds),
    columns: { id: true, orgId: true, address: true, displayName: true, isActive: true },
  });

  const orgIds = [...new Set(boxes.map((b) => b.orgId))];
  const orgs = await db.query.organization.findMany({
    where: inArray(schema.organization.id, orgIds),
    columns: { id: true, status: true },
  });
  const orgStatus = new Map(orgs.map((o) => [o.id, o.status]));
  const settings = await db.query.orgMailSettings.findMany({
    where: inArray(schema.orgMailSettings.orgId, orgIds),
    columns: { orgId: true, subaddressingEnabled: true },
  });
  const subaddr = new Map(settings.map((s) => [s.orgId, s.subaddressingEnabled]));

  const aliases = await db.query.alias.findMany({
    where: and(inArray(schema.alias.mailboxId, mailboxIds), eq(schema.alias.isEnabled, true)),
    columns: { id: true, mailboxId: true, address: true, label: true },
  });

  function availability(box: { orgId: string; isActive: boolean }): { available: boolean; reason?: string } {
    if (!box.isActive) return { available: false, reason: "This mailbox is inactive." };
    if (orgStatus.get(box.orgId) !== "active") {
      return { available: false, reason: "This domain isn't active yet (email sending not wired)." };
    }
    return { available: true };
  }

  const out: SendIdentity[] = [];
  for (const box of boxes) {
    // Defensive: only surface identities can() actually permits to send.
    const allowed = can(
      { id: userId },
      "send",
      { type: "mailbox", ownerId: "", organizationId: box.orgId, grantedSenderIds: [userId] },
    );
    if (!allowed) continue;

    const canSubaddress = subaddr.get(box.orgId) ?? false;
    const avail = availability(box);
    out.push({
      mailboxId: box.id,
      kind: "mailbox",
      aliasId: null,
      address: box.address,
      displayName: box.displayName,
      subaddressable: canSubaddress,
      ...avail,
    });
    for (const al of aliases.filter((a) => a.mailboxId === box.id)) {
      out.push({
        mailboxId: box.id,
        kind: "alias",
        aliasId: al.id,
        address: al.address,
        displayName: al.label,
        // Aliases are the hide-my-email surface; subaddressing on top would leak.
        subaddressable: false,
        ...avail,
      });
    }
  }
  return out;
}
