// SPDX-License-Identifier: Apache-2.0
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import PostalMime from "postal-mime";
import * as schema from "@doota/db/schema";
import { importKey, encryptContent, type ContentKey } from "./crypto";
import { materializeMessage, materializeDelivery, type ParsedMessage } from "./materialize";
import { parseIcs, extractRsvpLinks, findCalendarPart } from "./calendar";
import { looksLikeBounce, parseBounce, applyBounce, isDeliveryReport } from "./bounce";
import { notifyInboundMail, notifySubmissionState } from "./events-hub";
import { sendGrantUserIds } from "./mailbox";
import { recordNewMail } from "./notify";
import { recordCorrespondents } from "./contacts";
import { log, errInfo, tryLog } from "./log";
import type { InboundJob, MailEnv } from "./inbound-worker";

/**
 * Inbound queue consumer — the heavy, idempotent work. Fetch raw from R2, parse
 * MIME with postal-mime (Workers-compatible, NOT Node mailparser), then upsert
 * message / delivery / thread_state through the shared materialize seam. Every
 * step is safe to re-run: a redelivered job converges, never duplicates, so on
 * any error we retry the whole job rather than half-commit.
 */

type PMAddress = { address?: string; name?: string };
type PMParsed = {
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  from?: PMAddress;
  to?: PMAddress[];
  cc?: PMAddress[];
  replyTo?: PMAddress[];
  subject?: string;
  date?: string;
  text?: string;
  html?: string;
  attachments?: PMAttachment[];
};
type PMAttachment = {
  filename?: string;
  mimeType?: string;
  content?: ArrayBuffer | string;
  contentId?: string;
  disposition?: "attachment" | "inline" | null;
  related?: boolean;
};

function addrList(list: PMAddress[] | undefined): string[] {
  return (list ?? []).map((a) => (a.address ?? "").trim().toLowerCase()).filter(Boolean);
}

/**
 * A MIME part is a real attachment only if it has a filename, or a Content-ID
 * (a `cid:`-referenced inline image), or `Content-Disposition: attachment`.
 * Everything else is a BODY representation — most importantly a `text/calendar`
 * (or any other) part sitting in a `multipart/alternative`, which postal-mime
 * surfaces in `attachments` but which must never become a phantom download.
 * postal-mime already lifts the chosen text/plain + text/html out into
 * `parsed.text`/`parsed.html`, so this only ever drops non-body alternatives.
 */
export function isRealAttachment(a: {
  filename?: string | null;
  contentId?: string;
  disposition?: "attachment" | "inline" | null;
}): boolean {
  return !!a.filename || !!a.contentId || a.disposition === "attachment";
}
function realAttachments(parsed: PMParsed): PMAttachment[] {
  return (parsed.attachments ?? []).filter(isRealAttachment);
}

/** Strip a +tag from the recipient so it matches the visible header addresses. */
export function baseAddress(address: string, tag: string | null): string {
  if (!tag) return address.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at).replace(`+${tag}`, "");
  return `${local}${address.slice(at)}`.trim().toLowerCase();
}

/**
 * Role of THIS recipient: visible in To → to, in Cc → cc, else the envelope
 * recipient isn't in any visible header, which means it was Bcc'd. Bcc therefore
 * exists ONLY as a delivery row, never back in the stored message headers.
 */
export function deriveRole(parsed: PMParsed, recipientBase: string): "to" | "cc" | "bcc" {
  if (addrList(parsed.to).includes(recipientBase)) return "to";
  if (addrList(parsed.cc).includes(recipientBase)) return "cc";
  return "bcc";
}

function toParsedMessage(parsed: PMParsed, job: InboundJob): ParsedMessage {
  const messageIdHeader =
    parsed.messageId?.trim() || job.messageIdHeader || `generated:${job.r2RawKey}`;
  const sentAt = parsed.date ? Date.parse(parsed.date) || null : null;
  return {
    messageIdHeader,
    inReplyTo: parsed.inReplyTo ?? null,
    references: parsed.references ?? null,
    from: parsed.from?.address ?? job.envelopeFrom ?? null,
    fromName: parsed.from?.name?.trim() || null,
    to: addrList(parsed.to),
    cc: addrList(parsed.cc),
    replyTo: parsed.replyTo?.[0]?.address?.trim().toLowerCase() ?? null,
    subject: parsed.subject ?? null,
    sentAt,
    text: parsed.text ?? null,
    html: parsed.html ?? null,
    r2RawKey: job.r2RawKey,
    // r2Key is filled by stageInboundAttachments before materialize — a null
    // key means an empty/unreadable part, and stays undownloadable. Only REAL
    // attachments (not body-alternative parts like a bare text/calendar) — see
    // isRealAttachment. Staging applies the same filter so indices stay aligned.
    attachments: realAttachments(parsed).map((a, i) => ({
      partId: a.contentId ?? String(i),
      filename: a.filename ?? null,
      contentType: a.mimeType ?? null,
      size: typeof a.content === "string" ? a.content.length : (a.content?.byteLength ?? null),
      r2Key: null,
    })),
  };
}

