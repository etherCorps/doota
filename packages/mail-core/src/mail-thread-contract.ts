/**
 * The shared mail contract: DTO shapes (modeled on JMAP Email/Thread so a future
 * JMAP API is a thin mapping) + pure, DB-free helpers for threading, quote
 * stripping, and content-kind derivation. Pure so both the queue consumer and
 * unit tests use the exact same logic; DB-touching threading lives in the
 * consumer.
 */

// ---- Timeline (discriminated union) ------------------------------------------
// Only external_message renders this pass; the discriminator exists now so
// internal_note / system_event are an additive change, not a render rewrite.
export type TimelineItemType = "external_message" | "internal_note" | "system_event";

/** WhatsApp-style delivery ticks for an outbound message (Part H). */
export type SendTick = "clock" | "single" | "double" | "warning";

export type SubmissionState = {
  status: string;
  tick: SendTick;
  /** Why the send failed (preflight reason / provider error) — warning tick detail. */
  lastError: string | null;
  /** Per-recipient detail for multi-recipient sends (on demand in the UI). */
  perRecipient: { address: string; role: string; status: string; bounceType: string | null }[];
};

/**
 * Submission statuses that mean "this send went wrong" — the single source for
 * failure toasts (notifier), the failed-sends list (drafts), and any future
 * consumer. `canceled` is deliberately absent: a user cancel is not a failure.
 */
export const FAILED_SEND_STATUSES = ["failed", "bounced_hard", "bounced_soft", "complained"] as const;

/** Map a submission/recipient status onto a tick glyph. */
export function tickForStatus(status: string): SendTick {
  switch (status) {
    case "sent":
      return "single";
    case "delivered":
      return "double";
    case "bounced_hard":
    case "bounced_soft":
    case "complained":
    case "failed":
    case "canceled":
      return "warning";
    default:
      return "clock"; // draft_queued | queued | sending | scheduled
  }
}

export type MessageDTO = {
  type: "external_message";
  id: string;
  threadId: string;
  /** RFC Message-ID header — the reply target (send contract keys on this, not id). */
  messageIdHeader: string;
  from: string | null;
  /** Original visible recipients + Reply-To — the reply-all audience source. */
  to: string[];
  cc: string[];
  replyTo: string | null;
  sentAt: number | null;
  contentKind: "bubble" | "card";
  subject: string | null; // decrypted on read
  /** JMAP bodyValues analogue: stripped is the "reply", full is the original. */
  bodyStripped: string | null;
  bodyFull: string | null;
  /** Original HTML body, when present — render sandboxed (never raw). */
  bodyHtml: string | null;
  keywords: string[];
  isRead: boolean;
  viaAlias: string | null;
  /** Alias id the mail was delivered through — lets a reply default its From to
   * that alias (otherwise hide-my-email leaks the real address on first reply). */
  viaAliasId: string | null;
  attachments: { id: string; filename: string | null; contentType: string | null; size: number | null }[];
  /** Present only for outbound messages (this mailbox sent it). */
  submission?: SubmissionState;
};

/** A team-internal note in the timeline (Task 5). Never transmitted; visually
 * unmistakable from a message. body is null when soft-deleted (tombstone). */
export type NoteItem = {
  type: "internal_note";
  id: string;
  authorUserId: string | null;
  body: string | null;
  editedAt: number | null;
  deleted: boolean;
  at: number;
};

/** A quiet context chip (assignment/placement changed). Not a message. */
export type SystemEventItem = {
  type: "system_event";
  id: string;
  actorUserId: string | null;
  eventType: string;
  data: Record<string, unknown>;
  at: number;
};

export type TimelineItem = MessageDTO | NoteItem | SystemEventItem;

export type ThreadDTO = {
  id: string;
  subject: string | null;
  lastMessageAt: number | null;
  placement: string;
  isStarred: boolean;
  assigneeUserId: string | null;
  items: TimelineItem[];
};

// ---- Threading ---------------------------------------------------------------

/**
 * Normalize a subject for the weak same-org fallback: strip Re:/Fwd: prefixes and
 * collapse whitespace. NEVER the primary threading signal — In-Reply-To /
 * References win; subject only closes threads when headers are absent.
 */
