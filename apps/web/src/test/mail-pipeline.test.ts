// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { invalidateDomainCache } from "@doota/db/org-domains";
import { resolveRecipient } from "@doota/mail-core/resolver";
import {
  materializeMessage,
  materializeDelivery,
  type ParsedMessage,
} from "@doota/mail-core/materialize";
import { countUnread } from "@doota/mail-core/read";
import { importKey } from "@doota/mail-core/crypto";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const ORG = "org1";
const APEX = "acme.com";

async function seed(db: any) {
  await db.insert(schema.organization).values({
    id: ORG,
    name: "Acme",
    slug: "acme-com",
    domain: APEX,
    status: "active",
    createdAt: new Date(),
  });
  // Subaddressing on; one routing subdomain.
  await db.insert(schema.orgMailSettings).values({
    orgId: ORG,
    subaddressingEnabled: true,
    routingSubdomains: JSON.stringify(["mail.acme.com"]),
  });
  // Personal mailbox on apex, a shared mailbox on the subdomain, and an alias.
  await db.insert(schema.mailbox).values([
    { id: "mb_apex", orgId: ORG, localPart: "alice", address: "alice@acme.com", isActive: true, isPersonal: true },
    { id: "mb_sub", orgId: ORG, localPart: "support", address: "support@mail.acme.com", isActive: true, isPersonal: false },
  ]);
  await db.insert(schema.alias).values([
    { id: "al_on", orgId: ORG, mailboxId: "mb_apex", address: "x7y8@acme.com", isEnabled: true },
    { id: "al_off", orgId: ORG, mailboxId: "mb_apex", address: "z9z9@acme.com", isEnabled: false },
  ]);
  invalidateDomainCache();
}

function parsed(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    messageIdHeader: "<m1@ext>",
    inReplyTo: null,
    references: null,
    from: "ext@sender.com",
    subject: "Hello",
    sentAt: Date.now(),
    text: "This is the body.",
    html: null,
    r2RawKey: "raw/org1/m1",
    attachments: [],
    ...overrides,
  };
}

let db: any;
let deps: { ck: Awaited<ReturnType<typeof importKey>>; searchKeyB64: string };

beforeEach(async () => {
  db = await makeDb();
  await seed(db);
  deps = { ck: await importKey(KEY_B64), searchKeyB64: KEY_B64 };
});

describe("resolver (Part B)", () => {
  it("resolves an apex mailbox", async () => {
    const r = await resolveRecipient(db, "alice@acme.com");
    expect(r).toMatchObject({ orgId: ORG, mailboxId: "mb_apex", viaAliasId: null, subaddressTag: null });
  });

  it("resolves a routing-subdomain mailbox", async () => {
    const r = await resolveRecipient(db, "support@mail.acme.com");
    expect(r?.mailboxId).toBe("mb_sub");
  });

  it("captures the subaddress tag and resolves the base", async () => {
    const r = await resolveRecipient(db, "alice+invoices@acme.com");
    expect(r?.mailboxId).toBe("mb_apex");
    expect(r?.subaddressTag).toBe("invoices");
  });

  it("delivers an enabled alias to its mailbox", async () => {
    const r = await resolveRecipient(db, "x7y8@acme.com");
    expect(r).toMatchObject({ mailboxId: "mb_apex", viaAliasId: "al_on" });
  });

  it("rejects a disabled alias", async () => {
    expect(await resolveRecipient(db, "z9z9@acme.com")).toBeNull();
  });

  it("rejects an unknown recipient", async () => {
    expect(await resolveRecipient(db, "nobody@acme.com")).toBeNull();
    expect(await resolveRecipient(db, "alice@other.com")).toBeNull();
  });
});