/**
 * Give each attachment its own R2 object and stamp the key onto the parsed
 * message. The raw MIME stays canonical, but nothing re-parses it at read
 * time: the download endpoint and outbound forwarding both stream per-part
 * keys — without this, inbound attachments 404 and forwards drop them.
 */
async function stageInboundAttachments(
  env: MailEnv,
  orgId: string,
  parsed: PMParsed,
  pm: ParsedMessage,
): Promise<void> {
  const parts = realAttachments(parsed); // same filter + order as toParsedMessage
  for (let i = 0; i < pm.attachments.length; i++) {
    const content = parts[i]?.content;
    if (content == null) continue;
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const key = `attachments/${orgId}/${crypto.randomUUID()}`;
    await env.MAIL_RAW.put(key, bytes, {
      httpMetadata: { contentType: pm.attachments[i].contentType ?? "application/octet-stream" },
    });
    pm.attachments[i].r2Key = key;
  }
}

/**
 * Parse any calendar part on the message and persist a calendar_event row.
 * Structural fields stay cleartext; the sensitive free-text (summary/location/
 * description/joinUrl/rsvpLinks) is encrypted into details_enc with the same DEK
 * as the subject/body. Idempotent: unique on message_id, so a redelivered job
 * no-ops. Never throws into the delivery path — a malformed invite must not lose
 * the mail (it still lands as a normal message with its .ics attachment).
 */
async function persistInvite(
  db: ReturnType<typeof drizzle<typeof schema>>,
  ck: ContentKey,
  orgId: string,
  messageId: string,
  parsed: PMParsed,
): Promise<void> {
  try {
    const raw = findCalendarPart(parsed.attachments);
    if (!raw) return;
    const inv = parseIcs(raw);
    if (!inv) return;
    const rsvpLinks = extractRsvpLinks(parsed.html);
    const detailsEnc = await encryptContent(
      ck,
      JSON.stringify({
        summary: inv.summary,
        description: inv.description,
        location: inv.location,
        joinUrl: inv.joinUrl,
        rsvpLinks,
      }),
    );
    await db
      .insert(schema.calendarEvent)
      .values({
        orgId,
        messageId,
        uid: inv.uid,
        method: inv.method,
        sequence: inv.sequence,
        status: inv.status,
        startMs: inv.startMs,
        endMs: inv.endMs,
        tz: inv.tz,
        allDay: inv.allDay,
        organizerEmail: inv.organizer.email,
        organizerName: inv.organizer.name,
        attendeesJson: JSON.stringify(inv.attendees),
        meetingPlatform: inv.meetingPlatform,
        calOrigin: inv.calOrigin,
        detailsEnc,
      })
      .onConflictDoNothing({ target: schema.calendarEvent.messageId });
  } catch (e) {
    log.warn("in.invite_parse_failed", { messageId, ...errInfo(e) });
  }
}

type QueueBatch = { messages: { body: InboundJob; ack(): void; retry(): void }[] };

