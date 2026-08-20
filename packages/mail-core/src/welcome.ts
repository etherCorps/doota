// A welcome message seeded into a brand-new personal mailbox.
//
// It is a REAL message, not a fabricated row: we synthesize RFC822, encrypt it
// into R2 and enqueue an InboundJob — exactly the two steps handleEmail()
// performs for mail arriving off the wire. Everything downstream then comes
// free and un-special-cased: threading, the search index, a change_log seq the
// local-first mirror can see, export at raw-MIME fidelity, and the ability to
// archive or delete it like anything else.
//
// Inserting D1 rows directly would have been shorter and wrong — export would
// emit an mbox entry with no raw behind it, and every read path would need an
// "is this the synthetic one" branch.
import { putEncryptedBlob, type ContentKey } from "./crypto.js";
import type { InboundJob } from "./inbound-worker.js";

/** Stable per mailbox, so a retried provision converges instead of duplicating.
 * Materialize dedupes on the header id (findMessageByHeaderId) and the R2 put
 * is keyed off it, so the whole seed is idempotent end to end. */
export function welcomeMessageId(mailboxId: string, domain: string): string {
  return `<welcome.${mailboxId}@${domain}>`;
}

export type WelcomeInput = {
  /** The new mailbox's own address — the recipient. */
  address: string;
  /** Display name of the person, when we know one. */
  displayName?: string | null;
  /** Sender address; the org's own (senderAddress(db, org.domain).email). */
  from: string;
  /** Display name for the From header; defaults to "Doota". */
  fromName?: string | null;
  /** App base URL, for the links in the body. */
  appOrigin: string;
  mailboxId: string;
  sentAt?: Date;
};

const CRLF = "\r\n";

function rfc2822Date(date: Date): string {
  // toUTCString() is "Wed, 12 Aug 2026 05:23:46 GMT" — RFC 2822 wants "+0000"
  // in place of the obsolete "GMT" zone name.
  return date.toUTCString().replace(/GMT$/, "+0000");
}

/** Strip CR/LF out of a header value — same guard export.ts uses. Addresses
 * reach here already validated, but a header builder that can be folded is a
 * header-injection primitive waiting for the one caller that isn't. */
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

/** Escape for interpolation into the HTML part. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The RFC822 source of the welcome message: multipart/alternative so it renders
 * as a rich message (which is itself part of the demo) with an honest plain-text
 * twin — the twin is what gets quote-stripped, indexed, and shown as the list
 * preview, so it carries the same words rather than a stub.
 */
