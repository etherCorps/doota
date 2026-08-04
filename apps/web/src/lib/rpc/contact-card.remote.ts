// SPDX-License-Identifier: Apache-2.0
import { query, command, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, desc, eq, like, ne, sql } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { getAuthz } from "$lib/server/authz.js";
import { importKey, decryptContent } from "@doota/mail-core/crypto";
import {
  signatureSuffix,
  splitAtSigDelimiter,
  extractContactFields,
  MIN_SIGNATURE_SAMPLES,
} from "@doota/mail-core/signature-detect";

/**
 * Contact card (build guide, Phase 3). ~80% of the card's value needs ZERO
 * signature parsing: display name, interaction history (correspondent), and
 * domain colleagues. Signature extraction is optional enrichment computed AT
 * READ TIME from the sender's recent message texts — deterministic fields
 * only, surfaced as suggestions; nothing is written to `correspondent`
 * without an explicit accept (acceptContactDetail).
 */

async function grantOn(mailboxId: string) {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  const { mailboxIds } = await getAuthz();
  if (!mailboxIds.includes(mailboxId)) error(403, "You need access to this mailbox.");
  return { db: locals.db, user: locals.user };
}

function contentKey() {
  const dek = getRequestEvent().platform?.env?.MAIL_DEK;
  if (!dek) error(500, "Mail encryption key is not configured.");
  return importKey(dek);
}

const DETAIL_FIELDS = ["phone", "url", "email", "handle"] as const;

export const contactCard = query(
  z.object({ mailboxId: z.string().min(1), address: z.string().trim().toLowerCase().min(3) }),
  async ({ mailboxId, address }) => {
    const { db } = await grantOn(mailboxId);
    const row = await db.query.correspondent.findFirst({
      where: and(eq(schema.correspondent.mailboxId, mailboxId), eq(schema.correspondent.address, address)),
    });

    // Domain colleagues: "3 others at acme.com" — a prefix query, no parsing.
    const domain = address.split("@")[1] ?? "";
    let domainOthers: { address: string; name: string | null }[] = [];
    let domainRepliedTo = false;
    if (domain) {
      domainOthers = await db
        .select({ address: schema.correspondent.address, name: schema.correspondent.name })
        .from(schema.correspondent)
        .where(
          and(
            eq(schema.correspondent.mailboxId, mailboxId),
            like(schema.correspondent.address, `%@${domain}`),
            ne(schema.correspondent.address, address),
          ),
        )
        .orderBy(desc(schema.correspondent.lastSeenAt))
        .limit(4);
      const replied = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.correspondent)
        .where(
          and(
            eq(schema.correspondent.mailboxId, mailboxId),
            like(schema.correspondent.address, `%@${domain}`),
            sql`${schema.correspondent.lastRepliedAt} is not null`,
          ),
        );
      domainRepliedTo = (replied[0]?.n ?? 0) > 0;
    }

    // Optional enrichment: recent stripped texts from this sender → repeated
    // trailing block (or `-- ` delimiter) → high-precision fields. Allowed to
    // fail silently — the card stands without it.
    const accepted: Record<string, string> = row?.details ? safeJson(row.details) : {};
    let suggestions: { field: (typeof DETAIL_FIELDS)[number]; value: string }[] = [];
    try {
      const recent = await db
        .select({ bodyStrippedEnc: schema.message.bodyStrippedEnc })
        .from(schema.message)
        .innerJoin(
          schema.delivery,
          and(eq(schema.delivery.messageId, schema.message.id), eq(schema.delivery.mailboxId, mailboxId)),
        )
        .where(eq(schema.message.fromAddr, address))
        .orderBy(desc(schema.message.sentAt))
        .limit(5);
      const ck = await contentKey();
      const texts: string[] = [];
      for (const messageRow of recent) {
        const text = await decryptContent(ck, messageRow.bodyStrippedEnc);
        if (text) texts.push(text);
      }
      const delimited = texts.map(splitAtSigDelimiter).find(Boolean);
      const block = delimited
        ? delimited.signature.split(/\r?\n/)
        : texts.length >= MIN_SIGNATURE_SAMPLES
          ? signatureSuffix(texts)
          : null;
      if (block) {
        const fields = extractContactFields(block);
        const candidates: { field: (typeof DETAIL_FIELDS)[number]; value: string }[] = [
          ...fields.phones.map((value) => ({ field: "phone" as const, value })),
          ...fields.urls.map((value) => ({ field: "url" as const, value })),
          ...fields.emails.filter((e) => e !== address).map((value) => ({ field: "email" as const, value })),
          ...fields.handles.map((value) => ({ field: "handle" as const, value })),
        ];
        suggestions = candidates.filter((c) => accepted[c.field] !== c.value).slice(0, 6);
      }
    } catch {
      suggestions = [];
    }

    return {
      address,
      name: row?.name ?? null,
      firstSeenAt: row?.firstSeenAt ? row.firstSeenAt.getTime() : null,
      lastSeenAt: row?.lastSeenAt ? row.lastSeenAt.getTime() : null,
      lastRepliedAt: row?.lastRepliedAt ? row.lastRepliedAt.getTime() : null,
      messageCount: row?.messageCount ?? 0,
      details: accepted,
      domain,
      domainOthers,
      domainRepliedTo,
      suggestions,
    };
  },
);

/** One-tap accept of a suggested field — the ONLY writer of details. */
export const acceptContactDetail = command(
  z.object({
    mailboxId: z.string().min(1),
    address: z.string().trim().toLowerCase().min(3),
    field: z.enum(DETAIL_FIELDS),
    value: z.string().trim().min(1).max(200),
  }),
  async ({ mailboxId, address, field, value }) => {
    const { db } = await grantOn(mailboxId);
    const row = await db.query.correspondent.findFirst({
      where: and(eq(schema.correspondent.mailboxId, mailboxId), eq(schema.correspondent.address, address)),
      columns: { id: true, details: true },
    });
    if (!row) error(404, "Unknown correspondent.");
    const details = { ...safeJson(row.details), [field]: value };
    await db
      .update(mail.correspondent)
      .set({ details: JSON.stringify(details) })
      .where(eq(mail.correspondent.id, row.id));
    return { ok: true as const, details };
  },
);

function safeJson(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