export async function handleQueue(batch: QueueBatch, env: MailEnv): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const ck = await importKey(env.MAIL_DEK);
  const deps = { ck, searchKeyB64: env.MAIL_SEARCH_KEY };

  for (const m of batch.messages) {
    const job = m.body;
    try {
      const obj = await env.MAIL_RAW.get(job.r2RawKey);
      if (!obj) {
        // Raw is gone (already processed + swept, or never landed). Nothing to
        // reconstruct — ack so the job doesn't retry forever.
        m.ack();
        continue;
      }
      const buf = await obj.arrayBuffer();
      const parsed = (await PostalMime.parse(buf)) as PMParsed;

      // Bounce/complaint short-circuit (Part F): a DSN routed to our return-path
      // must update submission state + suppressions, NEVER land in an inbox.
      const rp = await db.query.orgMailSettings.findFirst({
        where: eq(schema.orgMailSettings.orgId, job.orgId),
        columns: { returnPathDomain: true },
      });
      if (
        looksLikeBounce({
          envelopeFrom: job.envelopeFrom,
          fromAddress: parsed.from?.address ?? null,
          subject: parsed.subject ?? null,
          recipient: job.recipient,
          returnPathDomain: rp?.returnPathDomain ?? null,
        })
      ) {
        // The heuristic said "bounce" — but only DROP if the DSN body actually
        // parses to a failure/complaint. A mail that merely LOOKS like a bounce
        // (subject regex, or addressed to the return-path subdomain) with no
        // parseable failures is a real reply that tripped the heuristic — deliver
        // it instead of eating it silently (the historical misclassification bug).
        const rawText = new TextDecoder().decode(buf);
        // DROP only a STRUCTURAL report (multipart/report). A real reply that
        // merely quotes a bounce is text/* — parseable failures alone must not
        // eat it. Non-report bounces still update state via the primary event path.
        const bounce = parseBounce(rawText);
        if (isDeliveryReport(rawText) && (bounce.failures.length > 0 || bounce.isComplaint)) {
          // DSN fallback path (structured event subscriptions are primary; a DSN
          // that slips through still updates state and wakes the user's stream —
          // client-side dedupe absorbs any double notification).
          const applied = await applyBounce(db, job.orgId, bounce, { hub: env.MAIL_EVENTS, push: env });
          if (applied.matchedSubmission && applied.worstStatus) {
            await notifySubmissionState(db, env.MAIL_EVENTS, applied.matchedSubmission, applied.worstStatus);
          }
          log.warn("in.bounce_classified", {
            r2Key: job.r2RawKey,
            recipient: job.recipient,
            envelopeFrom: job.envelopeFrom,
            from: parsed.from?.address ?? null,
            subject: parsed.subject ?? null,
            returnPathDomain: rp?.returnPathDomain ?? null,
            matchedSubmission: applied.matchedSubmission ?? null,
          });
          m.ack();
          continue;
        }
        // Looked like a bounce, wasn't one — log the averted drop and fall through
        // to normal delivery. Watch this to tune looksLikeBounce if it fires often.
        log.warn("in.bounce_false_positive", {
          r2Key: job.r2RawKey,
          recipient: job.recipient,
          envelopeFrom: job.envelopeFrom,
          from: parsed.from?.address ?? null,
          subject: parsed.subject ?? null,
          returnPathDomain: rp?.returnPathDomain ?? null,
        });
      }

      const pm = toParsedMessage(parsed, job);
      await stageInboundAttachments(env, job.orgId, parsed, pm);

      const { messageId, threadId } = await materializeMessage(db, job.orgId, pm, deps);

      // Calendar invite (iMIP): parse + store alongside the message, before the
      // delivery so the invite is present the first time the thread is opened.
      await persistInvite(db, ck, job.orgId, messageId, parsed);

      const recipientBase = baseAddress(job.recipient, job.subaddressTag);
      const role = deriveRole(parsed, recipientBase);

      await materializeDelivery(db, {
        orgId: job.orgId,
        messageId,
        threadId,
        mailboxId: job.resolvedMailboxId,
        role,
        viaAliasId: job.viaAliasId,
        subaddressTag: job.subaddressTag,
        sentAt: pm.sentAt,
      });

      // Live inbox: wake the mailbox's users — list prepends + badge bumps.
      await notifyInboundMail(db, env.MAIL_EVENTS, job.resolvedMailboxId, threadId);

      // Durable notification (bell) — best-effort, never fails the delivery.
      await tryLog(
        "in.notify_failed",
        recordNewMail(db, { orgId: job.orgId, mailboxId: job.resolvedMailboxId, threadId }, env),
        { threadId },
      );

      // A new correspondent just landed — record the sender against this mailbox
      // (autocomplete index) and bust the recipients' cached contact candidates
      // (key shape shared with draft.remote.ts contactsKey) so the sender shows
      // up in suggestions immediately, not after the KV TTL.
      await tryLog(
        "in.correspondent_failed",
        recordCorrespondents(db, [
          { mailboxId: job.resolvedMailboxId, address: pm.from, name: pm.fromName, seenAt: pm.sentAt },
        ]),
        { threadId },
      );
      if (env.AUTH_KV) {
        try {
          const userIds = await sendGrantUserIds(db, job.resolvedMailboxId);
          await Promise.all(userIds.map((u) => env.AUTH_KV!.delete(`contacts:${u}`)));
        } catch (e) {
          log.warn("in.contacts_bust_failed", errInfo(e)); // never fail the delivery over cache hygiene
        }
      }

      m.ack();
    } catch (e) {
      log.error("in.job_retry", { r2Key: job.r2RawKey, ...errInfo(e) });
      m.retry();
    }
  }
}
