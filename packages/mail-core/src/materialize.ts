import { and, desc, eq, gt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { encryptContent, type ContentKey } from "./crypto";
import { indexMessage, tokensFor } from "./search";
import {
  candidateParentIds,
  deriveContentKind,
  normalizeSubject,
  stripHtmlTags,
  stripQuotesText,
} from "./mail-thread-contract";

type Db = DrizzleD1Database<typeof schema>;

/** Provider-agnostic parsed message — the consumer builds this from postal-mime. */
export type ParsedMessage = {
  messageIdHeader: string;
  inReplyTo: string | null;
  references: string | null;
  from: string | null;
  /** Original visible recipients + Reply-To — for reply-all reconstruction. */
  to?: string[];
  cc?: string[];
  replyTo?: string | null;
  subject: string | null;
  sentAt: number | null;
  text: string | null;
  html: string | null;
  r2RawKey: string | null;
  attachments: {
    partId: string | null;
    filename: string | null;
    contentType: string | null;
    size: number | null;
    r2Key: string | null;
  }[];
};

export type MaterializeDeps = { ck: ContentKey; searchKeyB64: string };

const SUBJECT_FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7d — weak, bounded

/**
 * Find one of OUR messages by a wire Message-ID. Tries the stored header first,
 * then the provider-minted ids: Cloudflare Email Service rejects a custom
 * Message-ID and stamps its own (e.g. <EUQ…@doota.dev>), which we capture from
 * send() into submission.provider_message_id (first chunk) and
 * submission_recipient.provider_message_id (every chunk). External replies carry
 * THAT id in In-Reply-To, so it must resolve to the same message row.
 */
async function findMessageByHeaderId(
  db: Db,
  orgId: string,
  headerId: string,
): Promise<{ id: string; threadId: string } | null> {
  const direct = await db.query.message.findFirst({
    where: and(
      eq(schema.message.orgId, orgId),
      eq(schema.message.messageIdHeader, headerId),
    ),
    columns: { id: true, threadId: true },
  });
  if (direct) return direct;

  const sub = await db.query.submission.findFirst({
    where: and(
      eq(schema.submission.orgId, orgId),
      eq(schema.submission.providerMessageId, headerId),
    ),
    columns: { messageId: true },
  });
  let messageId = sub?.messageId ?? null;
  if (!messageId) {
    // Chunks after the first store their wire id only on the recipient rows.
    const rec = await db
      .select({ messageId: schema.submission.messageId })
      .from(schema.submissionRecipient)
      .innerJoin(
        schema.submission,
        eq(schema.submissionRecipient.submissionId, schema.submission.id),
      )
      .where(
        and(
          eq(schema.submission.orgId, orgId),
          eq(schema.submissionRecipient.providerMessageId, headerId),
        ),
      )
      .limit(1);
    messageId = rec[0]?.messageId ?? null;
  }
  if (!messageId) return null;
  return (
    (await db.query.message.findFirst({
      where: eq(schema.message.id, messageId),
      columns: { id: true, threadId: true },
    })) ?? null
  );
}

/**
 * Find or create the thread for a message. In-Reply-To / References win — every
 * candidate id is tried newest-first (an unknown rewritten id must not orphan a
 * reply whose older ancestors we know). A normalized-subject match in the same
 * org within a 7-day window is the weak fallback only when headers give
 * nothing. Cleartext metadata — no decryption.
 */
async function resolveThreadId(
  db: Db,
  orgId: string,
  parsed: ParsedMessage,
): Promise<string> {
  for (const pid of candidateParentIds(parsed.inReplyTo, parsed.references)) {
    const parent = await findMessageByHeaderId(db, orgId, pid);
    if (parent) return parent.threadId;
  }

  const subjectNorm = normalizeSubject(parsed.subject);
  if (subjectNorm) {
    const since = new Date((parsed.sentAt ?? Date.now()) - SUBJECT_FALLBACK_WINDOW_MS);
    // Candidate threads with the same normalized subject in the window, newest
    // first. Subject alone is too weak to merge on (two unrelated "Re: invoice"
    // threads would collapse), so we ALSO require a shared participant — the new
    // message and the candidate thread must have an address in common.
    const candidates = await db.query.thread.findMany({
      where: and(
        eq(schema.thread.orgId, orgId),
        eq(schema.thread.subjectNormalized, subjectNorm),
        gt(schema.thread.lastMessageAt, since),
      ),
      orderBy: desc(schema.thread.lastMessageAt),
      columns: { id: true },
      limit: 10,
    });
    if (candidates.length) {
      const wanted = participantsOf(parsed);
      for (const c of candidates) {
        if (await threadSharesParticipant(db, c.id, wanted)) return c.id;
      }
    }
  }

  const created = await db
    .insert(mail.thread)
    .values({
      orgId,
      subjectNormalized: subjectNorm || null,
      lastMessageAt: parsed.sentAt ? new Date(parsed.sentAt) : new Date(),
    })
    .returning({ id: mail.thread.id });
  return created[0].id;
}

/**
 * Upsert the shared, immutable message (deduped by org_id + message_id_header).
 * First writer creates it; later recipients of the same email reuse it. Returns
 * the message id + its thread id. Idempotent: a redelivered job that hits an
 * existing row reuses it and re-runs attachments/search harmlessly.
 */
export async function materializeMessage(
  db: Db,
  orgId: string,
  parsed: ParsedMessage,
  deps: MaterializeDeps,
): Promise<{ messageId: string; threadId: string }> {
  // Dedupe by header id — including the provider-minted wire id, so our own
  // message reflecting back (mailing list, CC to a hosted address) reuses the
  // sender's row instead of duplicating in the thread.
  const existing = await findMessageByHeaderId(db, orgId, parsed.messageIdHeader);
  if (existing) {
    // Converge attachments + search on re-run without duplicating the message.
    await writeAttachments(db, existing.id, parsed);
    await indexContent(db, existing.id, orgId, parsed, deps);
    return { messageId: existing.id, threadId: existing.threadId };
  }

  const threadId = await resolveThreadId(db, orgId, parsed);
  const strippedText = parsed.text ? stripQuotesText(parsed.text) : "";
  const bodyFull = parsed.text ?? (parsed.html ? stripHtmlTags(parsed.html) : null);
  const contentKind = deriveContentKind({
    strippedText,
    hasAttachments: parsed.attachments.length > 0,
    htmlLength: parsed.html?.length ?? 0,
  });

  const [subjectEnc, strippedEnc, fullEnc, htmlEnc] = await Promise.all([
    encryptContent(deps.ck, parsed.subject),
    encryptContent(deps.ck, strippedText || bodyFull),
    encryptContent(deps.ck, bodyFull),
    encryptContent(deps.ck, parsed.html),
  ]);

  const inserted = await db
    .insert(mail.message)
    .values({
      orgId,
      threadId,
      messageIdHeader: parsed.messageIdHeader,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      fromAddr: parsed.from,
      toAddrs: JSON.stringify(parsed.to ?? []),
      ccAddrs: JSON.stringify(parsed.cc ?? []),
      replyTo: parsed.replyTo,
      sentAt: parsed.sentAt ? new Date(parsed.sentAt) : null,
      r2RawKey: parsed.r2RawKey,
      itemType: "external_message",
      contentKind,
      subjectEnc,
      bodyStrippedEnc: strippedEnc,
      bodyFullEnc: fullEnc,
      bodyHtmlEnc: htmlEnc,
    })
    .onConflictDoNothing()
    .returning({ id: mail.message.id, threadId: mail.message.threadId });

  // Lost a create race with a concurrent recipient — read the winner's row.
  const row =
    inserted[0] ??
    (await db.query.message.findFirst({
      where: and(
        eq(schema.message.orgId, orgId),
        eq(schema.message.messageIdHeader, parsed.messageIdHeader),
      ),
      columns: { id: true, threadId: true },
    }))!;

  await bumpThread(db, row.threadId, parsed.sentAt);
  await writeAttachments(db, row.id, parsed);
  await indexContent(db, row.id, orgId, parsed, deps);
  return { messageId: row.id, threadId: row.threadId };
}

/** Lowercased address set of a message: from + to + cc. */
function participantsOf(parsed: ParsedMessage): Set<string> {
  const set = new Set<string>();
  if (parsed.from) set.add(parsed.from.trim().toLowerCase());
  for (const a of parsed.to ?? []) if (a) set.add(a.trim().toLowerCase());
  for (const a of parsed.cc ?? []) if (a) set.add(a.trim().toLowerCase());
  return set;
}

/** True if any message in the thread shares an address with `wanted`. */
async function threadSharesParticipant(
  db: Db,
  threadId: string,
  wanted: Set<string>,
): Promise<boolean> {
  if (wanted.size === 0) return false;
  const msgs = await db.query.message.findMany({
    where: eq(schema.message.threadId, threadId),
    columns: { fromAddr: true, toAddrs: true, ccAddrs: true },
  });
  for (const m of msgs) {
    if (m.fromAddr && wanted.has(m.fromAddr.trim().toLowerCase())) return true;
    for (const a of jsonAddrs(m.toAddrs)) if (wanted.has(a)) return true;
    for (const a of jsonAddrs(m.ccAddrs)) if (wanted.has(a)) return true;
  }
  return false;
}

function jsonAddrs(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map((s) => String(s).trim().toLowerCase()) : [];
  } catch {
    return [];
  }
}

