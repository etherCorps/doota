// SPDX-License-Identifier: Apache-2.0
import { and, desc, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { accessibleMailboxIds, assignedOnlyMailboxIds } from "./mailbox";

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

  // Prior correspondents (sent-to + received-from), read straight off the
  // materialized `correspondent` index — a bounded scan of the user's accessible
  // mailboxes' contacts, not a GROUP BY over all mail. Scoped by access; the
  // table is maintained by recordCorrespondents() on inbound + send.
  // ponytail: assigned-only mailboxes are dropped wholesale rather than joined
  // through thread_state — suggestions lose a few addresses instead of leaking
  // correspondents from threads the member can't open.
  const restricted = new Set(await assignedOnlyMailboxIds(db, userId));
  const boxIds = (await accessibleMailboxIds(db, userId)).filter((id) => !restricted.has(id));
  if (boxIds.length) {
    const rows = await db
      .select({ address: schema.correspondent.address, name: schema.correspondent.name, last: schema.correspondent.lastSeenAt })
      .from(schema.correspondent)
      .where(
        and(
          inArray(schema.correspondent.mailboxId, boxIds),
          p ? like(schema.correspondent.address, `%${p}%`) : undefined,
        ),
      )
      .orderBy(desc(schema.correspondent.lastSeenAt))
      .limit(limit);
    for (const r of rows) keep(r.address, r.name ?? null, r.last?.getTime() ?? 0);
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

/**
 * Upsert correspondents for a mailbox — called on inbound delivery (sender →
 * recipient mailbox) and on send (each recipient → sender mailbox). Idempotent:
 * keeps the newest last_seen_at and fills a display name if we learn one.
 * Best-effort maintenance of the autocomplete index; never fail mail flow on it.
 */
export async function recordCorrespondents(
  db: Db,
  entries: { mailboxId: string; address: string | null | undefined; name?: string | null; seenAt: number | null }[],
): Promise<void> {
  const rows = entries
    .map((e) => ({
      mailboxId: e.mailboxId,
      address: e.address?.trim().toLowerCase(),
      name: e.name?.trim() || null,
      lastSeenAt: new Date(e.seenAt ?? Date.now()),
    }))
    .filter((e): e is { mailboxId: string; address: string; name: string | null; lastSeenAt: Date } => !!e.address);
  if (!rows.length) return;
  await db
    .insert(schema.correspondent)
    .values(rows)
    .onConflictDoUpdate({
      target: [schema.correspondent.mailboxId, schema.correspondent.address],
      set: {
        // Monotonic: never move recency backwards on an out-of-order write.
        lastSeenAt: sql`max(excluded.last_seen_at, ${schema.correspondent.lastSeenAt})`,
        // Prefer a freshly-seen name, else keep what we had.
        name: sql`coalesce(excluded.name, ${schema.correspondent.name})`,
      },
    });
}
