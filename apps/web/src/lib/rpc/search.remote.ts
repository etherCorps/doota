// SPDX-License-Identifier: Apache-2.0
import { query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, desc, eq, gte, inArray, isNotNull, like, lte, or } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { importKey, decryptContent } from "@doota/mail-core/crypto";
import { searchMailbox, words } from "@doota/mail-core/search";
import { accessibleMailboxIds, assignedOnlyMailboxIds } from "@doota/mail-core/mailbox";
import { parseSearchQuery, snippetAround } from "$lib/utils/search-query";

/**
 * Mail search (command palette). Blind-token FTS over the user's OWN mailboxes
 * — access is the set of mailbox_access grants, so a search can never reach mail
 * the user can't already read. Matches are message ids; we roll them up to the
 * newest message per thread and decrypt just the subject/snippet for display.
 *
 * Gmail-style operators ride inside the query string: `from:` / `to:` match the
 * plaintext routing columns (from_addr / to_addrs / cc_addrs — substring, so
 * partial addresses work), `is:starred` (aliases: important, flagged) filters on
 * thread_state, `is:unread` / `is:read` on the caller's thread_read state,
 * `has:attachment` on a filename'd attachment row, and `after:` / `before:`
 * (YYYY-MM-DD, YYYY/MM/DD, or a relative `7d`) on sent time. Remaining free text
 * goes through blind-token FTS. `terms` echoes the FTS words so the client can
 * bold matches; the snippet is centered on the first match, not the body head.
 */

export type SearchHit = {
  threadId: string;
  mailboxId: string;
  subject: string | null;
  snippet: string | null;
  from: string | null;
  at: number | null;
  /** Lowercased query words the client highlights in subject + snippet. */
  terms: string[];
};