describe("materialize idempotency + dedupe (Part D)", () => {
  it("a redelivered job converges — one message, one delivery", async () => {
    const pm = parsed();
    for (let i = 0; i < 2; i++) {
      const { messageId, threadId } = await materializeMessage(db, ORG, pm, deps);
      await materializeDelivery(db, {
        orgId: ORG, messageId, threadId, mailboxId: "mb_apex",
        role: "to", viaAliasId: null, subaddressTag: null, sentAt: pm.sentAt,
      });
    }
    const msgs = await db.select().from(schema.message).where(eq(schema.message.orgId, ORG));
    const dels = await db.select().from(schema.delivery).where(eq(schema.delivery.mailboxId, "mb_apex"));
    expect(msgs.length).toBe(1);
    expect(dels.length).toBe(1);
  });

  it("dedupes one email across recipients — one message, two deliveries", async () => {
    const pm = parsed({ messageIdHeader: "<shared@ext>" });
    // Same Message-ID arrives once per recipient (Email Routing behavior).
    const a = await materializeMessage(db, ORG, pm, deps);
    await materializeDelivery(db, { orgId: ORG, ...a, mailboxId: "mb_apex", role: "to", viaAliasId: null, subaddressTag: null, sentAt: pm.sentAt });
    const b = await materializeMessage(db, ORG, pm, deps);
    await materializeDelivery(db, { orgId: ORG, ...b, mailboxId: "mb_sub", role: "cc", viaAliasId: null, subaddressTag: null, sentAt: pm.sentAt });

    expect(a.messageId).toBe(b.messageId);
    const msgs = await db.select().from(schema.message).where(eq(schema.message.messageIdHeader, "<shared@ext>"));
    const dels = await db.select().from(schema.delivery).where(eq(schema.delivery.messageId, a.messageId));
    expect(msgs.length).toBe(1);
    expect(dels.length).toBe(2);
  });

  it("records via_alias_id + bumps alias.last_used_at on alias delivery", async () => {
    const pm = parsed({ messageIdHeader: "<viaalias@ext>" });
    const { messageId, threadId } = await materializeMessage(db, ORG, pm, deps);
    await materializeDelivery(db, {
      orgId: ORG, messageId, threadId, mailboxId: "mb_apex",
      role: "to", viaAliasId: "al_on", subaddressTag: null, sentAt: pm.sentAt,
    });
    const del = await db.query.delivery.findFirst({ where: eq(schema.delivery.messageId, messageId) });
    expect(del.viaAliasId).toBe("al_on");
    const al = await db.query.alias.findFirst({ where: eq(schema.alias.id, "al_on") });
    expect(al.lastUsedAt).not.toBeNull();
  });

  it("un-archives a thread on reply", async () => {
    const first = parsed({ messageIdHeader: "<t1@ext>" });
    const m1 = await materializeMessage(db, ORG, first, deps);
    await materializeDelivery(db, { orgId: ORG, ...m1, mailboxId: "mb_apex", role: "to", viaAliasId: null, subaddressTag: null, sentAt: first.sentAt });

    // User archives the thread.
    await db.update(schema.threadState).set({ placement: "archived" }).where(eq(schema.threadState.threadId, m1.threadId));

    // A reply lands (same thread via In-Reply-To).
    const reply = parsed({ messageIdHeader: "<t2@ext>", inReplyTo: "<t1@ext>", subject: "Re: Hello", sentAt: Date.now() + 1000 });
    const m2 = await materializeMessage(db, ORG, reply, deps);
    expect(m2.threadId).toBe(m1.threadId); // threaded onto the parent
    await materializeDelivery(db, { orgId: ORG, ...m2, mailboxId: "mb_apex", role: "to", viaAliasId: null, subaddressTag: null, sentAt: reply.sentAt });

    const state = await db.query.threadState.findFirst({ where: eq(schema.threadState.threadId, m1.threadId) });
    expect(state.placement).toBe("inbox");
  });

  it("threads a reply carrying the provider-rewritten Message-ID", async () => {
    // Our outbound message: D1 stores the minted id, the wire carried CF's.
    const sent = parsed({ messageIdHeader: "<minted@acme.com>", from: "alice@acme.com" });
    const m1 = await materializeMessage(db, ORG, sent, deps);
    await db.insert(schema.submission).values({
      id: "sub1", orgId: ORG, messageId: m1.messageId, mailboxId: "mb_apex",
      envelopeFrom: "alice@acme.com", status: "sent", idempotencyKey: "ik1",
      providerMessageId: "<EUQ4wire@acme.com>",
    });
    // A later chunk's wire id lives only on the recipient row.
    await db.insert(schema.submissionRecipient).values({
      id: "sr1", submissionId: "sub1", address: "far@ext.com", role: "to",
      status: "sent", providerMessageId: "<chunk2wire@acme.com>",
    });

    // Gmail replies with In-Reply-To = the wire id we never stored on message.
    const reply = parsed({ messageIdHeader: "<re1@ext>", inReplyTo: "<EUQ4wire@acme.com>", subject: "Re: Hello", sentAt: Date.now() + 1000 });
    const m2 = await materializeMessage(db, ORG, reply, deps);
    expect(m2.threadId).toBe(m1.threadId);

    // Same via a chunk-2 id, and only in References (In-Reply-To unknown).
    const reply2 = parsed({
      messageIdHeader: "<re2@ext>", inReplyTo: "<unknown@nowhere>",
      references: "<also-unknown@x> <chunk2wire@acme.com>", subject: "Re: Hello", sentAt: Date.now() + 2000,
    });
    const m3 = await materializeMessage(db, ORG, reply2, deps);
    expect(m3.threadId).toBe(m1.threadId);
  });

  it("dedupes our own message reflecting back under the provider id", async () => {
    const sent = parsed({ messageIdHeader: "<minted2@acme.com>", from: "alice@acme.com" });
    const m1 = await materializeMessage(db, ORG, sent, deps);
    await db.insert(schema.submission).values({
      id: "sub2", orgId: ORG, messageId: m1.messageId, mailboxId: "mb_apex",
      envelopeFrom: "alice@acme.com", status: "sent", idempotencyKey: "ik2",
      providerMessageId: "<reflect@acme.com>",
    });

    // Mailing list bounces our own mail back — its Message-ID is the wire id.
    const reflected = parsed({ messageIdHeader: "<reflect@acme.com>", from: "alice@acme.com" });
    const m2 = await materializeMessage(db, ORG, reflected, deps);
    expect(m2.messageId).toBe(m1.messageId);
    const msgs = await db.select().from(schema.message).where(eq(schema.message.orgId, ORG));
    expect(msgs.length).toBe(1);
  });

  it("countUnread: new inbox thread counts until the user's read cursor passes it", async () => {
    await db.insert(schema.user).values({
      id: "u1", name: "u1", email: "u1@x.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    const pm = parsed({ messageIdHeader: "<unread1@ext>" });
    const m1 = await materializeMessage(db, ORG, pm, deps);
    await materializeDelivery(db, { orgId: ORG, ...m1, mailboxId: "mb_apex", role: "to", viaAliasId: null, subaddressTag: null, sentAt: pm.sentAt });

    expect(await countUnread(db, { mailboxId: "mb_apex", userId: "u1" })).toBe(1);

    // Read cursor at/after the last message → no longer unread.
    await db.insert(schema.threadRead).values({
      id: "tr1", orgId: ORG, userId: "u1", threadId: m1.threadId, mailboxId: "mb_apex", lastReadAt: new Date(Date.now() + 1000),
    });
    expect(await countUnread(db, { mailboxId: "mb_apex", userId: "u1" })).toBe(0);

    // A newer reply moves lastMessageAt past the cursor → unread again.
    const reply = parsed({ messageIdHeader: "<unread2@ext>", inReplyTo: "<unread1@ext>", sentAt: Date.now() + 60_000 });
    const m2 = await materializeMessage(db, ORG, reply, deps);
    await materializeDelivery(db, { orgId: ORG, ...m2, mailboxId: "mb_apex", role: "to", viaAliasId: null, subaddressTag: null, sentAt: reply.sentAt });
    expect(await countUnread(db, { mailboxId: "mb_apex", userId: "u1" })).toBe(1);
  });

  it("respects spam/trash — a reply does not resurrect a killed thread", async () => {
    const first = parsed({ messageIdHeader: "<s1@ext>" });
    const m1 = await materializeMessage(db, ORG, first, deps);
    await materializeDelivery(db, { orgId: ORG, ...m1, mailboxId: "mb_apex", role: "to", viaAliasId: null, subaddressTag: null, sentAt: first.sentAt });
    await db.update(schema.threadState).set({ placement: "trash" }).where(eq(schema.threadState.threadId, m1.threadId));

    const reply = parsed({ messageIdHeader: "<s2@ext>", inReplyTo: "<s1@ext>", sentAt: Date.now() + 1000 });
    const m2 = await materializeMessage(db, ORG, reply, deps);
    await materializeDelivery(db, { orgId: ORG, ...m2, mailboxId: "mb_apex", role: "to", viaAliasId: null, subaddressTag: null, sentAt: reply.sentAt });

    const state = await db.query.threadState.findFirst({ where: eq(schema.threadState.threadId, m1.threadId) });
    expect(state.placement).toBe("trash");
  });
});
