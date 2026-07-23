import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { fakeHub } from "./fakes";
import { invalidateDomainCache } from "@doota/db/org-domains";
import { applyProviderEvent } from "@doota/mail-core/events-consumer";
import { notifyInboundMail } from "@doota/mail-core/events-hub";

/**
 * Email Service event-subscriptions consumer: structured delivery lifecycle
 * events correlated via submission_recipient.provider_message_id + address.
 */

const ORG = "org1";

let db: any;
let hub: ReturnType<typeof fakeHub>;
const lastNotify = () => hub.notified.at(-1)?.body;

async function seed(db: any) {
  await db.insert(schema.organization).values({
    id: ORG, name: "Acme", slug: "acme-com", domain: "acme.com", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.user).values({
    id: "u1", name: "u1", email: "u1@x.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(schema.mailbox).values({
    id: "mb1", orgId: ORG, localPart: "alice", address: "alice@acme.com", isActive: true, isPersonal: true,
  });
  await db.insert(schema.thread).values({ id: "th1", orgId: ORG, lastMessageAt: new Date() });
  await db.insert(schema.message).values({
    id: "msg1", orgId: ORG, threadId: "th1", messageIdHeader: "<minted@acme.com>", sentAt: new Date(),
  });
  await db.insert(schema.submission).values({
    id: "sub1", orgId: ORG, messageId: "msg1", mailboxId: "mb1", envelopeFrom: "alice@acme.com",
    createdByUserId: "u1", status: "sent", idempotencyKey: "ik1", providerMessageId: "<wire1@acme.com>",
  });
  await db.insert(schema.submissionRecipient).values([
    { id: "r1", submissionId: "sub1", address: "a@ext.com", role: "to", status: "sent", providerMessageId: "<wire1@acme.com>" },
    { id: "r2", submissionId: "sub1", address: "b@ext.com", role: "to", status: "sent", providerMessageId: "<wire1@acme.com>" },
  ]);
  invalidateDomainCache();
}

beforeEach(async () => {
  db = await makeDb();
  await seed(db);
  hub = fakeHub();
});

const env = () => ({ MAIL_EVENTS: hub as never });

describe("provider event application", () => {
  it("delivered flips the recipient; all delivered → submission delivered (double tick)", async () => {
    await applyProviderEvent(db, env(), { type: "message.delivered", messageId: "<wire1@acme.com>", recipient: "a@ext.com" });
    let sub = await db.query.submission.findFirst({ where: eq(schema.submission.id, "sub1") });
    expect(sub.status).toBe("sent"); // b@ still only sent
    await applyProviderEvent(db, env(), { type: "message.delivered", messageId: "wire1@acme.com", recipient: "b@ext.com" }); // bare id variant
    sub = await db.query.submission.findFirst({ where: eq(schema.submission.id, "sub1") });
    expect(sub.status).toBe("delivered");
    expect(lastNotify()).toMatchObject({ type: "send_state", submissionId: "sub1", status: "delivered", threadId: "th1" });
  });

  it("hard bounce marks the recipient, suppresses, rolls up, notifies", async () => {
    await applyProviderEvent(db, env(), {
      type: "message.bounced", messageId: "<wire1@acme.com>", recipient: "a@ext.com",
      bounce: { type: "hard" }, smtpResponse: "550 5.1.1 user unknown",
    });
    const r = await db.query.submissionRecipient.findFirst({ where: eq(schema.submissionRecipient.id, "r1") });
    expect(r).toMatchObject({ status: "bounced", bounceType: "hard", bounceReason: "550 5.1.1 user unknown" });
    const sup = await db.query.suppression.findFirst({ where: eq(schema.suppression.address, "a@ext.com") });
    expect(sup?.reason).toBe("hard_bounce");
    const sub = await db.query.submission.findFirst({ where: eq(schema.submission.id, "sub1") });
    expect(sub.status).toBe("bounced_hard");
    expect(lastNotify()).toMatchObject({ status: "bounced_hard" });
  });

  it("soft bounce does NOT suppress", async () => {
    await applyProviderEvent(db, env(), {
      type: "message.bounced", messageId: "<wire1@acme.com>", recipient: "a@ext.com", bounce: { type: "soft" },
    });
    expect(await db.query.suppression.findFirst({ where: eq(schema.suppression.address, "a@ext.com") })).toBeFalsy();
    const sub = await db.query.submission.findFirst({ where: eq(schema.submission.id, "sub1") });
    expect(sub.status).toBe("bounced_soft");
  });

  it("complaint suppresses and rolls up to complained", async () => {
    await applyProviderEvent(db, env(), { type: "message.complained", messageId: "<wire1@acme.com>", recipient: "a@ext.com" });
    const sup = await db.query.suppression.findFirst({ where: eq(schema.suppression.address, "a@ext.com") });
    expect(sup?.reason).toBe("complaint");
    const sub = await db.query.submission.findFirst({ where: eq(schema.submission.id, "sub1") });
    expect(sub.status).toBe("complained");
  });

  it("inbound fan-out notifies every grant holder of the mailbox", async () => {
    await db.insert(schema.user).values({
      id: "u2", name: "u2", email: "u2@x.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await db.insert(schema.mailboxAccess).values([
      { id: "ma1", userId: "u1", mailboxId: "mb1" },
      { id: "ma2", userId: "u2", mailboxId: "mb1" },
    ]);
    await notifyInboundMail(db, hub as never, "mb1", "th1");
    expect(hub.notified).toHaveLength(2);
    expect(hub.notified[0].body).toMatchObject({ type: "inbound", threadId: "th1", mailboxId: "mb1" });
    // No grants → no notifications, no throw.
    hub.notified.length = 0;
    await notifyInboundMail(db, hub as never, "mb_none", "th1");
    expect(hub.notified).toHaveLength(0);
  });

  it("unknown message id / deferred are safe no-ops", async () => {
    await applyProviderEvent(db, env(), { type: "message.bounced", messageId: "<stranger@x>", recipient: "a@ext.com" });
    await applyProviderEvent(db, env(), { type: "message.deferred", messageId: "<wire1@acme.com>", recipient: "a@ext.com" });
    expect(hub.notified).toHaveLength(0);
    const sub = await db.query.submission.findFirst({ where: eq(schema.submission.id, "sub1") });
    expect(sub.status).toBe("sent");
  });
});
