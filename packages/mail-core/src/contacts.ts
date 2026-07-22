import { eq, inArray, like, or, and, ne } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { accessibleMailboxIds } from "./mailbox";

type Db = DrizzleD1Database<typeof schema>;

export type RecipientSuggestion = { address: string; name: string | null };

/**
 * Recipient autocomplete (Part C) — org teammates (matched on name OR email,
 * with display names) first, then prior correspondents drawn from data that
 * already exists: addresses the user has sent to (submission_recipient) and
 * addresses that have written to the user's mailboxes (message.from). No
 * contacts app, no new store. History is scoped to the user's own for privacy.
 */
export async function suggestRecipients(
  db: Db,
  userId: string,
  prefix: string,
  limit = 8,
): Promise<RecipientSuggestion[]> {
  const p = prefix.trim().toLowerCase();
  const out = new Map<string, RecipientSuggestion>();

  // Teammates: users sharing an org, matched on name or email. These carry
  // display names (and their avatars resolve via /api/sender-avatar).
  const myOrgs = await db
    .select({ orgId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, userId));
  if (myOrgs.length && p) {
    const mates = await db
      .select({ email: schema.user.email, name: schema.user.name })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(
        and(
          inArray(schema.member.organizationId, myOrgs.map((o) => o.orgId)),
          ne(schema.member.userId, userId),
          or(like(schema.user.email, `%${p}%`), like(schema.user.name, `%${p}%`)),
        ),
      )
      .limit(limit);
    for (const m of mates) {
      const a = m.email.toLowerCase();
      if (!out.has(a)) out.set(a, { address: a, name: m.name ?? null });
    }
  }

  // People the user has emailed.
  const sent = await db
    .select({ address: schema.submissionRecipient.address })
    .from(schema.submissionRecipient)
    .innerJoin(schema.submission, eq(schema.submission.id, schema.submissionRecipient.submissionId))
    .where(eq(schema.submission.createdByUserId, userId));
  for (const r of sent) {
    const a = r.address?.toLowerCase();
    if (a && a.includes(p) && !out.has(a)) out.set(a, { address: a, name: null });
  }

  // People who have written to the user's mailboxes.
  const boxIds = await accessibleMailboxIds(db, userId);
  if (boxIds.length) {
    const recv = await db
      .select({ from: schema.message.fromAddr })
      .from(schema.delivery)
      .innerJoin(schema.message, eq(schema.message.id, schema.delivery.messageId))
      .where(inArray(schema.delivery.mailboxId, boxIds));
    for (const r of recv) {
      const a = r.from?.toLowerCase();
      if (a && a.includes(p) && !out.has(a)) out.set(a, { address: a, name: null });
    }
  }

  return [...out.values()].slice(0, limit);
}