async function bumpThread(db: Db, threadId: string, sentAt: number | null): Promise<void> {
  await db
    .update(mail.thread)
    .set({ lastMessageAt: new Date(sentAt ?? Date.now()) })
    .where(eq(mail.thread.id, threadId));
}

async function writeAttachments(db: Db, messageId: string, parsed: ParsedMessage): Promise<void> {
  if (parsed.attachments.length === 0) return;
  // Clear + re-insert: attachments are derived from the canonical raw, so a
  // re-run replaces cleanly (no natural unique key on part metadata).
  await db.delete(mail.attachment).where(eq(mail.attachment.messageId, messageId));
  const rows = parsed.attachments.map((a) => ({
    messageId,
    partId: a.partId,
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
    r2Key: a.r2Key,
  }));
  // D1 caps bound parameters at 100/statement; 7 cols → chunk at 10 rows (70
  // params) so a message with many attachments doesn't overflow in one INSERT.
  for (let i = 0; i < rows.length; i += 10) {
    await db.insert(mail.attachment).values(rows.slice(i, i + 10));
  }
}

async function indexContent(
  db: Db,
  messageId: string,
  orgId: string,
  parsed: ParsedMessage,
  deps: MaterializeDeps,
): Promise<void> {
  const tokens = await tokensFor(deps.searchKeyB64, [
    parsed.subject ?? "",
    parsed.text ?? "",
    parsed.html ? stripHtmlTags(parsed.html) : "",
    // Participants: lets plain-text queries find people ("alice") — the words()
    // regex splits addresses into name/domain words. Indexed going forward only.
    parsed.from ?? "",
    ...(parsed.to ?? []),
    ...(parsed.cc ?? []),
  ]);
  await indexMessage(db, { messageId, orgId, tokens });
}

