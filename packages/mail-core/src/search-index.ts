// SPDX-License-Identifier: Apache-2.0
import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";

type Db = DrizzleD1Database<typeof schema>;

export type SearchHit = { messageId: string };

export type IndexInput = {
  messageId: string;
  /** Plaintext subject — weighted higher in ranking. */
  subject: string;
  /** Plaintext body (stripped of the quoted trail before indexing). */
  body: string;
};

export type SearchScope = {
  mailboxId: string;
  limit?: number;
};

/**
 * Full-text search over messages. One implementation ships today —
 * `PlaintextIndex` (FTS5, readable index; see search-index SQL + SECURITY docs).
 * Callers depend only on this interface, so a blind-token implementation could be
 * added later without touching them. No mode flag is wired for a mode that
 * doesn't exist — just the seam.
 */
export interface SearchIndex {
  /** Upsert a message's searchable text (idempotent per messageId). */
  index(input: IndexInput): Promise<void>;
  /**
   * Remove a message from the index. Must run in the same operation as a hard
   * purge — a readable index row must never outlive the encrypted message.
   */
  remove(messageId: string): Promise<void>;
  /** BM25-ranked message ids for a query, scoped to one mailbox, trash excluded. */
  search(query: string, scope: SearchScope): Promise<SearchHit[]>;
}

const DEFAULT_LIMIT = 50;
// bm25 column weights (UNINDEXED message_id is excluded): subject >> body.
const SUBJECT_WEIGHT = 10.0;
const BODY_WEIGHT = 1.0;

/**
 * Build a safe FTS5 MATCH expression from free user text. Every token is either
 * a quoted phrase (user used "...") or a lowercased alphanumeric bareword with a
 * trailing `*` for prefix matching. Stripping to [a-z0-9] neutralizes FTS5
 * operators/syntax (", *, :, -, (), NEAR, and stray AND/OR), so raw input can't
 * break the query or inject operators. Tokens join with a space (implicit AND).
 * Returns "" when nothing usable is left (caller returns no hits).
 */
export function buildMatch(query: string): string {
  const terms: string[] = [];
  const phraseRe = /"([^"]+)"/g;
  for (const m of query.matchAll(phraseRe)) {
    const phrase = m[1].trim().replace(/"/g, "");
    if (phrase) terms.push(`"${phrase}"`);
  }
  const rest = query.replace(phraseRe, " ");
  for (const raw of rest.toLowerCase().split(/\s+/)) {
    const word = raw.replace(/[^a-z0-9]/g, "");
    if (word.length >= 2) terms.push(`${word}*`);
  }
  return terms.join(" ");
}

/** FTS5-backed plaintext search index. Construct per request with the D1 handle. */
export function plaintextIndex(db: Db): SearchIndex {
  return {
    async index({ messageId, subject, body }) {
      // Idempotent upsert: FTS5 has no unique key, so delete-then-insert. A
      // redelivered/re-run message converges on one row.
      await db.run(sql`DELETE FROM message_search WHERE message_id = ${messageId}`);
      if (!subject && !body) return;
      await db.run(
        sql`INSERT INTO message_search (message_id, subject, body) VALUES (${messageId}, ${subject}, ${body})`,
      );
    },

    async remove(messageId) {
      await db.run(sql`DELETE FROM message_search WHERE message_id = ${messageId}`);
    },

    async search(query, scope) {
      const match = buildMatch(query);
      if (!match) return [];
      const limit = scope.limit ?? DEFAULT_LIMIT;
      const rows = await db.all<{ message_id: string }>(sql`
        SELECT f.message_id AS message_id
        FROM message_search f
        JOIN delivery d ON d.message_id = f.message_id
        JOIN message m ON m.id = f.message_id
        LEFT JOIN thread_state ts
          ON ts.thread_id = m.thread_id AND ts.mailbox_id = d.mailbox_id
        WHERE d.mailbox_id = ${scope.mailboxId}
          AND (ts.placement IS NULL OR ts.placement != 'trash')
          AND message_search MATCH ${match}
        ORDER BY bm25(message_search, ${SUBJECT_WEIGHT}, ${BODY_WEIGHT})
        LIMIT ${limit}
      `);
      const seen = new Set<string>();
      const hits: SearchHit[] = [];
      for (const row of rows) {
        if (seen.has(row.message_id)) continue;
        seen.add(row.message_id);
        hits.push({ messageId: row.message_id });
      }
      return hits;
    },
  };
}
