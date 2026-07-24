// SPDX-License-Identifier: Apache-2.0
import { and, desc, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { accessibleMailboxIds } from "./mailbox";

type Db = DrizzleD1Database<typeof schema>;

export type RecipientSuggestion = { address: string; name: string | null };

const TOP = Number.MAX_SAFE_INTEGER; // teammates always rank above history

/**
 * Recipient candidates — org teammates (matched on name OR email, with display
 * names) plus prior correspondents drawn from data that already exists:
 * addresses the user has sent to (submission_recipient) and addresses that have
 * written to the user's mailboxes (message.from). History is scoped to the
 * user's own for privacy.
 *
 * All filtering, de-duplication, and limiting is done in SQL — each source
 * GROUP BYs the address and ORDER BYs recency, so we transfer at most `limit`
 * rows per source instead of the user's entire mail history. A `null` prefix
 * returns the top-by-recency list (feeds the client prefetch / KV cache); a
 * prefix narrows it (the type-ahead fallback).
 */
async function gather(
  db: Db,
  userId: string,
  prefix: string | null,
  limit: number,
): Promise<RecipientSuggestion[]> {
  const p = prefix ? prefix.trim().toLowerCase() : null;
  // Ranked accumulator: address -> { name, last }. Higher `last` sorts first.
  const rank = new Map<string, { name: string | null; last: number }>();
  const keep = (address: string | null | undefined, name: string | null, last: number) => {
    const a = address?.toLowerCase();
    if (!a) return;
    const prev = rank.get(a);
    if (!prev) rank.set(a, { name, last });
    else if (last > prev.last || (name && !prev.name)) rank.set(a, { name: name ?? prev.name, last: Math.max(last, prev.last) });
  };

  // Teammates: users sharing an org, matched on name or email. Carry display names.
  const myOrgs = await db
    .select({ orgId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, userId));
  if (myOrgs.length) {
    const mates = await db
      .select({ email: schema.user.email, name: schema.user.name })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(
        and(
          inArray(schema.member.organizationId, myOrgs.map((o) => o.orgId)),
          ne(schema.member.userId, userId),
          p ? or(like(schema.user.email, `%${p}%`), like(schema.user.name, `%${p}%`)) : undefined,
        ),
      )
      .limit(limit);
    for (const m of mates) keep(m.email, m.name ?? null, TOP);
  }

  // People the user has emailed, most-recent first. GROUP BY dedups in SQL.
  const sentLast = sql<number>`max(${schema.submission.createdAt})`;
  const sent = await db
    .select({ address: schema.submissionRecipient.address, last: sentLast })
    .from(schema.submissionRecipient)
    .innerJoin(schema.submission, eq(schema.submission.id, schema.submissionRecipient.submissionId))
    .where(
      and(
        eq(schema.submission.createdByUserId, userId),
        p ? like(schema.submissionRecipient.address, `%${p}%`) : undefined,
      ),
    )
    .groupBy(schema.submissionRecipient.address)
    .orderBy(desc(sentLast))
    .limit(limit);
  for (const r of sent) keep(r.address, null, Number(r.last ?? 0));

  // People who have written to the user's mailboxes, most-recent first.
  const boxIds = await accessibleMailboxIds(db, userId);
  if (boxIds.length) {
    const recvLast = sql<number>`max(${schema.message.sentAt})`;
    const recv = await db
      .select({ address: schema.message.fromAddr, last: recvLast })
      .from(schema.delivery)
      .innerJoin(schema.message, eq(schema.message.id, schema.delivery.messageId))
      .where(
        and(
          inArray(schema.delivery.mailboxId, boxIds),
          p ? like(schema.message.fromAddr, `%${p}%`) : undefined,
        ),
      )
      .groupBy(schema.message.fromAddr)
      .orderBy(desc(recvLast))
      .limit(limit);
    for (const r of recv) keep(r.address, null, Number(r.last ?? 0));
  }

  return [...rank.entries()]
    .sort((a, b) => b[1].last - a[1].last)
    .slice(0, limit)
    .map(([address, v]) => ({ address, name: v.name }));
}

/** Type-ahead recipient autocomplete: prefix-filtered, small limit. Server fallback. */
export function suggestRecipients(
  db: Db,
  userId: string,
  prefix: string,
  limit = 8,
): Promise<RecipientSuggestion[]> {
  return gather(db, userId, prefix.trim() || null, limit);
}

/**
 * The user's top recipients by recency, no prefix. Cached (KV) and prefetched to
 * the client, which filters it locally so keystrokes don't hit the server.
 */
export function topRecipients(db: Db, userId: string, limit = 200): Promise<RecipientSuggestion[]> {
  return gather(db, userId, null, limit);
}
