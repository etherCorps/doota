import { and, eq, lte } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { domainOf } from "@doota/db/org-domains";
import { importKey } from "./crypto";
import {
  materializeMessage,
  materializeDelivery,
  type ParsedMessage,
  type PlacementPolicy,
} from "./materialize";
import { mintMessageId, threadingHeaders } from "./mail-thread-contract";
import { log } from "./log";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Outbound enqueue (Part B step 1-2, Part D). A submission row is written FIRST
 * (status queued, idempotency_key set) and only THEN is a job enqueued — that
 * ordering is what makes queue redelivery safe. The sender's own copy is
 * materialized here (not in the consumer) so it shows in Sent immediately with a
 * queued/clock state; the consumer only fans out to recipients.
 */

export type OutboundJob = { submissionId: string };

export type OutboundEnv = {
  MAIL_DEK: string;
  MAIL_SEARCH_KEY: string;
  MAIL_RAW: R2Bucket;
  MAIL_OUT_QUEUE: Queue<OutboundJob>;
};

export type SendRequest = {
  orgId: string;
  mailboxId: string;
  /** Null for service-key sends (no human author). */
  createdByUserId: string | null;
  /** Header + envelope From — the mailbox address or one of its aliases. */
  fromAddress: string;
  fromName?: string | null;
  fromAliasId?: string | null;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string | null;
  html?: string | null;
  /** Message-ID of the parent when this is a reply (threads + re-quotes). */
  parentMessageId?: string | null;
  attachments?: { r2Key: string; filename: string; contentType: string; size?: number | null }[];
  /** Future scheduled send (epoch ms); null/absent = send after the undo window. */
  sendAt?: number | null;
  idempotencyKey: string;
  undoSeconds?: number;
};

// Sent is a VIEW (deliveries with role `from`), not a placement. A new outbound
// thread starts `archived` — Gmail's "no Inbox label" state — so the first
// inbound reply un-archives it into the inbox via the normal inbound policy,
// while it already shows in Sent through the delivery. Our own reply must not
// yank the thread out of wherever it currently sits (Part D).
const OUTBOUND_PLACEMENT: PlacementPolicy = { newThread: "archived", unarchiveOnReply: false };

const DEFAULT_UNDO_SECONDS = 10;
// Cloudflare Queues cap delivery delay at 12h; beyond that the cron sweep enqueues.
const MAX_QUEUE_DELAY_SECONDS = 12 * 60 * 60;

export type EnqueueResult = {
  submissionId: string;
  messageId: string;
  threadId: string;
  deduped: boolean;
};

