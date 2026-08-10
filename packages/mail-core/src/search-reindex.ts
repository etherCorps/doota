// SPDX-License-Identifier: Apache-2.0
import { and, asc, eq, gt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { decryptContent, type ContentKey } from "./crypto";
import { plaintextIndex } from "./search-index";

type Db = DrizzleD1Database<typeof schema>;

export type ReindexResult = {
  /** Messages processed in this batch. */
  processed: number;
  /** Last message id indexed — pass as `cursor` to continue; null when empty. */
  nextCursor: string | null;
  /** True when this batch was the tail (fewer than `limit` rows). */
  done: boolean;
};

/**
 * One-time search reindex: repopulate `message_search` from the encrypted D1
 * columns. Needed after the Porter migration (0055) DROPs the table, and to
 * backfill mail ingested before the plaintext index existed.
 *
 * Cursor = the last message id processed; the caller re-invokes with
 * `nextCursor` until `done`. Ordering by message id (a monotonic ULID-ish PK)
 * makes paging stable and gap-free.
 *
 * Honors `mailbox.searchIndexed`: a message is indexed iff it has >=1 delivery
 * to a search-indexed mailbox — the same rule ingest applies. Decrypts subject +
 * stripped body per message (D1 columns only, never R2). Idempotent:
 * `index()` upserts, so a re-run or overlap converges.
 *
 * ponytail: single-batch by design; the superadmin command loops it. Scale path
 * if a box ever holds millions of messages: drive it from a queue like
 * rules-backfill instead of a synchronous loop.
 */
export async function reindexMessages(
  db: Db,
  ck: ContentKey,
  opts: { cursor?: string; limit?: number } = {},
): Promise<ReindexResult> {
  const limit = opts.limit ?? 200;
  const cursor = opts.cursor ?? "";

  const rows = await db
    .selectDistinct({
      id: mail.message.id,
      subjectEnc: mail.message.subjectEnc,
      bodyStrippedEnc: mail.message.bodyStrippedEnc,
      bodyFullEnc: mail.message.bodyFullEnc,
    })
    .from(mail.message)
    .innerJoin(mail.delivery, eq(mail.delivery.messageId, mail.message.id))
    .innerJoin(mail.mailbox, eq(mail.mailbox.id, mail.delivery.mailboxId))
    .where(and(eq(mail.mailbox.searchIndexed, true), gt(mail.message.id, cursor)))
    .orderBy(asc(mail.message.id))
    .limit(limit);

  const idx = plaintextIndex(db);
  for (const row of rows) {
    const subject = (await decryptContent(ck, row.subjectEnc)) ?? "";
    const body =
      (await decryptContent(ck, row.bodyStrippedEnc)) ??
      (await decryptContent(ck, row.bodyFullEnc)) ??
      "";
    await idx.index({ messageId: row.id, subject, body });
  }

  return {
    processed: rows.length,
    nextCursor: rows.length ? rows[rows.length - 1].id : null,
    done: rows.length < limit,
  };
}
