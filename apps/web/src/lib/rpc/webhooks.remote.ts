// SPDX-License-Identifier: Apache-2.0
import { command, query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { desc, eq, inArray, sql } from "drizzle-orm";
import * as mail from "@doota/db/mail.schema";
import { getAuthz } from "$lib/server/authz.js";
import { encryptContent, importKey } from "@doota/mail-core/crypto";
import { isWebhookEvent } from "@doota/mail-core/webhooks";
import { validateWebhookUrl } from "$lib/server/ssrf.js";

/**
 * Per-mailbox outbound webhook endpoints. Every mutation gates through
 * grantOn(mailboxId), the same chokepoint as label/sender-lists: a user with
 * access to the mailbox manages its webhooks (the "they decide" model), not the
 * org admin. The signing secret is minted here, returned in cleartext once, and
 * only ever persisted encrypted with the instance DEK (the delivery worker must
 * recover it to sign).
 */

const SECRET_BYTES = 32;
const SECRET_PREFIX_LEN = 12; // stored cleartext for display ("wh_1a2b3c…"), not secret.

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Resolve the mailbox and assert the caller has access to it (getAuthz floor). */
async function grantOn(mailboxId: string) {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  const box = await locals.db.query.mailbox.findFirst({
    where: eq(mail.mailbox.id, mailboxId),
    columns: { id: true, orgId: true },
  });
  if (!box) error(404, "Mailbox not found.");
  const { mailboxIds } = await getAuthz();
  if (!mailboxIds.includes(mailboxId)) error(403, "You need access to this mailbox.");
  return { box, user: locals.user, db: locals.db };
}

/** The instance content key (DEK) used to encrypt the signing secret. */
function contentKey() {
  const dek = getRequestEvent().platform?.env?.MAIL_DEK;
  if (!dek) error(500, "Mail encryption key is not configured.");
  return importKey(dek);
}

/** Resolve an endpoint's mailbox for an access-scoped authorization check. */
async function endpointMailbox(endpointId: string): Promise<string> {
  const { locals } = getRequestEvent();
  const row = await locals.db.query.webhookEndpoint.findFirst({
    where: eq(mail.webhookEndpoint.id, endpointId),
    columns: { mailboxId: true },
  });
  if (!row) error(404, "Webhook endpoint not found.");
  return row.mailboxId;
}

/** List a mailbox's endpoints with a delivered/failed delivery tally. Never returns secretEnc. */
export const mailboxWebhooks = query(z.object({ mailboxId: z.string().min(1) }), async ({ mailboxId }) => {
  const { db } = await grantOn(mailboxId);

  const endpoints = await db.query.webhookEndpoint.findMany({
    where: eq(mail.webhookEndpoint.mailboxId, mailboxId),
    orderBy: desc(mail.webhookEndpoint.createdAt),
    columns: {
      id: true,
      url: true,
      events: true,
      isEnabled: true,
      failureCount: true,
      disabledAt: true,
      secretPrefix: true,
      createdAt: true,
    },
  });
  if (!endpoints.length) return [];

  // One grouped scan for the delivered/failed counts shown per endpoint.
  const tallies = await db
    .select({
      endpointId: mail.webhookDelivery.endpointId,
      status: mail.webhookDelivery.status,
      total: sql<number>`count(*)`,
    })
    .from(mail.webhookDelivery)
    .where(
      inArray(
        mail.webhookDelivery.endpointId,
        endpoints.map((endpoint) => endpoint.id),
      ),
    )
    .groupBy(mail.webhookDelivery.endpointId, mail.webhookDelivery.status);

  const countsByEndpoint = new Map<string, { delivered: number; failed: number }>();
  for (const tally of tallies) {
    const bucket = countsByEndpoint.get(tally.endpointId) ?? { delivered: 0, failed: 0 };
    if (tally.status === "delivered") bucket.delivered = tally.total;
    else if (tally.status === "failed") bucket.failed = tally.total;
    countsByEndpoint.set(tally.endpointId, bucket);
  }

  return endpoints.map((endpoint) => ({
    id: endpoint.id,
    url: endpoint.url,
    events: parseEvents(endpoint.events),
    isEnabled: endpoint.isEnabled,
    failureCount: endpoint.failureCount,
    disabledAt: endpoint.disabledAt ? endpoint.disabledAt.getTime() : null,
    secretPrefix: endpoint.secretPrefix,
    createdAt: endpoint.createdAt.getTime(),
    delivered: countsByEndpoint.get(endpoint.id)?.delivered ?? 0,
    failed: countsByEndpoint.get(endpoint.id)?.failed ?? 0,
  }));
});

const eventsSchema = z
  .array(z.string())
  .refine((events) => events.every(isWebhookEvent), "Unknown webhook event.");

/**
 * Create an endpoint on a mailbox. SSRF gate on save (rejects e.g.
 * 169.254.169.254), mint + encrypt the signing secret, then fire one test
 * delivery so the owner sees it arrive. Returns the plaintext secret once; it's
 * never exposed again.
 */
export const createWebhook = command(
  z.object({
    mailboxId: z.string().min(1),
    url: z.string().min(1),
    events: eventsSchema,
  }),
  async ({ mailboxId, url, events }) => {
    const { box, user, db } = await grantOn(mailboxId);

    const check = validateWebhookUrl(url);
    if (!check.ok) error(400, check.error);

    const secret = `wh_${hex(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)).buffer)}`;
    const secretEnc = await encryptContent(await contentKey(), secret);
    if (!secretEnc) error(500, "Could not encrypt the signing secret."); // unreachable: secret is non-empty
    const secretPrefix = secret.slice(0, SECRET_PREFIX_LEN);

    const [endpoint] = await db
      .insert(mail.webhookEndpoint)
      .values({
        orgId: box.orgId,
        mailboxId: box.id,
        url: check.url,
        secretEnc,
        secretPrefix,
        events: JSON.stringify(events),
        createdByUserId: user.id,
      })
      .returning({ id: mail.webhookEndpoint.id });

    // Test delivery: write the row then enqueue (same ordering as real deliveries,
    // so a lost enqueue is recovered by the due-sweep). Skipped when the queue is
    // unbound (vite dev) — the endpoint is still created.
    const eventId = `test:${endpoint.id}`;
    const body = JSON.stringify({
      id: eventId,
      type: "submission.sent",
      createdAt: Date.now(),
      data: { test: true },
    });
    const [delivery] = await db
      .insert(mail.webhookDelivery)
      .values({
        endpointId: endpoint.id,
        eventId,
        eventType: "submission.sent",
        payload: body,
        status: "queued",
        nextAttemptAt: new Date(),
      })
      .returning({ id: mail.webhookDelivery.id });
    await getRequestEvent().platform?.env?.WEBHOOK_QUEUE?.send({ deliveryId: delivery.id });

    return { id: endpoint.id, secret, secretPrefix };
  },
);

/**
 * Update an endpoint's events and/or enabled state. Re-enabling clears the
 * failure state (a re-enabled endpoint starts a fresh strike count).
 */
export const updateWebhook = command(
  z.object({
    id: z.string().min(1),
    events: eventsSchema.optional(),
    isEnabled: z.boolean().optional(),
  }),
  async ({ id, events, isEnabled }) => {
    const { db } = await grantOn(await endpointMailbox(id));

    const patch: Record<string, unknown> = {};
    if (events !== undefined) patch.events = JSON.stringify(events);
    if (isEnabled !== undefined) {
      patch.isEnabled = isEnabled;
      if (isEnabled) {
        patch.failureCount = 0;
        patch.disabledAt = null;
      }
    }
    if (Object.keys(patch).length) {
      await db.update(mail.webhookEndpoint).set(patch).where(eq(mail.webhookEndpoint.id, id));
    }
    return { updated: true };
  },
);

/** Delete an endpoint (its deliveries cascade). */
export const deleteWebhook = command(z.string().min(1), async (id) => {
  const { db } = await grantOn(await endpointMailbox(id));
  await db.delete(mail.webhookEndpoint).where(eq(mail.webhookEndpoint.id, id));
  return { deleted: true };
});

/** Recent delivery rows for an endpoint's detail view. Authorized via its mailbox. */
export const webhookDeliveries = query(
  z.object({ endpointId: z.string().min(1), offset: z.number().int().min(0).optional() }),
  async ({ endpointId, offset }) => {
    const { db } = await grantOn(await endpointMailbox(endpointId));
    const rows = await db.query.webhookDelivery.findMany({
      where: eq(mail.webhookDelivery.endpointId, endpointId),
      orderBy: desc(mail.webhookDelivery.createdAt),
      limit: 25,
      offset: offset ?? 0,
      columns: {
        id: true,
        eventType: true,
        status: true,
        attempts: true,
        responseCode: true,
        lastError: true,
        createdAt: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      status: row.status,
      attempts: row.attempts,
      responseCode: row.responseCode,
      lastError: row.lastError,
      createdAt: row.createdAt.getTime(),
    }));
  },
);

function parseEvents(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((event): event is string => typeof event === "string") : [];
  } catch {
    return [];
  }
}