export function buildWelcomeRaw(input: WelcomeInput): { raw: string; messageId: string } {
  const domain = input.address.split("@")[1] ?? "localhost";
  const messageId = welcomeMessageId(input.mailboxId, domain);
  const date = input.sentAt ?? new Date();
  const greeting = input.displayName ? `Hi ${input.displayName},` : "Hi,";
  const origin = input.appOrigin.replace(/\/$/, "");
  // Boundary is derived, not random: the raw bytes must be identical across a
  // retried provision or the idempotent R2 put stops being idempotent.
  const boundary = `=_doota_welcome_${input.mailboxId}`;

  const lines = [
    `${greeting}`,
    ``,
    `This is ${input.address} — your address on this Doota. Anything sent here lands in this inbox.`,
    ``,
    `A few things that aren't obvious:`,
    ``,
    `* Conversations, not messages. You're reading one right now — every reply joins this same timeline instead of landing as a separate row.`,
    `* Folders are labels. Moving a conversation replaces its labels and takes it out of the inbox; adding a label leaves it where it is.`,
    `* Press ? anywhere for the keyboard shortcuts, and Cmd-K (Ctrl-K) to search.`,
    `* Your mail is yours. Settings has an export that produces a standard mbox file, with nothing held back.`,
    ``,
    `Doota generated this message locally when your mailbox was created — nobody sent it, and it never crossed the network. Archive or delete it whenever you like.`,
    ``,
    `Open the app: ${origin}/app`,
  ];
  const text = lines.join("\n");

  const html = [
    `<!doctype html><html><body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">`,
    `<p>${esc(greeting)}</p>`,
    `<p>This is <strong>${esc(input.address)}</strong> — your address on this Doota. Anything sent here lands in this inbox.</p>`,
    `<p>A few things that aren't obvious:</p>`,
    `<ul>`,
    `<li><strong>Conversations, not messages.</strong> You're reading one right now — every reply joins this same timeline instead of landing as a separate row.</li>`,
    `<li><strong>Folders are labels.</strong> Moving a conversation replaces its labels and takes it out of the inbox; adding a label leaves it where it is.</li>`,
    `<li><strong>Press <code>?</code></strong> anywhere for the keyboard shortcuts, and <code>Cmd-K</code> (<code>Ctrl-K</code>) to search.</li>`,
    `<li><strong>Your mail is yours.</strong> Settings has an export that produces a standard mbox file, with nothing held back.</li>`,
    `</ul>`,
    `<p style="color:#666;font-size:13px">Doota generated this message locally when your mailbox was created — nobody sent it, and it never crossed the network. Archive or delete it whenever you like.</p>`,
    `<p><a href="${esc(origin)}/app">Open the app</a></p>`,
    `</body></html>`,
  ].join("");

  const raw =
    `Message-ID: ${messageId}${CRLF}` +
    `Date: ${rfc2822Date(date)}${CRLF}` +
    `From: ${headerValue(input.fromName || "Doota")} <${headerValue(input.from)}>${CRLF}` +
    `To: ${headerValue(input.address)}${CRLF}` +
    `Subject: Welcome to Doota${CRLF}` +
    // Marks the message as machine-generated so a vacation responder (ours or a
    // forwarding destination's) never answers it. RFC 3834.
    `Auto-Submitted: auto-generated${CRLF}` +
    `MIME-Version: 1.0${CRLF}` +
    `Content-Type: multipart/alternative; boundary="${boundary}"${CRLF}` +
    CRLF +
    `--${boundary}${CRLF}` +
    `Content-Type: text/plain; charset=utf-8${CRLF}${CRLF}` +
    text.replace(/\n/g, CRLF) +
    CRLF +
    `--${boundary}${CRLF}` +
    `Content-Type: text/html; charset=utf-8${CRLF}${CRLF}` +
    html +
    CRLF +
    `--${boundary}--${CRLF}`;

  return { raw, messageId };
}

type SeedEnv = {
  MAIL_RAW: R2Bucket;
  MAIL_QUEUE: Queue<InboundJob>;
};

/**
 * Stage the welcome message and hand it to the inbound queue. Mirrors
 * handleEmail(): encrypted R2 put on a content-stable key, then enqueue.
 *
 * The caller owns failure policy — a mailbox without its welcome message is a
 * cosmetic loss, so provisioning should log and carry on rather than fail the
 * account over it.
 */
export async function seedWelcomeMessage(
  env: SeedEnv,
  ck: ContentKey,
  input: WelcomeInput & { orgId: string },
): Promise<void> {
  const { raw, messageId } = buildWelcomeRaw(input);
  const r2RawKey = `raw/${input.orgId}/${safeKey(messageId)}`;

  await putEncryptedBlob(env.MAIL_RAW, r2RawKey, ck, raw, {
    httpMetadata: { contentType: "application/octet-stream" },
  });

  await env.MAIL_QUEUE.send({
    r2RawKey,
    recipient: input.address,
    orgId: input.orgId,
    resolvedMailboxId: input.mailboxId,
    viaAliasId: null,
    subaddressTag: null,
    envelopeFrom: input.from,
    messageIdHeader: messageId,
    // Not a claim we can honestly make: no DMARC evaluation happened. Left
    // false/null so the message renders without a Verified chip. The classifier
    // only junks on an *explicit* dmarc=fail, so absent auth is neutral, not spam.
    dmarcPass: false,
    authResults: null,
  });
}

/** Same shape handleEmail uses to key R2 off a Message-ID. */
function safeKey(messageIdHeader: string): string {
  return messageIdHeader.replace(/[^a-zA-Z0-9._@-]/g, "_").slice(0, 200);
}
