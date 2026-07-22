import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { b64ToBytes } from "./crypto";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Blind-token search. Each content word is turned into an HMAC token with a
 * SEARCH_KEY that NEVER touches D1, so the FTS5 index (message_fts) reveals
 * nothing about the plaintext. Search hashes the query words the same way and
 * matches tokens — exact word AND/OR only (no prefix/fuzzy on blind tokens).
 *
 * Results are message ids; callers scope to a mailbox via a deliveries join
 * (the index itself is org-wide). SEARCH_KEY is an instance secret, distinct
 * from the content DEK (crypto.ts).
 */

const WORD_RE = /[a-z0-9]+/g;

/** Normalize text → unique lowercase word set, dropping 1-char noise. */
export function words(text: string | null | undefined): string[] {
  if (!text) return [];
  const set = new Set<string>();
  for (const m of text.toLowerCase().matchAll(WORD_RE)) {
    if (m[0].length > 1) set.add(m[0]);
  }
  return [...set];
}

async function importSearchKey(base64Key: string): Promise<CryptoKey> {
  const raw = b64ToBytes(base64Key); // tolerant decode — same as the DEK
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

/** HMAC one word → an 8-byte hex blind token (collision-safe enough for search). */
async function token(key: CryptoKey, word: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(word)));
  let hex = "";
  for (let i = 0; i < 8; i++) hex += mac[i].toString(16).padStart(2, "0");
  return hex;
}

/** Blind tokens for a bag of text (subject + body), for indexing. */
export async function tokensFor(searchKeyB64: string, texts: string[]): Promise<string[]> {
  const key = await importSearchKey(searchKeyB64);
  const all = new Set<string>();
  for (const t of texts) for (const w of words(t)) all.add(w);
  return Promise.all([...all].map((w) => token(key, w)));
}

/**
 * Index a message's blind tokens into message_fts. Idempotent: deletes any prior
 * row for the message first (FTS5 has no unique constraint), so a redelivered
 * job converges instead of duplicating.
 */
export async function indexMessage(
  db: Db,
  input: { messageId: string; orgId: string; tokens: string[] },
): Promise<void> {
  await db.run(sql`DELETE FROM message_fts WHERE message_id = ${input.messageId}`);
  if (input.tokens.length === 0) return;
  const blob = input.tokens.join(" ");
  await db.run(
    sql`INSERT INTO message_fts (message_id, org_id, tokens) VALUES (${input.messageId}, ${input.orgId}, ${blob})`,
  );
}

/**
 * Index a note's blind tokens into note_fts (Task 5). Separate table from
 * message_fts: notes scope by mailbox_id directly (no deliveries join). Same
 * idempotent DELETE-then-INSERT pattern.
 */
export async function indexNote(
  db: Db,
  input: { noteId: string; mailboxId: string; orgId: string; tokens: string[] },
): Promise<void> {
  await db.run(sql`DELETE FROM note_fts WHERE note_id = ${input.noteId}`);
  if (input.tokens.length === 0) return;
  const blob = input.tokens.join(" ");
  await db.run(
    sql`INSERT INTO note_fts (note_id, mailbox_id, org_id, tokens) VALUES (${input.noteId}, ${input.mailboxId}, ${input.orgId}, ${blob})`,
  );
}

/** Remove a note from the search index (soft-delete → not searchable). */
export async function deleteNoteIndex(db: Db, noteId: string): Promise<void> {
  await db.run(sql`DELETE FROM note_fts WHERE note_id = ${noteId}`);
}

/**
 * Search notes within a mailbox: note_fts matches blind tokens, scoped by
 * mailbox_id. Returns note ids (callers tag the hit as a note, not an email).
 */
export async function searchNotes(
  db: Db,
  input: { searchKeyB64: string; mailboxId: string; queryText: string; mode?: "and" | "or" },
): Promise<string[]> {
  const toks = await tokensFor(input.searchKeyB64, [input.queryText]);
  if (toks.length === 0) return [];
  const match = toks.join(input.mode === "or" ? " OR " : " AND ");
  const rows = await db.all<{ note_id: string }>(sql`
    SELECT note_id FROM note_fts
    WHERE mailbox_id = ${input.mailboxId} AND note_fts MATCH ${match}
  `);
  return [...new Set(rows.map((r) => r.note_id))];
}

/**
 * Search within a mailbox: FTS5 matches blind tokens, scoped to the mailbox via
 * a deliveries join. `mode` AND (default) requires every query word; OR any.
 * Returns matching message ids.
 */
export async function searchMailbox(
  db: Db,
  input: { searchKeyB64: string; mailboxId: string; queryText: string; mode?: "and" | "or" },
): Promise<string[]> {
  const toks = await tokensFor(input.searchKeyB64, [input.queryText]);
  if (toks.length === 0) return [];
  const match = toks.join(input.mode === "or" ? " OR " : " AND ");
  const rows = await db.all<{ message_id: string }>(sql`
    SELECT f.message_id AS message_id
    FROM message_fts f
    JOIN delivery d ON d.message_id = f.message_id
    WHERE d.mailbox_id = ${input.mailboxId}
      AND message_fts MATCH ${match}
  `);
  return [...new Set(rows.map((r) => r.message_id))];
}