function keys() {
  const env = getRequestEvent().platform?.env;
  if (!env?.MAIL_DEK || !env?.MAIL_SEARCH_KEY) error(500, "Search is not configured.");
  return { dek: env.MAIL_DEK, searchKeyB64: env.MAIL_SEARCH_KEY };
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
    const { text, from, to, starred, hasAttachment, unread, after, before } = parseSearchQuery(q);
    const terms = text.length >= 2 ? words(text) : [];

    // Candidate message ids, remembering which mailbox surfaced each (for nav).
    const msgToBox = new Map<string, string>();
    // Thread → mailbox for the starred-only path (no message ids up front).
    let starredThreads: Map<string, string> | null = null;

    if (text.length >= 2) {
      // Free text → blind-token FTS per mailbox (as before).
      for (const boxId of boxes) {
        const ids = await searchMailbox(locals.db, { searchKeyB64, mailboxId: boxId, queryText: text });
        for (const id of ids) if (!msgToBox.has(id)) msgToBox.set(id, boxId);
      }
    } else if (from || to || after != null || before != null || hasAttachment) {
      // No free text: candidates come from the plaintext columns. from/to (LIKE,
      // case-insensitive for ASCII) and the sent-time range filter in SQL; the
      // attachment requirement is a post-filter below.
      const conds = [];
      if (from) conds.push(like(schema.message.fromAddr, `%${from}%`));
      if (to)
        conds.push(
          or(
            like(schema.message.toAddrs, `%${to}%`),
            like(schema.message.ccAddrs, `%${to}%`),
          ),
        );
      if (after != null) conds.push(gte(schema.message.sentAt, new Date(after)));
      if (before != null) conds.push(lte(schema.message.sentAt, new Date(before)));
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
      for (const foundRow of found) if (!msgToBox.has(foundRow.id)) msgToBox.set(foundRow.id, foundRow.mailboxId);
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
      starredThreads = new Map(states.map((state) => [state.threadId, state.mailboxId]));
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
      for (const row of rows) msgToBox.set(row.id, st.get(row.threadId)!);
    }

    // Structured filters that apply to candidates from ANY source (so free text
    // combines with them). from/to/date already ran in SQL for the routing-column
    // path but must still be applied to FTS candidates.
    if (from) rows = rows.filter((row) => row.fromAddr?.toLowerCase().includes(from));
    if (to)
      rows = rows.filter(
        (row) => row.toAddrs.toLowerCase().includes(to) || row.ccAddrs.toLowerCase().includes(to),
      );
    if (after != null) rows = rows.filter((row) => row.sentAt != null && row.sentAt.getTime() >= after);
    if (before != null) rows = rows.filter((row) => row.sentAt != null && row.sentAt.getTime() <= before);

    // has:attachment — a real file attachment carries a filename; inline cid
    // images are identified by Content-ID and typically have none.
    if (hasAttachment && rows.length) {
      const withAtt = await locals.db
        .selectDistinct({ mid: schema.attachment.messageId })
        .from(schema.attachment)
        .where(
          and(
            inArray(schema.attachment.messageId, rows.map((row) => row.id)),
            isNotNull(schema.attachment.filename),
          ),
        );
      const set = new Set(withAtt.map((attachment) => attachment.mid));
      rows = rows.filter((row) => set.has(row.id));
    }

    // Newest matched message per thread (rows already sorted newest-first).
    const byThread = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!byThread.has(row.threadId)) byThread.set(row.threadId, row);

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
      const ok = new Set(states.map((state) => `${state.threadId}|${state.mailboxId}`));
      hits = hits.filter((hit) => ok.has(`${hit.threadId}|${msgToBox.get(hit.id)}`));
    }

    // is:unread / is:read — per (user, thread, mailbox): unread = no thread_read
    // row, or last read before the thread's newest matched message.
    if (unread != null && hits.length) {
      const reads = await locals.db.query.threadRead.findMany({
        where: and(
          eq(schema.threadRead.userId, locals.user.id),
          inArray(schema.threadRead.threadId, hits.map((hit) => hit.threadId)),
        ),
        columns: { threadId: true, mailboxId: true, lastReadAt: true },
      });
      const readAt = new Map(reads.map((read) => [`${read.threadId}|${read.mailboxId}`, read.lastReadAt?.getTime() ?? 0]));
      hits = hits.filter((hit) => {
        const last = readAt.get(`${hit.threadId}|${msgToBox.get(hit.id)}`);
        const isUnread = last == null || (hit.sentAt != null && last < hit.sentAt.getTime());
        return unread ? isUnread : !isUnread;
      });
    }

    // Assigned-only mailboxes: a hit only survives if the thread is assigned to
    // the searcher — search must never widen what the mailbox itself shows.
    const restricted = await assignedOnlyMailboxIds(locals.db, locals.user.id);
    if (restricted.length && hits.length) {
      const mine = await locals.db.query.threadState.findMany({
        where: and(
          inArray(schema.threadState.mailboxId, restricted),
          inArray(schema.threadState.threadId, hits.map((hit) => hit.threadId)),
          eq(schema.threadState.assigneeUserId, locals.user.id),
        ),
        columns: { threadId: true, mailboxId: true },
      });
      const ok = new Set(mine.map((state) => `${state.threadId}|${state.mailboxId}`));
      hits = hits.filter((hit) => {
        const box = msgToBox.get(hit.id)!;
        return !restricted.includes(box) || ok.has(`${hit.threadId}|${box}`);
      });
    }

    const ck = await importKey(dek);
    const top = hits.slice(0, limit ?? 20);
    return Promise.all(
      top.map(async (hit) => ({
        threadId: hit.threadId,
        mailboxId: msgToBox.get(hit.id)!,
        subject: await decryptContent(ck, hit.subjectEnc),
        snippet: snippetAround(await decryptContent(ck, hit.bodyStrippedEnc), terms),
        from: hit.fromAddr,
        at: hit.sentAt ? hit.sentAt.getTime() : null,
        terms,
      })),
    );
  },
);
