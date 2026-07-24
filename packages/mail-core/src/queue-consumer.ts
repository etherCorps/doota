// SPDX-License-Identifier: Apache-2.0
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import PostalMime from "postal-mime";
import * as schema from "@doota/db/schema";
import { importKey } from "./crypto";
import { materializeMessage, materializeDelivery, type ParsedMessage } from "./materialize";
import { looksLikeBounce, parseBounce, applyBounce } from "./bounce";
import { notifyInboundMail, notifySubmissionState } from "./events-hub";
import { log, errInfo } from "./log";
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
  attachments?: { filename?: string; mimeType?: string; content?: ArrayBuffer | string; contentId?: string }[];
};

function addrList(list: PMAddress[] | undefined): string[] {
  return (list ?? []).map((a) => (a.address ?? "").trim().toLowerCase()).filter(Boolean);
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
    to: addrList(parsed.to),
    cc: addrList(parsed.cc),
    replyTo: parsed.replyTo?.[0]?.address?.trim().toLowerCase() ?? null,
    subject: parsed.subject ?? null,
    sentAt,
    text: parsed.text ?? null,
    html: parsed.html ?? null,
    r2RawKey: job.r2RawKey,
    // r2Key is filled by stageInboundAttachments before materialize — a null
    // key means an empty/unreadable part, and stays undownloadable.
    attachments: (parsed.attachments ?? []).map((a, i) => ({
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
  for (let i = 0; i < pm.attachments.length; i++) {
    const content = parsed.attachments?.[i]?.content;
    if (content == null) continue;
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const key = `attachments/${orgId}/${crypto.randomUUID()}`;
    await env.MAIL_RAW.put(key, bytes, {
      httpMetadata: { contentType: pm.attachments[i].contentType ?? "application/octet-stream" },
    });
    pm.attachments[i].r2Key = key;
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
        // DSN fallback path (structured event subscriptions are primary; a DSN
        // that slips through still updates state and wakes the user's stream —
        // client-side dedupe absorbs any double notification).
        const applied = await applyBounce(db, job.orgId, parseBounce(new TextDecoder().decode(buf)));
        if (applied.matchedSubmission && applied.worstStatus) {
          await notifySubmissionState(db, env.MAIL_EVENTS, applied.matchedSubmission, applied.worstStatus);
        }
        m.ack();
        continue;
      }

      const pm = toParsedMessage(parsed, job);
      await stageInboundAttachments(env, job.orgId, parsed, pm);

      const { messageId, threadId } = await materializeMessage(db, job.orgId, pm, deps);

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

      m.ack();
    } catch (e) {
      log.error("in.job_retry", { r2Key: job.r2RawKey, ...errInfo(e) });
      m.retry();
    }
  }
}
