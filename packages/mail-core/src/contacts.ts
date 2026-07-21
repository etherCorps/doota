import { eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { accessibleMailboxIds } from "./mailbox";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Recipient autocomplete (Part C) — prior correspondents, drawn from data that
 * already exists: addresses the user has sent to (submission_recipient) and
 * addresses that have written to the user's mailboxes (message.from). No
 * contacts app, no new store. Scoped to the user's own history for privacy.
 */
export async function suggestRecipients(
  db: Db,
  userId: string,
  prefix: string,
  limit = 8,
): Promise<string[]> {
  const p = prefix.trim().toLowerCase();
  const seen = new Set<string>();

  // People the user has emailed.
  const sent = await db
    .select({ address: schema.submissionRecipient.address })
    .from(schema.submissionRecipient)
    .innerJoin(schema.submission, eq(schema.submission.id, schema.submissionRecipient.submissionId))
    .where(eq(schema.submission.createdByUserId, userId));
  for (const r of sent) if (r.address) seen.add(r.address.toLowerCase());

  // People who have written to the user's mailboxes.
  const boxIds = await accessibleMailboxIds(db, userId);
  if (boxIds.length) {
    const recv = await db
      .select({ from: schema.message.fromAddr })
      .from(schema.delivery)
      .innerJoin(schema.message, eq(schema.message.id, schema.delivery.messageId))
      .where(inArray(schema.delivery.mailboxId, boxIds));
    for (const r of recv) if (r.from) seen.add(r.from.toLowerCase());
  }

  return [...seen].filter((a) => (p ? a.includes(p) : true)).slice(0, limit);
}
