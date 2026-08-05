// SPDX-License-Identifier: Apache-2.0
/**
 * Outbound webhooks (Phase A). Delivers delivery-outcome events for the sending
 * API to operator-registered endpoints. Rides the write-row-then-enqueue queue
 * pattern (like `submission`) so redelivery is idempotent.
 *
 * SECURITY (each guard is load-bearing):
 * - SSRF: validateWebhookUrl on save AND at delivery (DNS answers change), and
 *   fetch with redirect:"manual" so a public URL that 302s to a private address
 *   fails rather than being followed.
 * - Payload carries STRUCTURAL REFS ONLY — ids, statuses, addresses, timestamps.
 *   Never a subject or body. A misconfigured URL leaks routing metadata, not mail.
 * - Signed HMAC-SHA256 over `timestamp.body` (timestamp included → no replay),
 *   in the Doota-Signature header. The signing secret is stored ENCRYPTED (not
 *   hashed): the worker must recover it to sign.
 * - 5s timeout; no retry on 4xx except 408/429; exponential backoff + jitter to
 *   a capped attempt count; auto-disable + routing_issue after N failures.
 */
import { and, eq, inArray, lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { type ContentKey, decryptContent, importKey } from "./crypto";
import { chargeCounter } from "./send-rate-limit";
import { validateWebhookUrl } from "./ssrf";

type Db = DrizzleD1Database<typeof schema>;

/** Env the webhook queue consumer needs. */
export type WebhookConsumerEnv = {
  DB: D1Database;
  MAIL_DEK: string;
  WEBHOOK_QUEUE?: Queue<WebhookJob>;
};

export const WEBHOOK_EVENTS = [
  "submission.sent",
  "submission.delivered",
  "submission.bounced",
  "submission.complained",
  "submission.failed",
  "mail.received",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

// Delivery tuning.
const TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 30_000; // 30s, doubling
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000; // 6h ceiling
const FAILURE_DISABLE_THRESHOLD = 15; // consecutive failures → auto-disable
// Per-endpoint rate limit (reuses the windowed send_counter table).
const RATE_WINDOW_MS = 60 * 1000;
const RATE_CAP = 120; // 120 deliveries / minute / endpoint

/** Queue message: one delivery attempt. */
export type WebhookJob = { deliveryId: string };

// ---- Signing ----

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 over `${timestamp}.${body}` — the timestamp defeats replay. */
export async function signWebhook(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return hex(sig);
}

// ---- Backoff ----

function nextDelayMs(attempts: number): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
  // Full jitter: spread retries so a fleet of endpoints failing at once doesn't
  // stampede. Deterministic-random not needed here (not resumed/cached).
  return Math.round(base / 2 + Math.floor(Math.random() * (base / 2)));
}

// ---- Enqueue (producer) ----

/**
 * Fan an event out to the MAILBOX's enabled, subscribed endpoints. Writes a
 * `webhook_delivery` row per endpoint FIRST, then enqueues — the same ordering
 * that makes submission redelivery safe. `eventId` is stable so receivers
 * dedupe. `payload` must already be structural-refs-only (see buildPayload
 * callers). No-op when the mailbox has no matching endpoint.
 */
export async function enqueueWebhookDeliveries(
  db: Db,
  queue: Queue<WebhookJob>,
  input: { mailboxId: string; eventType: WebhookEvent; eventId: string; payload: Record<string, unknown> },
): Promise<void> {
  const endpoints = await db.query.webhookEndpoint.findMany({
    where: and(
      eq(mail.webhookEndpoint.mailboxId, input.mailboxId),
      eq(mail.webhookEndpoint.isEnabled, true),
    ),
    columns: { id: true, events: true },
  });
  const subscribed = endpoints.filter((endpoint) => {
    const events = parseEvents(endpoint.events);
    return events.length === 0 || events.includes(input.eventType);
  });
  if (!subscribed.length) return;

  const body = JSON.stringify({
    id: input.eventId,
    type: input.eventType,
    createdAt: Date.now(),
    data: input.payload,
  });
  const rows = await db
    .insert(mail.webhookDelivery)
    .values(
      subscribed.map((endpoint) => ({
        endpointId: endpoint.id,
        eventId: input.eventId,
        eventType: input.eventType,
        payload: body,
        status: "queued" as const,
        nextAttemptAt: new Date(),
      })),
    )
    .returning({ id: mail.webhookDelivery.id });
  // Enqueue after the rows exist: a lost enqueue is recovered by the due-sweep.
  await Promise.all(rows.map((row) => queue.send({ deliveryId: row.id })));
}

/** Map a submission DB status → its webhook event, or null if not an event. */
const STATUS_EVENT: Record<string, WebhookEvent> = {
  sent: "submission.sent",
  delivered: "submission.delivered",
  bounced: "submission.bounced",
  bounced_hard: "submission.bounced",
  bounced_soft: "submission.bounced",
  complained: "submission.complained",
  failed: "submission.failed",
};

/**
 * Producer: emit a submission-state webhook. Resolves the org + STRUCTURAL refs
 * only (ids, status, timestamp — never subject/body) and fans out. No-op when
 * the status isn't a webhook event or the queue binding is absent. `eventId` is
 * `${submissionId}:${status}` so a redelivered state change dedupes downstream.
 */
export async function emitSubmissionWebhook(
  db: Db,
  queue: Queue<WebhookJob> | undefined,
  submissionId: string,
  status: string,
): Promise<void> {
  const eventType = STATUS_EVENT[status];
  if (!queue || !eventType) return;
  const sub = await db.query.submission.findFirst({
    where: eq(mail.submission.id, submissionId),
    columns: { id: true, mailboxId: true, messageId: true, status: true },
  });
  if (!sub) return;
  await enqueueWebhookDeliveries(db, queue, {
    mailboxId: sub.mailboxId,
    eventType,
    eventId: `${submissionId}:${status}`,
    payload: {
      submissionId: sub.id,
      mailboxId: sub.mailboxId,
      status,
      occurredAt: Date.now(),
    },
  });
}

/**
 * Producer: emit the mail.received webhook for a newly delivered inbound thread.
 * Structural refs only. Resolves the org from the mailbox. `eventId` keys on
 * (mailbox, thread) so a redelivered inbound message dedupes downstream.
 */
export async function emitInboundWebhook(
  db: Db,
  queue: Queue<WebhookJob> | undefined,
  mailboxId: string,
  threadId: string,
): Promise<void> {
  if (!queue) return;
  await enqueueWebhookDeliveries(db, queue, {
    mailboxId,
    eventType: "mail.received",
    eventId: `${mailboxId}:${threadId}`,
    payload: { mailboxId, threadId, occurredAt: Date.now() },
  });
}

function parseEvents(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((event): event is string => typeof event === "string") : [];
  } catch {
    return [];
  }
}

