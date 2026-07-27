// SPDX-License-Identifier: Apache-2.0
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
  id: string;
  status: string;
  tick: SendTick;
  /** Why the send failed (preflight reason / provider error) — warning tick detail. */
  lastError: string | null;
  /** Reader authored this send — shows the Retry affordance (server re-checks). */
  mine: boolean;
  /** Per-recipient detail for multi-recipient sends (on demand in the UI). */
  perRecipient: { address: string; role: string; status: string; bounceType: string | null }[];
};

/**
 * Submission statuses that mean "this send went wrong" — the single source for
 * failure toasts (notifier), the failed-sends list (drafts), and any future
 * consumer. `canceled` is deliberately absent: a user cancel is not a failure.
 */
export const FAILED_SEND_STATUSES = ["failed", "bounced_hard", "bounced_soft", "complained"] as const;

/**
 * Failed sends that a retry can actually help. A hard bounce / complaint is
 * PERMANENT — the address is suppressed on receipt, so re-sending just bounces
 * again (or is blocked at preflight). Only a transient failure or a soft bounce
 * is worth another attempt. Drives the retry affordance + the server guard.
 */
export const RETRYABLE_SEND_STATUSES = ["failed", "bounced_soft"] as const;

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
  /** Sender's display name from the From header (label only; `from` is identity). */
  fromName: string | null;
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
  /** How to render: `rich` → the sandboxed /api/messages/[id]/body frame, `plain`
   * → the text bubble, null → no HTML. Raw HTML never leaves the server. */
  htmlKind: "rich" | "plain" | null;
  /** The HTML references remote http(s) images — drives the "Load images" opt-in. */
  hasRemoteImages: boolean;
  /** Reader auto-loads remote images from this sender ("always load" trust). */
  senderTrusted?: boolean;
  keywords: string[];
  isRead: boolean;
  /** True when the VIEWING mailbox sent this message (it holds the `from`
   * receipt). Drives which side a bubble renders on — presence of `submission`
   * is NOT enough: a colleague's send in a shared thread carries one too. */
  outbound: boolean;
  viaAlias: string | null;
  /** Alias id the mail was delivered through — lets a reply default its From to
   * that alias (otherwise hide-my-email leaks the real address on first reply). */
  viaAliasId: string | null;
  /** partId carries the MIME contentId for inline parts — the `cid:` target.
   * `inline` = referenced by the HTML via cid: (renders in the body, so it's not
   * listed as a separate download). */
  attachments: { id: string; partId: string | null; filename: string | null; contentType: string | null; size: number | null; inline: boolean }[];
  /** Present only for outbound messages (this mailbox sent it). */
  submission?: SubmissionState;
  /** Context for a reply's parent message.
   *  - `parentId` set → the parent IS visible in this timeline: `text` is a
   *    one-line preview and the UI links to it (jump to the original).
   *  - `parentId` null → this (personal) mailbox can't see the parent (added on
   *    Cc): `text` is the FULL parent body, so context is never half-shown.
   * Absent when the parent is the message directly above (redundant). */
  replyContext?: {
    from: string | null;
    sentAt: number | null;
    parentId: string | null;
    text: string;
    /** Older hidden ancestors beyond the immediate parent (added-on-Cc case),
     * oldest first — rendered as stacked "earlier" blocks above the parent. */
    ancestors?: { from: string | null; sentAt: number | null; text: string }[];
  };
  /** A calendar invite (iMIP) carried by this message — decrypted + hydrated in
   * read.ts from calendar_event, with the viewer's local RSVP folded in. Drives
   * the themed invite card instead of a raw .ics download. */
  calendarInvite?: CalendarInviteDTO;
};

/** Yes/no/maybe for the invite card — local status; matches calendar_rsvp.status. */
export type InviteRsvpStatus = "accepted" | "declined" | "tentative";

/** Decrypted invite for the wire (mirrors mail-core/calendar.ts ParsedInvite +
 * the viewer's local RSVP). Times are UTC ms; `tz` labels the event's own zone
 * for display when it wasn't a bare UTC value. */
export type CalendarInviteDTO = {
  uid: string;
  method: string; // REQUEST | REPLY | CANCEL | PUBLISH
  status: string | null; // CONFIRMED | CANCELLED | TENTATIVE
  summary: string | null;
  description: string | null;
  location: string | null;
  startMs: number;
  endMs: number | null;
  tz: string | null;
  allDay: boolean;
  organizer: { email: string | null; name: string | null };
  attendees: { email: string; name: string | null; partstat: string | null }[];
  meetingPlatform: "zoom" | "teams" | "meet" | "webex" | null;
  calOrigin: "google" | "microsoft" | "apple" | "other" | null;
  joinUrl: string | null;
  rsvpLinks: { accepted: string | null; declined: string | null; tentative: string | null };
  /** The viewer's own recorded answer (local; organizer not notified). */
  myRsvp: InviteRsvpStatus | null;
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
 * Strip quoted history from HTML. Top-posting assumption (symmetric with
 * stripQuotesText): everything from the first quote container — a <blockquote>
 * or a Gmail/Yahoo/Thunderbird quote div — to the end is history, so cut there.
 * This handles NESTED quoting (reply-to-reply-to-reply) for free: a non-greedy
 * regex stops at the first inner </blockquote> or </div> and leaks the wrapper,
 * and the containers nest arbitrarily so no single regex balances them. Regex
 * only locates the first marker, so this still runs in both Workers and node.
 * ponytail: top-post cut. If interleaved/bottom-posted replies must keep their
 * post-quote tail, swap in a depth-counting scanner — bodyFull stays canonical.
 */
export function stripQuotesHtml(html: string): string {
  const marker = /<blockquote\b|<div[^>]*(?:gmail_quote|yahoo_quoted|moz-cite-prefix)/i;
  const at = html.search(marker);
  return (at === -1 ? html : html.slice(0, at)).trim();
}

/**
 * HTML → text PRESERVING line structure: block-closing tags and <br> become
 * newlines, only spaces/tabs collapse. Use for a body that gets RENDERED as a
 * plain-text bubble (composer output, HTML-only inbound) — stripHtmlTags flattens
 * every break into one space, which reads as a single run-on line. Runs in
 * Workers + node (no DOM).
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ") // collapse spaces/tabs, NOT newlines
    .replace(/[ \t]*\n[ \t]*/g, "\n") // trim padding around each break
    .replace(/\n{3,}/g, "\n\n") // cap runaway blank-line runs at one
    .trim();
}

