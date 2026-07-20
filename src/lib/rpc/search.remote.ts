import { query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { desc, inArray } from "drizzle-orm";
import * as schema from "$lib/server/db/schema.js";
import { importKey, decryptContent } from "$lib/server/mail/crypto.js";
import { searchMailbox } from "$lib/server/mail/search.js";
import { accessibleMailboxIds } from "$lib/server/mail/mailbox.js";

/**
 * Mail search (command palette). Blind-token FTS over the user's OWN mailboxes
 * — access is the set of mailbox_access grants, so a search can never reach mail
 * the user can't already read. Matches are message ids; we roll them up to the
 * newest message per thread and decrypt just the subject/snippet for display.
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

export const searchMail = query(
  z.object({ q: z.string().trim().min(2).max(200), mailboxId: z.string().optional() }),
  async ({ q, mailboxId }): Promise<SearchHit[]> => {
    const { locals } = getRequestEvent();
    if (!locals.user) error(401, "Not authenticated");

    const accessible = await accessibleMailboxIds(locals.db, locals.user.id);
    // Prefer the active mailbox when it's one the user holds; else search all.
    const boxes = mailboxId && accessible.includes(mailboxId) ? [mailboxId] : accessible;
    if (!boxes.length) return [];

    const { dek, searchKeyB64 } = keys();

    // Matched message ids, remembering which mailbox surfaced each (for nav).
    const msgToBox = new Map<string, string>();
    for (const b of boxes) {
      const ids = await searchMailbox(locals.db, { searchKeyB64, mailboxId: b, queryText: q });
      for (const id of ids) if (!msgToBox.has(id)) msgToBox.set(id, b);
    }
    if (!msgToBox.size) return [];

    const rows = await locals.db.query.message.findMany({
      where: inArray(schema.message.id, [...msgToBox.keys()]),
      orderBy: desc(schema.message.sentAt),
      columns: {
        id: true,
        threadId: true,
        subjectEnc: true,
        bodyStrippedEnc: true,
        fromAddr: true,
        sentAt: true,
      },
    });

    // Newest matched message per thread (rows already sorted newest-first).
    const byThread = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!byThread.has(r.threadId)) byThread.set(r.threadId, r);

    const ck = await importKey(dek);
    const top = [...byThread.values()].slice(0, 20);
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