// ---- Deliver (consumer) ----

/**
 * Attempt one delivery. Idempotent per row: no-ops if already delivered or the
 * endpoint is disabled. Called from the queue consumer and the retry sweep.
 * `notifyDisabled` raises the routing_issue bell when an endpoint auto-disables.
 */
export async function handleWebhookDelivery(
  db: Db,
  dek: ContentKey,
  deliveryId: string,
  notifyDisabled: (orgId: string, endpointId: string) => Promise<void>,
): Promise<void> {
  const delivery = await db.query.webhookDelivery.findFirst({
    where: eq(mail.webhookDelivery.id, deliveryId),
  });
  if (!delivery || delivery.status === "delivered" || delivery.status === "failed") return;

  const endpoint = await db.query.webhookEndpoint.findFirst({
    where: eq(mail.webhookEndpoint.id, delivery.endpointId),
  });
  if (!endpoint || !endpoint.isEnabled) {
    await db
      .update(mail.webhookDelivery)
      .set({ status: "failed", lastError: "endpoint disabled" })
      .where(eq(mail.webhookDelivery.id, deliveryId));
    return;
  }

  // Re-validate at delivery time — the host may have been re-pointed since save.
  const check = validateWebhookUrl(endpoint.url);
  if (!check.ok) {
    await failPermanently(db, delivery, endpoint, `blocked url: ${check.error}`, notifyDisabled);
    return;
  }

  // Per-endpoint rate limit. Over the cap → back off WITHOUT counting a failure
  // (the endpoint is fine; we're pacing ourselves).
  const rate = await chargeCounter(db, "webhook", endpoint.id, RATE_WINDOW_MS, RATE_CAP);
  if (!rate.ok) {
    await db
      .update(mail.webhookDelivery)
      .set({ nextAttemptAt: new Date(Date.now() + RATE_WINDOW_MS) })
      .where(eq(mail.webhookDelivery.id, deliveryId));
    return;
  }

  await db
    .update(mail.webhookDelivery)
    .set({ status: "delivering", attempts: delivery.attempts + 1 })
    .where(eq(mail.webhookDelivery.id, deliveryId));

  const secret = await decryptContent(dek, endpoint.secretEnc);
  const timestamp = Date.now();
  const signature = secret ? await signWebhook(secret, timestamp, delivery.payload) : "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let code: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(check.url, {
      method: "POST",
      redirect: "manual", // a 3xx to a private address must NOT be followed
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": "Doota-Webhooks/1",
        "Doota-Event": delivery.eventType,
        "Doota-Delivery": delivery.eventId,
        "Doota-Timestamp": String(timestamp),
        "Doota-Signature": signature,
      },
      body: delivery.payload,
    });
    code = res.status;
  } catch (err) {
    error = err instanceof Error ? err.name === "AbortError" ? "timeout" : err.message : "network error";
  } finally {
    clearTimeout(timer);
  }

  // 2xx = delivered. A manual-redirect (opaqueredirect/3xx) is NOT success —
  // we refused to follow it. 4xx (except 408/429) is permanent — the endpoint
  // will never accept it, so retrying burns quota. Everything else retries.
  if (code !== null && code >= 200 && code < 300) {
    await db
      .update(mail.webhookDelivery)
      .set({ status: "delivered", responseCode: code, lastError: null })
      .where(eq(mail.webhookDelivery.id, deliveryId));
    if (endpoint.failureCount > 0) {
      await db
        .update(mail.webhookEndpoint)
        .set({ failureCount: 0 })
        .where(eq(mail.webhookEndpoint.id, endpoint.id));
    }
    return;
  }

  const permanent = code !== null && code >= 400 && code < 500 && code !== 408 && code !== 429;
  const attempts = delivery.attempts + 1;
  if (permanent || attempts >= MAX_ATTEMPTS) {
    await failPermanently(
      db,
      { ...delivery, attempts },
      endpoint,
      error ?? `http ${code}`,
      notifyDisabled,
      code,
    );
    return;
  }
  // Retry: schedule the next attempt; a redelivery-safe row already exists.
  await db
    .update(mail.webhookDelivery)
    .set({
      status: "queued",
      responseCode: code,
      lastError: error ?? `http ${code}`,
      nextAttemptAt: new Date(Date.now() + nextDelayMs(attempts)),
    })
    .where(eq(mail.webhookDelivery.id, deliveryId));
}

