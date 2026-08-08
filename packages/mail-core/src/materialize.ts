// SPDX-License-Identifier: Apache-2.0
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { encryptContent, type ContentKey } from "./crypto";
import { plaintextIndex } from "./search-index";
import {
  candidateParentIds,
  deriveContentKind,
  htmlToText,
  normalizeSubject,
  stripHtmlTags,
  stripQuotesText,
  stripQuotesHtml,
  isRichHtml,
  hasRemoteHttpImages,
  isCidReferenced,
} from "./mail-thread-contract";

type Db = DrizzleD1Database<typeof schema>;

// Cap for the D1 text twins (chars, pre-encrypt). Generous — normal mail and
// reply quoting sit far under it; it only bounds pathological threads so the row
// can't blow the D1 size cap. Full text beyond this is served from R2 on render.
// ponytail: fixed cap, revisit if a real body legitimately exceeds it.
const MAX_D1_TEXT = 64_000;
const capText = (s: string | null): string | null =>
  s != null && s.length > MAX_D1_TEXT ? s.slice(0, MAX_D1_TEXT) : s;

/** Provider-agnostic parsed message — the consumer builds this from postal-mime. */
export type ParsedMessage = {
  messageIdHeader: string;
  inReplyTo: string | null;
  references: string | null;
  from: string | null;
  /** Sender's display name from the From header, if any (label only). */
  fromName?: string | null;
  /** Original visible recipients + Reply-To — for reply-all reconstruction. */
  to?: string[];
  cc?: string[];
  replyTo?: string | null;
  subject: string | null;
  sentAt: number | null;
  text: string | null;
  html: string | null;
  r2RawKey: string | null;
  /** Aligned DMARC pass at ingest (CF Authentication-Results). Drives the
   * verified-sender shield; absent ⇒ unverified (fail-closed). */
  dmarcPass?: boolean;
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
 * org within a 7-day window is the weak fallback only for a message that IS a
 * reply (has In-Reply-To/References) but whose ancestors we don't have stored;
 * a fresh compose never subject-merges. Cleartext metadata — no decryption.
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
  // Subject-fallback exists ONLY to rescue a genuine reply whose ancestor
  // Message-IDs we don't happen to have stored — so it must carry In-Reply-To
  // or References. A fresh compose (both absent) that merely shares a subject +
  // participant must start its own thread, else re-sent "welcome"/"testing"/
  // automated no-reply mail collapses into one polluted thread.
  const isReply = !!(parsed.inReplyTo || parsed.references);
  if (subjectNorm && isReply) {
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
  // Whether the receiving mailbox opts into the readable search index. A
  // non-indexed mailbox skips indexing; a message shared with an indexed mailbox
  // still gets indexed via that mailbox's job (the FTS row is per-message).
  searchIndexed = true,
): Promise<{ messageId: string; threadId: string }> {
  // Dedupe by header id — including the provider-minted wire id, so our own
  // message reflecting back (mailing list, CC to a hosted address) reuses the
  // sender's row instead of duplicating in the thread.
  const existing = await findMessageByHeaderId(db, orgId, parsed.messageIdHeader);
  if (existing) {
    // Converge attachments + search on re-run without duplicating the message.
    await writeAttachments(db, existing.id, parsed);
    await indexContent(db, existing.id, parsed, searchIndexed);
    return { messageId: existing.id, threadId: existing.threadId };
  }

  const threadId = await resolveThreadId(db, orgId, parsed);
  const strippedText = parsed.text ? stripQuotesText(parsed.text) : "";
  // htmlToText (line-preserving), not stripHtmlTags: an HTML-only message's text
  // twin renders as a plain-text bubble — flattening breaks reads as one run-on line.
  const bodyFull = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : null);
  const contentKind = deriveContentKind({
    strippedText,
    hasAttachments: parsed.attachments.length > 0,
    htmlLength: parsed.html?.length ?? 0,
  });
  // Render-decision flags computed ONCE at ingest (the DB stores decisions, not
  // the body): getThread reads these instead of decrypting the html per message
  // on every thread open. Same quote-stripped basis the body route renders on.
  const displayHtml = parsed.html ? stripQuotesHtml(parsed.html) : null;
  const htmlKind = displayHtml ? (isRichHtml(displayHtml) ? "rich" : "plain") : null;
  const hasRemoteImages = hasRemoteHttpImages(displayHtml);

  // The HTML body is NOT stored in D1 — it's derived from the raw MIME in R2
  // (r2RawKey) on render (golden-standard: raw is canonical, large derived
  // bodies aren't duplicated into the hot DB). Only the small text twins
  // (stripped for list/search preview, full for reply quoting) live here — and
  // they are CAPPED: a pathologically long plain-text thread would otherwise
  // grow the D1 row past its size cap and fail the insert (silent mail loss).
  // Full-fidelity text for such a message is served from R2 raw on render
  // (rawObjectToText), same as the HTML body — the cap only bounds the preview.
  const [subjectEnc, strippedEnc, fullEnc] = await Promise.all([
    encryptContent(deps.ck, parsed.subject),
    encryptContent(deps.ck, capText(strippedText || bodyFull)),
    encryptContent(deps.ck, capText(bodyFull)),
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
      fromName: parsed.fromName ?? null,
      toAddrs: JSON.stringify(parsed.to ?? []),
      ccAddrs: JSON.stringify(parsed.cc ?? []),
      replyTo: parsed.replyTo,
      sentAt: parsed.sentAt ? new Date(parsed.sentAt) : null,
      r2RawKey: parsed.r2RawKey,
      itemType: "external_message",
      contentKind,
      htmlKind,
      hasRemoteImages,
      dmarcPass: parsed.dmarcPass ?? false,
      subjectEnc,
      bodyStrippedEnc: strippedEnc,
      bodyFullEnc: fullEnc,
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
  await indexContent(db, row.id, parsed, searchIndexed);
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
  // Whether each part is referenced by a cid: in the (quote-stripped) body — the
  // "inline" flag getThread used to derive from the html; computed once here so
  // the read path doesn't need the body. Same basis the body route renders on.
  const displayHtml = parsed.html ? stripQuotesHtml(parsed.html) : null;
  const rows = parsed.attachments.map((a) => ({
    messageId,
    partId: a.partId,
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
    r2Key: a.r2Key,
    inline: isCidReferenced(displayHtml, a.partId),
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
  parsed: ParsedMessage,
  searchIndexed: boolean,
): Promise<void> {
  // Per-mailbox escape valve: a non-indexed mailbox's mail never enters the
  // readable index (skip = no-op; never removes another mailbox's index row).
  if (!searchIndexed) return;
  // Index the PLAINTEXT subject + STRIPPED body (not the quoted trail — no point
  // re-indexing the same quote on every reply). Participant/date/flag filters are
  // handled as query operators over plaintext columns, not FTS.
  const strippedText = parsed.text ? stripQuotesText(parsed.text) : "";
  const body = strippedText || (parsed.html ? stripHtmlTags(stripQuotesHtml(parsed.html)) : "");
  await plaintextIndex(db).index({ messageId, subject: parsed.subject ?? "", body });
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
    /** Rules engine: markRead/markFlagged land AT INSERT (both is_read and
     * keywords, kept consistent) — an insert-then-update would burn a second
     * change_log seq per delivery. */
    isRead?: boolean;
    keywords?: string[];
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
      ...(input.isRead !== undefined ? { isRead: input.isRead } : {}),
      ...(input.keywords ? { keywords: JSON.stringify(input.keywords) } : {}),
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
    input.role,
    input.sentAt ?? Date.now(),
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
  role: "to" | "cc" | "bcc" | "from",
  sentAtMs: number,
): Promise<void> {
  // last_activity_at bumps on ANY delivery (own sends bump the sort); last_inbound_at
  // only on a recipient-role delivery (an own send must not mark a thread unread).
  const inbound = role !== "from";
  const existing = await db.query.threadState.findFirst({
    where: and(
      eq(schema.threadState.threadId, threadId),
      eq(schema.threadState.mailboxId, mailboxId),
    ),
    columns: { id: true, placement: true, snoozedUntil: true, muted: true, placementOrigin: true },
  });
  if (!existing) {
    await db
      .insert(mail.threadState)
      .values({
        orgId,
        threadId,
        mailboxId,
        placement: policy.newThread,
        lastActivityAt: new Date(sentAtMs),
        lastInboundAt: inbound ? new Date(sentAtMs) : null,
      })
      .onConflictDoNothing();
    return;
  }
  // Monotonic bump (a redelivered/out-of-order job can't move a timestamp back),
  // plus the placement change in the same write.
  const set: Record<string, unknown> = {
    lastActivityAt: sql`MAX(COALESCE(${mail.threadState.lastActivityAt}, 0), ${sentAtMs})`,
  };
  if (inbound) {
    set.lastInboundAt = sql`MAX(COALESCE(${mail.threadState.lastInboundAt}, 0), ${sentAtMs})`;
    // A new inbound reply wakes a snoozed thread early (Gmail semantics): clearing
    // snoozedUntil returns it to the inbox, and the recency bumps above put it at
    // the top, unread. Only when actually snoozed — SQLite's `UPDATE OF` fires on
    // a watched column merely APPEARING in SET, and this write runs on every
    // inbound delivery; an unconditional null would burn a change_log seq each time.
    if (existing.snoozedUntil != null) set.snoozedUntil = null;
  }
  // Resurfacing on a new reply follows placement_origin (build guide, Phase 1):
  //   user/default archived → back to inbox (the reply needs attention);
  //   rule-filed → stays put (the user expressed a standing intent — Phase 2
  //   re-evaluates rules and re-files);
  //   muted → stays put regardless (chat mute semantics; notify.ts keeps it
  //   silent). Origin itself is NOT reset — a user-filed thread stays sticky
  //   against rules even after it resurfaces.
  if (
    policy.unarchiveOnReply &&
    existing.placement === "archived" &&
    !existing.muted &&
    existing.placementOrigin !== "rule"
  ) {
    set.placement = "inbox";
  }
  await db.update(mail.threadState).set(set).where(eq(mail.threadState.id, existing.id));
}
