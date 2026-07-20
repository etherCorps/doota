import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "$lib/server/db/schema";
import { makeDb } from "./mail-db";
import { invalidateDomainCache } from "$lib/server/org-domains";
import { resolveRecipient } from "$lib/server/mail/resolver";
import {
  materializeMessage,
  materializeDelivery,
  type ParsedMessage,
} from "$lib/server/mail/materialize";
import { importKey } from "$lib/server/mail/crypto";

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