/**
 * Placement policy for the mailbox's thread_state. Inbound (default): a new
 * thread lands in `inbox`, and a reply un-archives an archived thread. Outbound
 * (sender's copy): a new thread lands in `sent`, and a reply must NOT yank the
 * thread out of wherever it currently sits (don't drag an inbox thread to sent).
 */
export type PlacementPolicy = { newThread: string; unarchiveOnReply: boolean };
const INBOUND_PLACEMENT: PlacementPolicy = { newThread: "inbox", unarchiveOnReply: true };

/**
 * Write one recipient's delivery + ensure a thread_state for its mailbox. BCC
 * lives ONLY as a delivery row (never back into the shared message headers).
 * Idempotent on (message_id, mailbox_id, role). Placement follows `policy`
 * (default: inbound — new→inbox, un-archive on reply).
 */
export async function materializeDelivery(
  db: Db,
  input: {
    orgId: string;
    messageId: string;
    threadId: string;
    mailboxId: string;
    role: "to" | "cc" | "bcc" | "from";
    viaAliasId: string | null;
    subaddressTag: string | null;
    sentAt: number | null;
    placement?: PlacementPolicy;
  },
): Promise<void> {
  await db
    .insert(mail.delivery)
    .values({
      orgId: input.orgId,
      messageId: input.messageId,
      mailboxId: input.mailboxId,
      role: input.role,
      viaAliasId: input.viaAliasId,
      subaddressTag: input.subaddressTag,
    })
    .onConflictDoNothing();

  if (input.viaAliasId) {
    await db
      .update(mail.alias)
      .set({ lastUsedAt: new Date(input.sentAt ?? Date.now()) })
      .where(eq(mail.alias.id, input.viaAliasId));
  }

  await ensureThreadState(
    db,
    input.orgId,
    input.threadId,
    input.mailboxId,
    input.placement ?? INBOUND_PLACEMENT,
  );
}

/**
 * Ensure a thread_state exists for (thread, mailbox). A new one takes
 * policy.newThread. An existing archived one is pulled back to inbox only when
 * policy.unarchiveOnReply (inbound). spam/trash are always respected — a reply
 * doesn't resurrect what the user deliberately killed — and an outbound reply
 * never moves the thread at all.
 */
async function ensureThreadState(
  db: Db,
  orgId: string,
  threadId: string,
  mailboxId: string,
  policy: PlacementPolicy,
): Promise<void> {
  const existing = await db.query.threadState.findFirst({
    where: and(
      eq(schema.threadState.threadId, threadId),
      eq(schema.threadState.mailboxId, mailboxId),
    ),
    columns: { id: true, placement: true },
  });
  if (!existing) {
    await db
      .insert(mail.threadState)
      .values({ orgId, threadId, mailboxId, placement: policy.newThread })
      .onConflictDoNothing();
    return;
  }
  if (policy.unarchiveOnReply && existing.placement === "archived") {
    await db
      .update(mail.threadState)
      .set({ placement: "inbox" })
      .where(eq(mail.threadState.id, existing.id));
  }
}