async function failPermanently(
  db: Db,
  delivery: { id: string; attempts: number },
  endpoint: { id: string; orgId: string; failureCount: number },
  reason: string,
  notifyDisabled: (orgId: string, endpointId: string) => Promise<void>,
  code?: number | null,
): Promise<void> {
  await db
    .update(mail.webhookDelivery)
    .set({ status: "failed", lastError: reason, responseCode: code ?? null })
    .where(eq(mail.webhookDelivery.id, delivery.id));
  const failureCount = endpoint.failureCount + 1;
  const disable = failureCount >= FAILURE_DISABLE_THRESHOLD;
  await db
    .update(mail.webhookEndpoint)
    .set({ failureCount, ...(disable ? { isEnabled: false, disabledAt: new Date() } : {}) })
    .where(eq(mail.webhookEndpoint.id, endpoint.id));
  if (disable) await notifyDisabled(endpoint.orgId, endpoint.id);
}

/**
 * Raise a routing_issue bell for the org's owners/admins when an endpoint
 * auto-disables. Best-effort: a bell failure must never fail delivery handling.
 */
export async function notifyWebhookDisabled(db: Db, orgId: string, endpointId: string): Promise<void> {
  const admins = await db
    .select({ userId: schema.member.userId })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, orgId),
        inArray(schema.member.role, ["owner", "admin"]),
      ),
    );
  if (!admins.length) return;
  await db
    .insert(mail.notification)
    .values(
      admins.map((admin) => ({
        userId: admin.userId,
        orgId,
        type: "routing_issue" as const,
        submissionId: endpointId, // reuse the ref column to point at the endpoint
      })),
    )
    .onConflictDoNothing();
}

/** Queue consumer: process a batch of delivery jobs (mail-jobs worker). */
export async function handleWebhookQueue(
  batch: MessageBatch<WebhookJob>,
  env: WebhookConsumerEnv,
): Promise<void> {
  const { drizzle } = await import("drizzle-orm/d1");
  const db = drizzle(env.DB, { schema }) as unknown as Db;
  const dek = await importKey(env.MAIL_DEK);
  for (const message of batch.messages) {
    try {
      await handleWebhookDelivery(db, dek, message.body.deliveryId, (orgId, endpointId) =>
        notifyWebhookDisabled(db, orgId, endpointId).catch(() => {}),
      );
      message.ack();
    } catch {
      // Let the queue retry the whole message (delivery is idempotent per row).
      message.retry();
    }
  }
}

/**
 * Retry sweep — re-enqueue deliveries whose next_attempt_at has come due but
 * whose queue message was lost (or which were rate-deferred). Folds into the
 * existing cron; the partial index (status='queued') serves the scan.
 */
export async function sweepDueWebhooks(db: Db, queue: Queue<WebhookJob>, now = Date.now()): Promise<number> {
  const due = await db.query.webhookDelivery.findMany({
    where: and(eq(mail.webhookDelivery.status, "queued")),
    columns: { id: true, nextAttemptAt: true },
    limit: 200,
  });
  const ready = due.filter((row) => row.nextAttemptAt !== null && row.nextAttemptAt.getTime() <= now);
  await Promise.all(ready.map((row) => queue.send({ deliveryId: row.id })));
  return ready.length;
}

/** Drop terminal delivery rows (delivered/failed) past retention (default 30d). */
export async function pruneWebhookDeliveries(db: Db, olderThanMs = 30 * 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const dropped = await db
    .delete(mail.webhookDelivery)
    .where(
      and(
        inArray(mail.webhookDelivery.status, ["delivered", "failed"]),
        lt(mail.webhookDelivery.createdAt, cutoff),
      ),
    )
    .returning({ id: mail.webhookDelivery.id });
  return dropped.length;
}
