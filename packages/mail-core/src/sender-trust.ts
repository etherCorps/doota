// SPDX-License-Identifier: Apache-2.0
// Per-user "always load remote images from this sender" (Gmail/Fastmail
// pattern). Display preference only — the body route still serves images
// exclusively through the same-origin proxy; this just flips the default.

import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";

type Db = DrizzleD1Database<typeof schema>;

const norm = (addr: string) => addr.trim().toLowerCase();

// Sentinel sender that means "load remote images from EVERYONE" — a user-wide
// default that sits orthogonally to the per-sender rows (a real address can't be
// "*"). Presence of this row = auto-load all remote images.
const ALL = "*";

/** User's global "always show remote images" preference. */
export async function loadsAllRemoteImages(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: mail.senderImageTrust.id })
    .from(mail.senderImageTrust)
    .where(and(eq(mail.senderImageTrust.userId, userId), eq(mail.senderImageTrust.senderAddr, ALL)))
    .limit(1);
  return rows.length > 0;
}

export async function setLoadAllRemoteImages(db: Db, userId: string, on: boolean): Promise<void> {
  if (on) await trustSenderImages(db, userId, ALL);
  else await untrustSenderImages(db, userId, ALL);
}

/** Which of `senders` this user auto-loads images from (normalized set). */
export async function trustedSenders(db: Db, userId: string, senders: string[]): Promise<Set<string>> {
  const addrs = [...new Set(senders.filter(Boolean).map(norm))];
  if (!addrs.length) return new Set();
  const rows = await db
    .select({ senderAddr: mail.senderImageTrust.senderAddr })
    .from(mail.senderImageTrust)
    .where(and(eq(mail.senderImageTrust.userId, userId), inArray(mail.senderImageTrust.senderAddr, addrs)));
  return new Set(rows.map((r) => r.senderAddr));
}

export async function trustSenderImages(db: Db, userId: string, sender: string): Promise<void> {
  await db
    .insert(mail.senderImageTrust)
    .values({ userId, senderAddr: norm(sender) })
    .onConflictDoNothing();
}

export async function untrustSenderImages(db: Db, userId: string, sender: string): Promise<void> {
  await db
    .delete(mail.senderImageTrust)
    .where(and(eq(mail.senderImageTrust.userId, userId), eq(mail.senderImageTrust.senderAddr, norm(sender))));
}