/**
 * Is this HTML a "template" (newsletter / marketing / rich transactional) rather
 * than plain conversational content? Drives render: rich → sandboxed HTML frame
 * (faithful), normal → plain-text bubble (chatty, uses the line-preserving text
 * twin). bodyHtml presence can't decide it — our composer wraps even a one-line
 * reply in <p> — so we look for STRUCTURE/STYLING our replies never emit.
 *
 * Biased toward rich: a false positive just renders faithfully in the frame
 * (harmless); a false negative flattens a real template to text (the bug). Our
 * Tiptap output (<p>/<strong>/<em>/<u>/<a>/<br>) has no rich tag and no inline
 * style, so simple replies stay bubbles.
 * ponytail: tag/attr heuristic. If a real template slips through as text, add its
 * signal here (or swap to a DOM walk) — no re-materialize needed, it's render-time.
 */
export function isRichHtml(html: string): boolean {
  return (
    /<(img|table|thead|tbody|tr|td|th|ul|ol|li|h[1-6]|hr|button|blockquote|figure|video|iframe|style|font|center)\b/i.test(
      html,
    ) || /\sstyle\s*=/i.test(html)
  );
}

/** The HTML references at least one remote http(s) image (a tracking-pixel shape). */
export function hasRemoteHttpImages(html: string | null | undefined): boolean {
  return !!html && /\bsrc\s*=\s*["']?https?:\/\//i.test(html);
}

/** The HTML references this MIME part inline via `cid:` (angle brackets optional). */
export function isCidReferenced(html: string | null | undefined, partId: string | null): boolean {
  if (!html || !partId) return false;
  return html.includes(`cid:${partId.replace(/^<|>$/g, "")}`);
}

/**
 * Prefix a reply/forward subject the way every mail client expects — `Re:` for a
 * reply, `Fwd:` for a forward — WITHOUT stacking (a reply to "Re: hi" stays
 * "Re: hi", not "Re: Re: hi"). Empty base stays empty (a no-subject thread's
 * reply carries no subject rather than a bare "Re:").
 */
export function replySubject(base: string | null | undefined, kind: string): string {
  const bare = (base ?? "").replace(/^[ \t]*((re|fwd|fw|aw|sv)(\[\d+\])?:[ \t]*)+/i, "").trim();
  if (!bare) return "";
  return `${kind === "forward" ? "Fwd" : "Re"}: ${bare}`;
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
  const ids = [...new Set([...parseReferences(parent.references), parent.messageIdHeader])];
  // Cloudflare rejects header values over 2,048 bytes (E_HEADER_VALUE_TOO_LONG,
  // permanent) — a deep thread must not hard-fail the send. RFC convention when
  // trimming: keep the root plus the recent tail, drop the middle.
  while (ids.length > 2 && ids.join(" ").length > 1900) ids.splice(1, 1);
  return {
    "In-Reply-To": parent.messageIdHeader,
    References: ids.join(" "),
  };
}

function formatQuoteAttribution(from: string | null, at: number | null): string {
  const when = at ? new Date(at).toUTCString() : "an earlier message";
  return `On ${when}, ${from ?? "someone"} wrote:`;
}

export type QuotedParent = { from: string | null; sentAt: number | null; bodyFull: string | null };

/**
 * Re-quote the ancestor chain into an outbound plain-text reply. Doota stores
 * bodies stripped, so replies leaving the instance must re-attach conventional
 * quoted history (`>`-prefixed) or external clients (Gmail/Outlook) lose
 * context. `parents` is newest-first (immediate parent at index 0); nesting
 * folds oldest→newest so each older hop gains one more `>` level — the same
 * accumulated shape Gmail puts on the wire.
 */
export function buildQuotedText(newBody: string, parents: QuotedParent[]): string {
  let acc = "";
  for (const p of [...parents].reverse()) {
    if (!p.bodyFull) continue;
    const inner = acc ? `${p.bodyFull}\n\n${acc}` : p.bodyFull;
    acc =
      `${formatQuoteAttribution(p.from, p.sentAt)}\n` +
      inner
        .split(/\r?\n/)
        .map((l) => `> ${l}`)
        .join("\n");
  }
  return acc ? `${newBody}\n\n${acc}` : newBody;
}

/**
 * HTML variant: the new body followed by nested <blockquote>s of the chain —
 * the container inbound quote-stripping already recognizes, so a round-trip
 * stays symmetric (the whole chain strips as one quote).
 */
export function buildQuotedHtml(newHtml: string, parents: QuotedParent[]): string {
  let acc = "";
  for (const p of [...parents].reverse()) {
    if (!p.bodyFull) continue;
    const esc = p.bodyFull
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\r?\n/g, "<br>");
    acc =
      `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex;">` +
      `<p>${formatQuoteAttribution(p.from, p.sentAt)}</p>${esc}${acc}</blockquote>`;
  }
  return acc ? `${newHtml}${acc}` : newHtml;
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
