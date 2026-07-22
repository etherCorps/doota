import { query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { importKey, decryptContent } from "@doota/mail-core/crypto";
import { searchMailbox } from "@doota/mail-core/search";
import { accessibleMailboxIds } from "@doota/mail-core/mailbox";

/**
 * Mail search (command palette). Blind-token FTS over the user's OWN mailboxes
 * — access is the set of mailbox_access grants, so a search can never reach mail
 * the user can't already read. Matches are message ids; we roll them up to the
 * newest message per thread and decrypt just the subject/snippet for display.
 *
 * Gmail-style operators ride inside the query string: `from:` / `to:` match the
 * plaintext routing columns (from_addr / to_addrs / cc_addrs — substring, so
 * partial addresses work), `is:starred` (aliases: important, flagged) filters on
 * thread_state. Remaining free text goes through blind-token FTS as before.
 */

export type SearchHit = {
  threadId: string;
  mailboxId: string;
  subject: string | null;
  snippet: string | null;
  from: string | null;
  at: number | null;
};

function keys() {
  const env = getRequestEvent().platform?.env;
  if (!env?.MAIL_DEK || !env?.MAIL_SEARCH_KEY) error(500, "Search is not configured.");
  return { dek: env.MAIL_DEK, searchKeyB64: env.MAIL_SEARCH_KEY };
}

function preview(text: string | null, n = 120): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

/** Pull `from:x` / `to:x` / `is:starred|important|flagged` out; rest is FTS text. */
function parseQuery(raw: string) {
  let from: string | undefined;
  let to: string | undefined;
  let starred = false;
  const text = raw
    .replace(/(^|\s)(from|to|is):(\S+)/gi, (_m, pre: string, k: string, v: string) => {
      const val = v.toLowerCase();
      const key = k.toLowerCase();
      if (key === "from") from = val;
      else if (key === "to") to = val;
      else if (val === "starred" || val === "important" || val === "flagged") starred = true;
      return pre;
    })
    // A bare operator mid-typing ("from:") is not free text — drop it.
    .replace(/(^|\s)(from|to|is):(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { text, from, to, starred };
}

export const searchMail = query(
  z.object({
    q: z.string().trim().min(2).max(200),
    mailboxId: z.string().optional(),
    // Palette shows a short list (default 20); the full results view asks for more.
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async ({ q, mailboxId, limit }): Promise<SearchHit[]> => {
    const { locals } = getRequestEvent();
    if (!locals.user) error(401, "Not authenticated");

    const accessible = await accessibleMailboxIds(locals.db, locals.user.id);
    // Prefer the active mailbox when it's one the user holds; else search all.
    const boxes = mailboxId && accessible.includes(mailboxId) ? [mailboxId] : accessible;
    if (!boxes.length) return [];

    const { dek, searchKeyB64 } = keys();
    const { text, from, to, starred } = parseQuery(q);

    // Candidate message ids, remembering which mailbox surfaced each (for nav).
    const msgToBox = new Map<string, string>();
    // Thread → mailbox for the starred-only path (no message ids up front).
    let starredThreads: Map<string, string> | null = null;

    if (text.length >= 2) {
      // Free text → blind-token FTS per mailbox (as before).
      for (const b of boxes) {
        const ids = await searchMailbox(locals.db, { searchKeyB64, mailboxId: b, queryText: text });
        for (const id of ids) if (!msgToBox.has(id)) msgToBox.set(id, b);
      }
    } else if (from || to) {
      // No free text: candidates come straight from the plaintext routing
      // columns (LIKE is case-insensitive for ASCII in SQLite).
      const conds = [];
      if (from) conds.push(like(schema.message.fromAddr, `%${from}%`));
      if (to)
        conds.push(
          or(
            like(schema.message.toAddrs, `%${to}%`),
            like(schema.message.ccAddrs, `%${to}%`),
          ),
        );
      const found = await locals.db
        .selectDistinct({
          id: schema.message.id,
          mailboxId: schema.delivery.mailboxId,
          sentAt: schema.message.sentAt,
        })
        .from(schema.message)
        .innerJoin(schema.delivery, eq(schema.delivery.messageId, schema.message.id))
        .where(and(inArray(schema.delivery.mailboxId, boxes), ...conds))
        .orderBy(desc(schema.message.sentAt))
        .limit(300);
      for (const f of found) if (!msgToBox.has(f.id)) msgToBox.set(f.id, f.mailboxId);
    } else if (starred) {
      // Pure `is:starred`: start from thread_state, newest message per thread.
      const states = await locals.db.query.threadState.findMany({
        where: and(
          inArray(schema.threadState.mailboxId, boxes),
          eq(schema.threadState.isStarred, true),
        ),
        columns: { threadId: true, mailboxId: true },
        limit: 100,
      });
      starredThreads = new Map(states.map((s) => [s.threadId, s.mailboxId]));
      if (!starredThreads.size) return [];
    } else {
      return [];
    }

    if (!msgToBox.size && !starredThreads) return [];

    let rows = await locals.db.query.message.findMany({
      where: starredThreads
        ? inArray(schema.message.threadId, [...starredThreads.keys()])
        : inArray(schema.message.id, [...msgToBox.keys()]),
      orderBy: desc(schema.message.sentAt),
      columns: {
        id: true,
        threadId: true,
        subjectEnc: true,
        bodyStrippedEnc: true,
        fromAddr: true,
        toAddrs: true,
        ccAddrs: true,
        sentAt: true,
      },
    });
    if (starredThreads) {
      const st = starredThreads;
      for (const r of rows) msgToBox.set(r.id, st.get(r.threadId)!);
    }

    // FTS candidates still need the participant filters applied.
    if (from) rows = rows.filter((r) => r.fromAddr?.toLowerCase().includes(from));
    if (to)
      rows = rows.filter(
        (r) => r.toAddrs.toLowerCase().includes(to) || r.ccAddrs.toLowerCase().includes(to),
      );

    // Newest matched message per thread (rows already sorted newest-first).
    const byThread = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!byThread.has(r.threadId)) byThread.set(r.threadId, r);

    let hits = [...byThread.values()];
    if (starred && !starredThreads) {
      // Keep only threads starred in the mailbox that surfaced them.
      const states = await locals.db.query.threadState.findMany({
        where: and(
          inArray(schema.threadState.threadId, [...byThread.keys()]),
          eq(schema.threadState.isStarred, true),
        ),
        columns: { threadId: true, mailboxId: true },
      });
      const ok = new Set(states.map((s) => `${s.threadId}|${s.mailboxId}`));
      hits = hits.filter((r) => ok.has(`${r.threadId}|${msgToBox.get(r.id)}`));
    }

    const ck = await importKey(dek);
    const top = hits.slice(0, limit ?? 20);
    return Promise.all(
      top.map(async (r) => ({
        threadId: r.threadId,
        mailboxId: msgToBox.get(r.id)!,
        subject: await decryptContent(ck, r.subjectEnc),
        snippet: preview(await decryptContent(ck, r.bodyStrippedEnc)),
        from: r.fromAddr,
        at: r.sentAt ? r.sentAt.getTime() : null,
      })),
    );
  },
);
