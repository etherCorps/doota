// SPDX-License-Identifier: Apache-2.0
// Phase A stop gates (delivery): redirect-not-followed, 4xx permanent / 5xx
// retry, rate-limit defer, auto-disable + notify, and structural-refs-only
// payloads. Exercises the real pipeline against in-memory SQLite with the real
// migrations + a mocked receiver — no network.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { importKey, encryptContent } from "@doota/mail-core/crypto";
import {
  handleWebhookDelivery,
  enqueueWebhookDeliveries,
  emitSubmissionWebhook,
  emitInboundWebhook,
} from "@doota/mail-core/webhooks";
import { makeDb } from "./mail-db";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const SECRET = "wh_deadbeefcafef00ddeadbeefcafef00d";

type Db = Awaited<ReturnType<typeof makeDb>>;

async function seedOrgAndMailbox(db: Db) {
  await db.insert(schema.organization).values({
    id: "o1", name: "Org", slug: "org", domain: "org.dev", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.mailbox).values({
    id: "m1", orgId: "o1", localPart: "svc", address: "svc@org.dev", isActive: true, isPersonal: true,
  });
}

async function seedEndpoint(
  db: Db,
  over: Partial<{ isEnabled: boolean; failureCount: number; events: string; url: string }> = {},
) {
  const ck = await importKey(KEY_B64);
  const secretEnc = await encryptContent(ck, SECRET);
  const [endpoint] = await db
    .insert(mail.webhookEndpoint)
    .values({
      orgId: "o1",
      mailboxId: "m1",
      url: over.url ?? "https://hooks.example.dev/x",
      secretEnc: secretEnc!,
      secretPrefix: SECRET.slice(0, 12),
      events: over.events ?? "[]",
      isEnabled: over.isEnabled ?? true,
      failureCount: over.failureCount ?? 0,
    })
    .returning({ id: mail.webhookEndpoint.id });
  return endpoint.id;
}

async function seedDelivery(db: Db, endpointId: string, attempts = 0) {
  const [row] = await db
    .insert(mail.webhookDelivery)
    .values({
      endpointId,
      eventId: "ev1",
      eventType: "submission.sent",
      payload: JSON.stringify({ id: "ev1", type: "submission.sent", data: { submissionId: "s1" } }),
      status: "queued",
      attempts,
      nextAttemptAt: new Date(),
    })
    .returning({ id: mail.webhookDelivery.id });
  return row.id;
}

function mockFetch(impl: () => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

describe("webhook delivery pipeline", () => {
  let db: Db;
  const noopNotify = vi.fn(async () => {});

  beforeEach(async () => {
    db = await makeDb();
    await seedOrgAndMailbox(db);
    noopNotify.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("2xx marks delivered and resets the failure count", async () => {
    const endpointId = await seedEndpoint(db, { failureCount: 3 });
    const deliveryId = await seedDelivery(db, endpointId);
    mockFetch(() => new Response("ok", { status: 200 }));
    await handleWebhookDelivery(db, await importKey(KEY_B64), deliveryId, noopNotify);
    const d = await db.query.webhookDelivery.findFirst({ where: eq(mail.webhookDelivery.id, deliveryId) });
    const e = await db.query.webhookEndpoint.findFirst({ where: eq(mail.webhookEndpoint.id, endpointId) });
    expect(d?.status).toBe("delivered");
    expect(e?.failureCount).toBe(0);
  });

  it("a 3xx redirect is NOT followed and NOT counted as delivered", async () => {
    const endpointId = await seedEndpoint(db);
    const deliveryId = await seedDelivery(db, endpointId);
    // redirect:"manual" surfaces the 3xx; our code only accepts 2xx.
    const spy = vi.fn(
      (_url: string, _init?: RequestInit) =>
        new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }),
    );
    vi.stubGlobal("fetch", spy);
    await handleWebhookDelivery(db, await importKey(KEY_B64), deliveryId, noopNotify);
    const d = await db.query.webhookDelivery.findFirst({ where: eq(mail.webhookDelivery.id, deliveryId) });
    expect(d?.status).not.toBe("delivered");
    // exactly one fetch — the redirect target was never fetched.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("4xx (not 408/429) fails permanently — no retry", async () => {
    const endpointId = await seedEndpoint(db);
    const deliveryId = await seedDelivery(db, endpointId);
    mockFetch(() => new Response("bad", { status: 400 }));
    await handleWebhookDelivery(db, await importKey(KEY_B64), deliveryId, noopNotify);
    const d = await db.query.webhookDelivery.findFirst({ where: eq(mail.webhookDelivery.id, deliveryId) });
    expect(d?.status).toBe("failed");
  });

  it("5xx retries — re-queued with a future next_attempt_at", async () => {
    const endpointId = await seedEndpoint(db);
    const deliveryId = await seedDelivery(db, endpointId);
    mockFetch(() => new Response("boom", { status: 503 }));
    await handleWebhookDelivery(db, await importKey(KEY_B64), deliveryId, noopNotify);
    const d = await db.query.webhookDelivery.findFirst({ where: eq(mail.webhookDelivery.id, deliveryId) });
    expect(d?.status).toBe("queued");
    expect(d?.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("auto-disables and notifies after the failure threshold", async () => {
    // Seeded at 14 consecutive failures; one more permanent failure trips 15.
    const endpointId = await seedEndpoint(db, { failureCount: 14 });
    const deliveryId = await seedDelivery(db, endpointId);
    mockFetch(() => new Response("bad", { status: 400 }));
    await handleWebhookDelivery(db, await importKey(KEY_B64), deliveryId, noopNotify);
    const e = await db.query.webhookEndpoint.findFirst({ where: eq(mail.webhookEndpoint.id, endpointId) });
    expect(e?.isEnabled).toBe(false);
    expect(e?.disabledAt).not.toBeNull();
    expect(noopNotify).toHaveBeenCalledWith("o1", endpointId);
  });

  it("a disabled endpoint is skipped, never delivered", async () => {
    const endpointId = await seedEndpoint(db, { isEnabled: false });
    const deliveryId = await seedDelivery(db, endpointId);
    const spy = vi.fn(() => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    await handleWebhookDelivery(db, await importKey(KEY_B64), deliveryId, noopNotify);
    const d = await db.query.webhookDelivery.findFirst({ where: eq(mail.webhookDelivery.id, deliveryId) });
    expect(d?.status).toBe("failed");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("webhook producer — structural refs only", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeDb();
    await seedOrgAndMailbox(db);
  });

  it("only enabled + subscribed endpoints of the mailbox get a delivery row", async () => {
    await seedEndpoint(db, { events: JSON.stringify(["submission.sent"]) }); // subscribed
    await seedEndpoint(db, { events: JSON.stringify(["mail.received"]) }); // not subscribed to sent
    await seedEndpoint(db, { isEnabled: false, events: "[]" }); // disabled
    const queue = { send: vi.fn(async () => {}) };
    await enqueueWebhookDeliveries(db, queue as never, {
      mailboxId: "m1",
      eventType: "submission.sent",
      eventId: "e1",
      payload: { submissionId: "s1" },
    });
    const rows = await db.query.webhookDelivery.findMany();
    expect(rows).toHaveLength(1); // only the subscribed, enabled endpoint
    expect(queue.send).toHaveBeenCalledTimes(1);
  });

  it("submission + inbound payloads never contain a subject or body", async () => {
    // A submission the producer will read (structural columns only).
    await db.insert(mail.thread).values({ id: "t1", orgId: "o1" });
    await db.insert(mail.message).values({
      id: "msg1", orgId: "o1", threadId: "t1", messageIdHeader: "<m1@org.dev>",
    });
    await db
      .insert(mail.submission)
      .values({ id: "s1", orgId: "o1", mailboxId: "m1", messageId: "msg1", envelopeFrom: "svc@org.dev", idempotencyKey: "idem1", status: "sent" })
      .onConflictDoNothing();
    await seedEndpoint(db, { events: "[]" });
    const queue = { send: vi.fn(async () => {}) };

    await emitSubmissionWebhook(db, queue as never, "s1", "sent");
    await emitInboundWebhook(db, queue as never, "m1", "t1");

    const rows = await db.query.webhookDelivery.findMany();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      const parsed = JSON.parse(row.payload);
      const keys = JSON.stringify(parsed).toLowerCase();
      expect(keys).not.toContain("subject");
      expect(keys).not.toContain("\"body\"");
      expect(keys).not.toContain("bodyhtml");
    }
  });
});