export async function enqueueSend(
  db: Db,
  env: OutboundEnv,
  req: SendRequest,
): Promise<EnqueueResult> {
  // Double-send guard: a repeated idempotency_key returns the existing send
  // rather than creating a second one (also enforced by the unique index).
  const existing = await db.query.submission.findFirst({
    where: eq(schema.submission.idempotencyKey, req.idempotencyKey),
    columns: { id: true, messageId: true },
  });
  if (existing) {
    const msg = await db.query.message.findFirst({
      where: eq(schema.message.id, existing.messageId),
      columns: { threadId: true },
    });
    return {
      submissionId: existing.id,
      messageId: existing.messageId,
      threadId: msg?.threadId ?? "",
      deduped: true,
    };
  }

  const now = Date.now();
  const sentAt = req.sendAt ?? now;

  // Parent (reply) for threading — cleartext headers, no decryption.
  const parent = req.parentMessageId
    ? await db.query.message.findFirst({
        where: and(
          eq(schema.message.orgId, req.orgId),
          eq(schema.message.messageIdHeader, req.parentMessageId),
        ),
        columns: { messageIdHeader: true, references: true },
      })
    : null;
  const headers = threadingHeaders(parent ?? null);

  // Our own Message-ID: the dedupe key if the message reflects back to us.
  const messageIdHeader = mintMessageId(domainOf(req.fromAddress));

  const ck = await importKey(env.MAIL_DEK);
  const deps = { ck, searchKeyB64: env.MAIL_SEARCH_KEY };

  // Stage the outbound body (text + html) in R2 as the canonical source the
  // consumer builds the wire message from — same "raw lives in R2" pattern as
  // inbound, so html survives (D1 keeps only text) and a redelivered job rebuilds
  // identical content. D1 columns remain the encrypted ones.
  const r2RawKey = `outbound/${req.orgId}/${crypto.randomUUID()}`;
  await env.MAIL_RAW.put(
    r2RawKey,
    JSON.stringify({ text: req.text ?? null, html: req.html ?? null }),
    { httpMetadata: { contentType: "application/json" } },
  );

  // The stored timeline copy holds what the sender wrote (a bubble); the quoted
  // history is re-attached only on the wire (built in the consumer).
  const pm: ParsedMessage = {
    messageIdHeader,
    inReplyTo: parent?.messageIdHeader ?? null,
    references: headers.References ?? null,
    from: req.fromAddress,
    to: req.to ?? [],
    cc: req.cc ?? [],
    replyTo: null,
    subject: req.subject,
    sentAt,
    text: req.text ?? null,
    html: req.html ?? null,
    r2RawKey,
    attachments: (req.attachments ?? []).map((a) => ({
      partId: null,
      filename: a.filename,
      contentType: a.contentType,
      size: a.size ?? null,
      r2Key: a.r2Key,
    })),
  };
  const { messageId, threadId } = await materializeMessage(db, req.orgId, pm, deps);

  // Sender's own copy (Part D): role `from`, placed in Sent for a new thread.
  await materializeDelivery(db, {
    orgId: req.orgId,
    messageId,
    threadId,
    mailboxId: req.mailboxId,
    role: "from",
    viaAliasId: req.fromAliasId ?? null,
    subaddressTag: null,
    sentAt,
    placement: OUTBOUND_PLACEMENT,
  });

  const undoSeconds = req.undoSeconds ?? DEFAULT_UNDO_SECONDS;
  const fireAt = Math.max(sentAt, now + undoSeconds * 1000);
  const undoUntil = new Date(fireAt); // cancellable any time before it actually sends

  const insertedSub = await db
    .insert(mail.submission)
    .values({
      orgId: req.orgId,
      messageId,
      mailboxId: req.mailboxId,
      envelopeFrom: req.fromAddress,
      fromAliasId: req.fromAliasId ?? null,
      createdByUserId: req.createdByUserId,
      sendAt: req.sendAt ? new Date(req.sendAt) : null,
      undoUntil,
      status: "queued",
      idempotencyKey: req.idempotencyKey,
    })
    .onConflictDoNothing()
    .returning({ id: mail.submission.id });
  const submissionId =
    insertedSub[0]?.id ??
    (await db.query.submission.findFirst({
      where: eq(schema.submission.idempotencyKey, req.idempotencyKey),
      columns: { id: true },
    }))!.id;

  const recips = [
    ...(req.to ?? []).map((a) => ({ address: a, role: "to" as const })),
    ...(req.cc ?? []).map((a) => ({ address: a, role: "cc" as const })),
    ...(req.bcc ?? []).map((a) => ({ address: a, role: "bcc" as const })),
  ];
  if (recips.length) {
    await db
      .insert(mail.submissionRecipient)
      .values(
        recips.map((r) => ({
          submissionId,
          address: r.address.trim().toLowerCase(),
          role: r.role,
        })),
      )
      .onConflictDoNothing();
  }

  // Hold the job for the undo window / until the scheduled time via the queue's
  // delivery delay. Beyond the queue's max delay, skip enqueue — the cron sweep
  // enqueues it when due (consumer idempotency makes a double-enqueue harmless).
  const delaySeconds = Math.ceil((fireAt - now) / 1000);
  if (delaySeconds <= MAX_QUEUE_DELAY_SECONDS) {
    await env.MAIL_OUT_QUEUE.send(
      { submissionId },
      delaySeconds > 0 ? { delaySeconds } : undefined,
    );
  }

  log.info("out.enqueued", { subId: submissionId, from: req.fromAddress, recipients: recips.length, delaySeconds });
  return { submissionId, messageId, threadId, deduped: false };
}

// A submission normally spends seconds in `sending`; one this old lost its job
// (worker crash past the queue's retry cap) and must be rescued by the sweep.
const STALE_SENDING_MS = 15 * 60 * 1000;

/**
 * Cron sweep (Part B.3): enqueue submissions whose hold has elapsed but that are
 * still `queued` — i.e. scheduled sends beyond the queue's max delay (never
 * enqueued at request time) plus any near-send whose delayed job was lost.
 * Also rescues stale `sending` rows (crashed mid-flight, queue retries
 * exhausted) — the consumer's fencing claim + attempt cap make the re-enqueue
 * safe and terminal: it either finishes or rolls up to `failed`, never sticks.
 * Consumer idempotency makes a double-enqueue harmless. Returns the count swept.
 */
export async function sweepDueSubmissions(
  db: Db,
  queue: Queue<OutboundJob>,
  limit = 100,
): Promise<number> {
  const now = new Date();
  const due = await db
    .select({ id: schema.submission.id })
    .from(schema.submission)
    .where(and(eq(schema.submission.status, "queued"), lte(schema.submission.undoUntil, now)))
    .limit(limit);
  const stale = await db
    .select({ id: schema.submission.id })
    .from(schema.submission)
    .where(
      and(
        eq(schema.submission.status, "sending"),
        lte(schema.submission.createdAt, new Date(now.getTime() - STALE_SENDING_MS)),
      ),
    )
    .limit(limit);
  for (const s of [...due, ...stale]) await queue.send({ submissionId: s.id });
  return due.length + stale.length;
}

/**
 * Undo (Part I): cancel while still within the undo window. The row's undo_until
 * is the source of truth, not the queue delay — so this is authoritative even if
 * the job is already in flight (the consumer re-reads status and acks a canceled
 * submission without sending). Returns whether the cancel took effect.
 */
export async function cancelSend(db: Db, submissionId: string): Promise<boolean> {
  const sub = await db.query.submission.findFirst({
    where: eq(schema.submission.id, submissionId),
    columns: { status: true, undoUntil: true },
  });
  if (!sub || sub.status !== "queued") return false;
  if (!sub.undoUntil || sub.undoUntil.getTime() <= Date.now()) return false;
  await db
    .update(mail.submission)
    .set({ status: "canceled" })
    .where(and(eq(mail.submission.id, submissionId), eq(mail.submission.status, "queued")));
  return true;
}
