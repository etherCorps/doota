// SPDX-License-Identifier: Apache-2.0
import { and, eq, like, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Spam classifier (build guide, Phase 5), tiers 1+2. Tier 3 (per-org blinded
 * Bayes) is a follow-up; the minimum viable ship is lists + tier 1 + tier 2.
 *
 * Precedence, most-explicit first:
 *   1. allow-list  → ham (user said so)
 *   2. block-list  → spam (user said so)
 *   3. tier 2 — correspondent reputation, ham-only. Hard constraint: "never
 *      seen this sender" is strictly neutral, never a spam signal. A support
 *      inbox receives most legitimate mail from strangers, so weighting
 *      unfamiliarity toward spam would junk real customers on exactly the
 *      mailboxes this product is for. Encoded structurally: tier 2 can only
 *      return ham or fall through.
 *   4. tier 1 — upstream auth verdicts (CF Authentication-Results). Spam only
 *      on an explicit dmarc=fail; absence of auth results is neutral (false
 *      positives cost far more than false negatives — a lost invoice is worse
 *      than a visible spam).
 *   5. default ham.
 */

export type SpamVerdict =
  | { spam: false; reason: "allow_list" | "replied" | "domain_replied" | "known_sender" | "default" }
  | { spam: true; reason: "block_list" | "dmarc_fail" };

export async function classifyInbound(
  db: Db,
  input: {
    mailboxId: string;
    fromAddress: string | null;
    dmarcPass: boolean;
    authResults?: string | null;
  },
): Promise<SpamVerdict> {
  const address = input.fromAddress?.trim().toLowerCase() ?? null;
  const domain = address?.includes("@") ? address.slice(address.indexOf("@")) : null;

  if (address) {
    const listed = await db.query.mailboxSenderList.findFirst({
      where: and(
        eq(schema.mailboxSenderList.mailboxId, input.mailboxId),
        or(
          eq(schema.mailboxSenderList.address, address),
          domain ? eq(schema.mailboxSenderList.address, domain) : undefined,
        ),
      ),
    });
    if (listed?.kind === "allow") return { spam: false, reason: "allow_list" };
    if (listed?.kind === "block") return { spam: true, reason: "block_list" };

    // Tier 2 — correspondent table as reputation oracle. One indexed lookup
    // per signal, strongest first.
    const row = await db.query.correspondent.findFirst({
      where: and(
        eq(schema.correspondent.mailboxId, input.mailboxId),
        eq(schema.correspondent.address, address),
      ),
      columns: { lastRepliedAt: true, messageCount: true },
    });
    if (row?.lastRepliedAt) return { spam: false, reason: "replied" };
    if (domain) {
      const domainReplied = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.correspondent)
        .where(
          and(
            eq(schema.correspondent.mailboxId, input.mailboxId),
            like(schema.correspondent.address, `%${domain}`),
            sql`${schema.correspondent.lastRepliedAt} is not null`,
          ),
        );
      if ((domainReplied[0]?.n ?? 0) > 0) return { spam: false, reason: "domain_replied" };
    }
    if ((row?.messageCount ?? 0) > 0) return { spam: false, reason: "known_sender" };
    // No row → neutral. Falls through to tier 1; unfamiliarity is never spam.
  }

  // Tier 1: explicit aligned-DMARC failure from the upstream validator.
  if (!input.dmarcPass && input.authResults && /\bdmarc=fail\b/i.test(input.authResults)) {
    return { spam: true, reason: "dmarc_fail" };
  }
  return { spam: false, reason: "default" };
}

/** Add (idempotently) a sender-list entry — `address` may be "@domain". */
export async function addSenderListEntry(
  db: Db,
  input: { mailboxId: string; address: string; kind: "allow" | "block" },
): Promise<void> {
  const address = input.address.trim().toLowerCase();
  if (!address) return;
  await db
    .insert(mail.mailboxSenderList)
    .values({ mailboxId: input.mailboxId, address, kind: input.kind })
    .onConflictDoUpdate({
      target: [mail.mailboxSenderList.mailboxId, mail.mailboxSenderList.address],
      set: { kind: input.kind },
    });
}

export async function removeSenderListEntry(
  db: Db,
  input: { mailboxId: string; address: string },
): Promise<void> {
  await db
    .delete(mail.mailboxSenderList)
    .where(
      and(
        eq(mail.mailboxSenderList.mailboxId, input.mailboxId),
        eq(mail.mailboxSenderList.address, input.address.trim().toLowerCase()),
      ),
    );
}

/**
 * Junk retention (daily cron): hide (never delete) spam threads whose last
 * activity is past the window. Same semantics as "empty spam" (hidden_at);
 * messages, R2 content, and other mailboxes' state stay untouched.
 */
export const JUNK_RETENTION_DAYS = 30;
export async function sweepJunk(db: Db, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - JUNK_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const hidden = await db
    .update(mail.threadState)
    .set({ hiddenAt: new Date(now) })
    .where(
      and(
        eq(mail.threadState.placement, "spam"),
        sql`${mail.threadState.hiddenAt} is null`,
        sql`${mail.threadState.lastActivityAt} < ${cutoff.getTime()}`,
      ),
    )
    .returning({ id: mail.threadState.id });
  return hidden.length;
}

/** Latest sender address of a thread — the un-junk implicit-allow target. */
export async function latestSenderOf(db: Db, threadId: string): Promise<string | null> {
  const row = await db.query.message.findFirst({
    where: eq(schema.message.threadId, threadId),
    orderBy: (message, { desc }) => desc(message.sentAt),
    columns: { fromAddr: true },
  });
  return row?.fromAddr?.toLowerCase() ?? null;
}
