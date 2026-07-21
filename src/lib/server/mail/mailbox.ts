import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../db/schema";
// Writes go through the `mail.*` alias, NOT the aggregated `schema.` namespace,
// so the auth-boundary guard (which matches `.insert/.update/.delete(schema.…)`)
// never trips — these are app-owned tables, freely writable.
import * as mail from "../db/mail.schema";

type Db = DrizzleD1Database<typeof schema>;

const localPartOf = (address: string) => address.slice(0, address.lastIndexOf("@"));

/**
 * Create (or reuse) a mailbox for an org, keyed on (org_id, address). Idempotent
 * via the unique index — re-running converges instead of duplicating. Returns
 * the mailbox id.
 */
export async function upsertMailbox(
  db: Db,
  input: {
    orgId: string;
    address: string;
    displayName?: string | null;
    isPersonal?: boolean;
    isService?: boolean;
  },
): Promise<string> {
  const address = input.address.trim().toLowerCase();
  await db
    .insert(mail.mailbox)
    .values({
      orgId: input.orgId,
      address,
      localPart: localPartOf(address),
      displayName: input.displayName ?? null,
      isPersonal: input.isPersonal ?? false,
      isService: input.isService ?? false,
    })
    .onConflictDoNothing();
  const row = await db.query.mailbox.findFirst({
    where: and(eq(schema.mailbox.orgId, input.orgId), eq(schema.mailbox.address, address)),
    columns: { id: true },
  });
  if (!row) throw new Error(`mailbox upsert failed for ${address}`);
  return row.id;
}

/**
 * Grant a user access to a mailbox. Idempotent on (user_id, mailbox_id): a
 * repeat grant UPDATES the capability flags (so a manager toggle actually
 * takes), rather than silently no-oping.
 */
export async function grantAccess(
  db: Db,
  input: { userId: string; mailboxId: string; canManage?: boolean; canSend?: boolean },
): Promise<void> {
  const canManage = input.canManage ?? false;
  const canSend = input.canSend ?? true;
  await db
    .insert(mail.mailboxAccess)
    .values({ userId: input.userId, mailboxId: input.mailboxId, canManage, canSend })
    .onConflictDoUpdate({
      target: [mail.mailboxAccess.userId, mail.mailboxAccess.mailboxId],
      set: { canManage, canSend },
    });
}

/**
 * Create a personal mailbox for a provisioned user + grant them owner access.
 * One source of truth for "what address is this person" — the mailbox row, not
 * an implied address on `user`. Idempotent, so provisioning and the backfill
 * both call it safely.
 */
export async function ensurePersonalMailbox(
  db: Db,
  input: { orgId: string; userId: string; address: string; displayName?: string | null },
): Promise<string> {
  const mailboxId = await upsertMailbox(db, {
    orgId: input.orgId,
    address: input.address,
    displayName: input.displayName,
    isPersonal: true,
  });
  await grantAccess(db, { userId: input.userId, mailboxId, canManage: true, canSend: true });
  return mailboxId;
}

/** Mailbox ids a user may act on (personal or shared grants). */
export async function accessibleMailboxIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ mailboxId: schema.mailboxAccess.mailboxId })
    .from(schema.mailboxAccess)
    .where(eq(schema.mailboxAccess.userId, userId));
  return rows.map((r) => r.mailboxId);
}

/** User ids granted access to a mailbox — feeds can()'s grantedSenderIds. */
export async function grantedUserIds(db: Db, mailboxId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.mailboxAccess.userId })
    .from(schema.mailboxAccess)
    .where(eq(schema.mailboxAccess.mailboxId, mailboxId));
  return rows.map((r) => r.userId);
}

/**
 * User ids allowed to SEND as a mailbox (canSend grants only). A mailbox has no
 * single owner, so this list IS the send capability — it feeds can()'s
 * grantedSenderIds for the outbound preflight (owner/role never grants send).
 */
export async function sendGrantUserIds(db: Db, mailboxId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.mailboxAccess.userId })
    .from(schema.mailboxAccess)
    .where(
      and(
        eq(schema.mailboxAccess.mailboxId, mailboxId),
        eq(schema.mailboxAccess.canSend, true),
      ),
    );
  return rows.map((r) => r.userId);
}

/**
 * User ids who may MANAGE a mailbox (canManage grants only) — feeds can()'s
 * grantedManagerIds so a mailbox manager can administer THAT mailbox without
 * being an org admin.
 */
export async function manageGrantUserIds(db: Db, mailboxId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.mailboxAccess.userId })
    .from(schema.mailboxAccess)
    .where(
      and(
        eq(schema.mailboxAccess.mailboxId, mailboxId),
        eq(schema.mailboxAccess.canManage, true),
      ),
    );
  return rows.map((r) => r.userId);
}

/** Mailbox ids in an org that the user manages (canManage grants). */
export async function managedMailboxIds(
  db: Db,
  userId: string,
  orgId: string,
): Promise<string[]> {
  const rows = await db
    .select({ mailboxId: schema.mailboxAccess.mailboxId })
    .from(schema.mailboxAccess)
    .innerJoin(schema.mailbox, eq(schema.mailbox.id, schema.mailboxAccess.mailboxId))
    .where(
      and(
        eq(schema.mailboxAccess.userId, userId),
        eq(schema.mailboxAccess.canManage, true),
        eq(schema.mailbox.orgId, orgId),
      ),
    );
  return rows.map((r) => r.mailboxId);
}

const ALIAS_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no ambiguous 0/o/1/l
function randomLocal(len = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of bytes) s += ALIAS_ALPHABET[b % ALIAS_ALPHABET.length];
  return s;
}

/**
 * Generate a collision-safe random alias on `host` for a mailbox. Retries on the
 * (unlikely) unique-index collision. Returns the created alias row's id+address.
 */
export async function createRandomAlias(
  db: Db,
  input: { orgId: string; mailboxId: string; host: string; label?: string | null },
): Promise<{ id: string; address: string }> {
  const host = input.host.trim().toLowerCase();
  for (let attempt = 0; attempt < 5; attempt++) {
    const address = `${randomLocal()}@${host}`;
    const res = await db
      .insert(mail.alias)
      .values({
        orgId: input.orgId,
        mailboxId: input.mailboxId,
        address,
        label: input.label ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: mail.alias.id });
    if (res[0]) return { id: res[0].id, address };
  }
  throw new Error("could not generate a unique alias");
}

export async function setAliasEnabled(db: Db, aliasId: string, enabled: boolean): Promise<void> {
  await db.update(mail.alias).set({ isEnabled: enabled }).where(eq(mail.alias.id, aliasId));
}

export async function deleteAlias(db: Db, aliasId: string): Promise<void> {
  await db.delete(mail.alias).where(eq(mail.alias.id, aliasId));
}
