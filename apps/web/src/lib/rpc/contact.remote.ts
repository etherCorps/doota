// SPDX-License-Identifier: Apache-2.0
import { query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { importKey, decryptContent } from "@doota/mail-core/crypto";
import { getAuthz } from "$lib/server/authz.js";

/**
 * Contact detail for the sender hover card: whether the address is one of our
 * org's users, plus the most recent threads involving it. Privacy boundary is
 * the SAME as search — only threads in mailboxes the caller can already read.
 * Lazy: the client fires this only when a card actually opens.
 */

export type ContactThread = {
  threadId: string;
  mailboxId: string;
  subject: string | null;
  at: number | null;
  /** true = they wrote to us; false = we wrote to them. */
  inbound: boolean;
};
export type ContactInfo = { isInternal: boolean; recent: ContactThread[] };

export const contactRecent = query(
  z.object({ address: z.string().min(3).max(320) }),
  async ({ address }): Promise<ContactInfo> => {
    const { locals, platform } = getRequestEvent();
    if (!locals.user) error(401, "Not authenticated");
    const dek = platform?.env?.MAIL_DEK;
    if (!dek) error(500, "Mail encryption key is not configured.");
    const addr = address.trim().toLowerCase();

    // Internal = one of our org's users (org members log in with their address).
    const owner = await locals.db.query.user.findFirst({
      where: eq(schema.user.email, addr),
      columns: { id: true },
    });
    const isInternal = !!owner;

    const boxes = (await getAuthz()).mailboxIds;
    if (!boxes.length) return { isInternal, recent: [] };

    // Messages this address is on (from OR to/cc), within readable mailboxes.
    // LIKE is case-insensitive for ASCII in SQLite; from_addr keeps its original
    // case, so match it with LIKE too.
    const rows = await locals.db
      .selectDistinct({
        threadId: schema.message.threadId,
        mailboxId: schema.delivery.mailboxId,
        fromAddr: schema.message.fromAddr,
        subjectEnc: schema.message.subjectEnc,
        sentAt: schema.message.sentAt,
      })
      .from(schema.message)
      .innerJoin(schema.delivery, eq(schema.delivery.messageId, schema.message.id))
      .where(
        and(
          inArray(schema.delivery.mailboxId, boxes),
          or(
            like(schema.message.fromAddr, addr),
            like(schema.message.toAddrs, `%${addr}%`),
            like(schema.message.ccAddrs, `%${addr}%`),
          ),
        ),
      )
      .orderBy(desc(schema.message.sentAt))
      .limit(60);

    // Newest message per thread, top 5.
    const seen = new Set<string>();
    const picked: typeof rows = [];
    for (const r of rows) {
      if (seen.has(r.threadId)) continue;
      seen.add(r.threadId);
      picked.push(r);
      if (picked.length >= 5) break;
    }

    const ck = await importKey(dek);
    const recent = await Promise.all(
      picked.map(async (r) => ({
        threadId: r.threadId,
        mailboxId: r.mailboxId,
        subject: await decryptContent(ck, r.subjectEnc),
        at: r.sentAt ? r.sentAt.getTime() : null,
        inbound: (r.fromAddr ?? "").toLowerCase() === addr,
      })),
    );
    return { isInternal, recent };
  },
);