export function normalizeSubject(subject: string | null | undefined): string {
  if (!subject) return "";
  return subject
    .replace(/^[ \t]*((re|fw|fwd|aw|sv)(\[\d+\])?:[ \t]*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Parse a References/In-Reply-To header into ordered, de-duped Message-IDs. */
export function parseReferences(header: string | null | undefined): string[] {
  if (!header) return [];
  const ids = header.match(/<[^>]+>/g) ?? [];
  return [...new Set(ids.map((s) => s.trim()))];
}

/**
 * The parent Message-ID for a reply: last of In-Reply-To, else last of
 * References. Cleartext metadata — no decryption needed.
 */
export function resolveParentMessageId(
  inReplyTo: string | null | undefined,
  references: string | null | undefined,
): string | null {
  const irt = parseReferences(inReplyTo);
  if (irt.length) return irt[irt.length - 1];
  const refs = parseReferences(references);
  return refs.length ? refs[refs.length - 1] : null;
}

/**
 * Every candidate parent Message-ID, newest first: In-Reply-To ids, then the
 * References chain reversed (last = closest ancestor). Threading tries each in
 * order — one unknown id (e.g. a provider-rewritten Message-ID we never saw)
 * must not orphan a reply when an older ancestor is still resolvable.
 */
export function candidateParentIds(
  inReplyTo: string | null | undefined,
  references: string | null | undefined,
): string[] {
  return [
    ...new Set([
      ...parseReferences(inReplyTo),
      ...parseReferences(references).reverse(),
    ]),
  ];
}

// ---- Quote stripping ---------------------------------------------------------

/**
 * Strip quoted history from a plain-text body, leaving just the new reply.
 * Heuristic (email-reply-parser-style): cut at the first "On … wrote:" attribution
 * or a run of `>` quote lines. Both stripped and full are stored, so this is
 * upgradeable — re-run against the R2 raw and every message improves.
 * ponytail: heuristic cut. Swap in the email-reply-parser lib if edge cases bite.
 */
export function stripQuotesText(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  const attribution =
    /^\s*(on\b.+\bwrote:|-{2,}\s*original message\s*-{2,}|_{5,}|from:\s.+)/i;
  for (const line of lines) {
    if (attribution.test(line)) break;
    if (/^\s*>/.test(line)) break;
    out.push(line);
  }
  const stripped = out.join("\n").trim();
  return stripped || body.trim();
}

/**
 * Strip quoted history from HTML: drop <blockquote> and Gmail/Outlook quote
 * containers. Regex-based so it runs in both Workers and node tests (no
 * HTMLRewriter dependency in the shared module).
 * ponytail: regex strip. If nested/exotic quoting leaks, move to HTMLRewriter in
 * the worker consumer and keep this as the test fallback.
 */
export function stripQuotesHtml(html: string): string {
  return html
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<div[^>]*(gmail_quote|yahoo_quoted|moz-cite-prefix)[^>]*>[\s\S]*?<\/div>/gi, "")
    .trim();
}

/** Crude HTML → text: drop tags + decode a few common entities. For search
 * tokens and a text fallback when a message is HTML-only. ponytail: good enough
 * for indexing; the raw HTML stays canonical in R2 for faithful rendering. */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- Outbound construction (Part E) ------------------------------------------

/**
 * Mint a Message-ID we own: `<uuid@domain>`. We own it so that if the message
 * reflects back to us (CC to a hosted address, a list), the inbound consumer
 * dedupes against the sender's copy via (org, message_id_header).
 */
export function mintMessageId(domain: string): string {
  return `<${crypto.randomUUID()}@${domain}>`;
}

/**
 * Threading headers for a reply. In-Reply-To is the parent's Message-ID;
 * References is the parent's References chain with the parent's own Message-ID
 * appended (RFC 5322). Returns empty for a new thread (no parent).
 */
export function threadingHeaders(parent: {
  messageIdHeader: string;
  references: string | null;
} | null): { "In-Reply-To"?: string; References?: string } {
  if (!parent) return {};
  const chain = [...parseReferences(parent.references), parent.messageIdHeader];
  return {
    "In-Reply-To": parent.messageIdHeader,
    References: [...new Set(chain)].join(" "),
  };
}

function formatQuoteAttribution(from: string | null, at: number | null): string {
  const when = at ? new Date(at).toUTCString() : "an earlier message";
  return `On ${when}, ${from ?? "someone"} wrote:`;
}

/**
 * Re-quote the parent into an outbound plain-text reply. Doota stores bodies
 * stripped, so replies leaving the instance must re-attach conventional quoted
 * history (`>`-prefixed) or external clients (Gmail/Outlook) lose context.
 */
export function buildQuotedText(
  newBody: string,
  parent: { from: string | null; sentAt: number | null; bodyFull: string | null },
): string {
  if (!parent.bodyFull) return newBody;
  const quoted = parent.bodyFull
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
  return `${newBody}\n\n${formatQuoteAttribution(parent.from, parent.sentAt)}\n${quoted}`;
}

/**
 * HTML variant: the new body followed by a <blockquote> of the parent — the
 * container inbound quote-stripping already recognizes, so a round-trip stays
 * symmetric.
 */
export function buildQuotedHtml(
  newHtml: string,
  parent: { from: string | null; sentAt: number | null; bodyFull: string | null },
): string {
  if (!parent.bodyFull) return newHtml;
  const esc = parent.bodyFull
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br>");
  return (
    `${newHtml}` +
    `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex;">` +
    `<p>${formatQuoteAttribution(parent.from, parent.sentAt)}</p>${esc}</blockquote>`
  );
}

// ---- Content kind ------------------------------------------------------------

/**
 * bubble vs card: short conversational replies render as chat bubbles; long or
 * rich/marketing mail renders as a card. Derived, never authoritative — raw is
 * truth, so this re-derives on demand.
 */
export function deriveContentKind(input: {
  strippedText: string;
  hasAttachments: boolean;
  htmlLength: number;
}): "bubble" | "card" {
  const len = input.strippedText.trim().length;
  if (input.hasAttachments) return "card";
  if (input.htmlLength > 4000) return "card";
  if (len > 0 && len <= 800) return "bubble";
  return "card";
}
