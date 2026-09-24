// SPDX-License-Identifier: Apache-2.0
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { sanitizeEmailHtml } from "./sanitize-email";

type Db = DrizzleD1Database<typeof schema>;

// Canned responses. Per user (see the schema note): the writer's own phrasing,
// reusable from every address they send from. The composer inserts a snippet's
// HTML at the caret; nothing here touches the outbound path, so a snippet is
// just stored composer markup, cleaned on the way in exactly like a signature.

export const SNIPPET_TITLE_MAX = 120;
export const SNIPPET_BODY_MAX = 20_000;
/** Per-user ceiling. A picker with more rows than this is unusable anyway. */
export const SNIPPET_LIMIT = 100;

export type Snippet = {
  id: string;
  title: string;
  bodyHtml: string;
  updatedAt: number;
};

/**
 * Clean composer HTML for storage. Sanitizes on the trust boundary (the stored
 * HTML is re-injected into the composer and rides out with the mail), unwraps
 * the `<html><head></head><body>` document shell the sanitizer adds (what we
 * store is a fragment the editor splices into a body — the same shape the
 * editor itself emits, so a stored value round-trips through it unchanged),
 * then normalizes a content-empty document back to "": a cleared editor still
 * emits `<p></p>`, which is non-empty as a string but nothing to insert.
 * Returns null when the sanitizer refuses the input (oversized).
 */
export function cleanStoredHtml(bodyHtml: string): string | null {
  if (!bodyHtml.trim()) return "";
  const sanitized = sanitizeEmailHtml(bodyHtml);
  if (!sanitized.ok) return null;
  const clean = sanitized.html
    .replace(/^\s*<html[^>]*>\s*(?:<head[^>]*>[\s\S]*?<\/head>)?\s*<body[^>]*>/i, "")
    .replace(/<\/body>\s*<\/html>\s*$/i, "")
    .trim();
  const hasText = clean.replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "").length > 0;
  const hasMedia = /<(img|hr|table|blockquote)\b/i.test(clean);
  return hasText || hasMedia ? clean : "";
}

/** Collapse a title to its stored form: trimmed, inner whitespace squashed. */
export function normalizeSnippetTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

/** A user's snippets, A→Z by title (the order the picker shows them in). */
export async function listSnippets(db: Db, userId: string): Promise<Snippet[]> {
  const rows = await db.query.snippet.findMany({
    where: eq(mail.snippet.userId, userId),
    columns: { id: true, title: true, bodyHtml: true, updatedAt: true },
    orderBy: [asc(sql`lower(${mail.snippet.title})`)],
  });
  return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.getTime() }));
}

export type SaveSnippetResult =
  | { ok: true; snippet: Snippet }
  | { ok: false; reason: "not-found" | "duplicate-title" | "limit" };

/**
 * Create (`id` absent) or update (`id` present) one of the caller's snippets.
 * Inputs are already validated for shape/size by the RPC layer; this owns the
 * ownership check, the per-user cap, and the unique-title rule (checked ahead of
 * the index so the caller gets a named reason instead of a constraint error).
 */
export async function saveSnippet(
  db: Db,
  userId: string,
  input: { id?: string; title: string; bodyHtml: string },
): Promise<SaveSnippetResult> {
  const title = normalizeSnippetTitle(input.title);
  const now = new Date();
  const clash = await db.query.snippet.findFirst({
    where: and(
      eq(mail.snippet.userId, userId),
      eq(mail.snippet.title, title),
      ...(input.id ? [ne(mail.snippet.id, input.id)] : []),
    ),
    columns: { id: true },
  });
  if (clash) return { ok: false, reason: "duplicate-title" };

  if (input.id) {
    const [updated] = await db
      .update(mail.snippet)
      .set({ title, bodyHtml: input.bodyHtml, updatedAt: now })
      // userId in the predicate = the ownership check; a foreign id updates 0 rows.
      .where(and(eq(mail.snippet.id, input.id), eq(mail.snippet.userId, userId)))
      .returning({ id: mail.snippet.id, title: mail.snippet.title, bodyHtml: mail.snippet.bodyHtml });
    if (!updated) return { ok: false, reason: "not-found" };
    return { ok: true, snippet: { ...updated, updatedAt: now.getTime() } };
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(mail.snippet)
    .where(eq(mail.snippet.userId, userId));
  if (Number(count) >= SNIPPET_LIMIT) return { ok: false, reason: "limit" };
  const [created] = await db
    .insert(mail.snippet)
    .values({ userId, title, bodyHtml: input.bodyHtml, createdAt: now, updatedAt: now })
    .returning({ id: mail.snippet.id, title: mail.snippet.title, bodyHtml: mail.snippet.bodyHtml });
  return { ok: true, snippet: { ...created, updatedAt: now.getTime() } };
}

/** Delete one of the caller's snippets. False when it isn't theirs (or is gone). */
export async function deleteSnippet(db: Db, userId: string, id: string): Promise<boolean> {
  const gone = await db
    .delete(mail.snippet)
    .where(and(eq(mail.snippet.id, id), eq(mail.snippet.userId, userId)))
    .returning({ id: mail.snippet.id });
  return gone.length > 0;
}
