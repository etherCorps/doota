import { drizzle } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { resolveRecipient } from "./resolver";

/**
 * `mail-in` handler — Cloudflare Email Routing catch-all target. Runs merged
 * into the SvelteKit Worker (one script, extra handler) via the wrapper entry.
 *
 * Bucket-first, accept-and-enqueue: do the MINIMUM so a processing backlog or
 * outage affects processing, never receipt. No parsing, no threading here. The
 * Cloudflare API is NEVER called — recipient resolution reads cached D1 only.
 *
 * Email Routing invokes this ONCE PER RECIPIENT when a message hits several of
 * our addresses; that's expected — each invocation contributes its own delivery
 * and downstream dedupes by Message-ID.
 */

export type MailEnv = {
  DB: D1Database;
  MAIL_RAW: R2Bucket;
  MAIL_QUEUE: Queue<InboundJob>;
  MAIL_DEK: string;
  MAIL_SEARCH_KEY: string;
};

export type InboundJob = {
  r2RawKey: string;
  recipient: string;
  orgId: string;
  resolvedMailboxId: string;
  viaAliasId: string | null;
  subaddressTag: string | null;
  envelopeFrom: string;
  messageIdHeader: string | null;
};

// Minimal shape of Cloudflare's ForwardableEmailMessage we depend on.
type EmailMessage = {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream;
  setReject(reason: string): void;
};

/** Turn a Message-ID header into a filesystem-safe R2 key fragment. */
function safeKey(id: string): string {
  return id.replace(/[<>]/g, "").replace(/[^a-zA-Z0-9._@-]/g, "_").slice(0, 200);
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleEmail(
  message: EmailMessage,
  env: MailEnv,
): Promise<void> {
  const db = drizzle(env.DB, { schema });

  const resolved = await resolveRecipient(db, message.to);
  if (!resolved) {
    // Unknown/disabled recipient — bounce cleanly and store nothing.
    message.setReject("Recipient does not exist");
    return;
  }

  // Buffer the raw once so we can both key it (content hash when Message-ID is
  // absent) and store it. Inbound emails are small; buffering keeps the key
  // stable for idempotent R2 writes.
  const rawBuf = await new Response(message.raw).arrayBuffer();
  const messageIdHeader = message.headers.get("message-id");
  const keyId = messageIdHeader ? safeKey(messageIdHeader) : await sha256Hex(rawBuf);
  const r2RawKey = `raw/${resolved.orgId}/${keyId}`;

  // Idempotent put — same key overwrites identical bytes; a redelivery is a no-op.
  await env.MAIL_RAW.put(r2RawKey, rawBuf, {
    httpMetadata: { contentType: "message/rfc822" },
  });

  const job: InboundJob = {
    r2RawKey,
    recipient: message.to,
    orgId: resolved.orgId,
    resolvedMailboxId: resolved.mailboxId,
    viaAliasId: resolved.viaAliasId,
    subaddressTag: resolved.subaddressTag,
    envelopeFrom: message.from,
    messageIdHeader,
  };
  await env.MAIL_QUEUE.send(job);
}
