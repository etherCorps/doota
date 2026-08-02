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
import { countUnread, getThread, listThreads } from "@doota/mail-core/read";
import { sweepDueSnoozes } from "@doota/mail-core/snooze";
import { importKey, decryptContent } from "@doota/mail-core/crypto";

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

  it("caps the D1 text twins — a huge plain-text body can't blow the row (full text stays in R2)", async () => {
    const big = "x".repeat(70_000); // > MAX_D1_TEXT (64k)
    const pm = parsed({ messageIdHeader: "<huge@ext>", text: big, html: null });
    const { messageId } = await materializeMessage(db, ORG, pm, deps);
    const row = await db.query.message.findFirst({ where: eq(schema.message.id, messageId) });
    const full = await decryptContent(deps.ck, row!.bodyFullEnc);
    const stripped = await decryptContent(deps.ck, row!.bodyStrippedEnc);
    expect(full!.length).toBe(64_000); // capped, not 70k
    expect(stripped!.length).toBeLessThanOrEqual(64_000);
    // r2RawKey is retained — the render route serves full fidelity from R2.
    expect(row!.r2RawKey).toBe(pm.r2RawKey);
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

  it("snooze hides a thread from inbox and surfaces it in the snoozed view", async () => {
    const first = parsed({ messageIdHeader: "<sn1@ext>" });
    const m = await materializeMessage(db, ORG, first, deps);
    await materializeDelivery(db, { orgId: ORG, ...m, mailboxId: "mb_apex", role: "to", viaAliasId: null, subaddressTag: null, sentAt: first.sentAt });

    await db.update(schema.threadState).set({ snoozedUntil: new Date(Date.now() + 3_600_000) }).where(eq(schema.threadState.threadId, m.threadId));

    const inbox = await listThreads(db, { mailboxId: "mb_apex", placement: "inbox", ck: deps.ck });
    const snoozed = await listThreads(db, { mailboxId: "mb_apex", placement: "snoozed", ck: deps.ck });
    expect(inbox.some((thread) => thread.threadId === m.threadId)).toBe(false);
    expect(snoozed.some((thread) => thread.threadId === m.threadId)).toBe(true);
  });

  it("cron wakes a due snooze back into the inbox, unread", async () => {
    const first = parsed({ messageIdHeader: "<sn2@ext>" });
    const m = await materializeMessage(db, ORG, first, deps);
    await materializeDelivery(db, { orgId: ORG, ...m, mailboxId: "mb_apex", role: "to", viaAliasId: null, subaddressTag: null, sentAt: first.sentAt });
    // Mark read so we can prove the wake resets it to unread.
    await db.insert(schema.user).values({ id: "u_sn", name: "u", email: "u_sn@x.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(schema.threadRead).values({ id: "tr_sn2", orgId: ORG, threadId: m.threadId, mailboxId: "mb_apex", userId: "u_sn", lastReadAt: new Date() });
    await db.update(schema.threadState).set({ snoozedUntil: new Date(Date.now() - 1000) }).where(eq(schema.threadState.threadId, m.threadId));

    const woken = await sweepDueSnoozes(db);
    expect(woken).toBe(1);
    const state = await db.query.threadState.findFirst({ where: eq(schema.threadState.threadId, m.threadId) });
    expect(state!.snoozedUntil).toBeNull();
    const inbox = await listThreads(db, { mailboxId: "mb_apex", placement: "inbox", ck: deps.ck });
    expect(inbox.some((thread) => thread.threadId === m.threadId)).toBe(true);
    // Read cursor dropped → unread again.
    const read = await db.query.threadRead.findFirst({ where: eq(schema.threadRead.threadId, m.threadId) });
    expect(read).toBeUndefined();
  });

  it("a new inbound reply un-snoozes the thread early", async () => {
    const first = parsed({ messageIdHeader: "<sn3@ext>" });
    const m1 = await materializeMessage(db, ORG, first, deps);
    await materializeDelivery(db, { orgId: ORG, ...m1, mailboxId: "mb_apex", role: "to", viaAliasId: null, subaddressTag: null, sentAt: first.sentAt });
    await db.update(schema.threadState).set({ snoozedUntil: new Date(Date.now() + 3_600_000) }).where(eq(schema.threadState.threadId, m1.threadId));

    const reply = parsed({ messageIdHeader: "<sn3b@ext>", inReplyTo: "<sn3@ext>", subject: "Re: Hello", sentAt: Date.now() + 1000 });
    const m2 = await materializeMessage(db, ORG, reply, deps);
    await materializeDelivery(db, { orgId: ORG, ...m2, mailboxId: "mb_apex", role: "to", viaAliasId: null, subaddressTag: null, sentAt: reply.sentAt });

    const state = await db.query.threadState.findFirst({ where: eq(schema.threadState.threadId, m1.threadId) });
    expect(state!.snoozedUntil).toBeNull(); // reply woke it
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

  it("does NOT subject-merge two fresh sends (no reply headers)", async () => {
    // Re-sent automated/no-reply mail: same subject + participant, 1 day apart,
    // neither carries In-Reply-To/References. Must be two separate threads.
    const a = parsed({ messageIdHeader: "<w1@ext>", from: "no-reply@sender.com", subject: "Welcome to Doota" });
    const b = parsed({ messageIdHeader: "<w2@ext>", from: "no-reply@sender.com", subject: "Welcome to Doota", sentAt: a.sentAt! + 24 * 3600 * 1000 });
    const m1 = await materializeMessage(db, ORG, a, deps);
    const m2 = await materializeMessage(db, ORG, b, deps);
    expect(m2.threadId).not.toBe(m1.threadId);
  });

  it("still subject-merges a reply whose ancestor we never stored", async () => {
    // A genuine reply (has In-Reply-To) to a message we don't have on record:
    // subject-fallback is exactly the rescue path, so it SHOULD merge.
    const a = parsed({ messageIdHeader: "<s1@ext>", from: "ext@sender.com", subject: "Project update" });
    const m1 = await materializeMessage(db, ORG, a, deps);
    const reply = parsed({
      messageIdHeader: "<s2@ext>", from: "alice@acme.com", to: ["ext@sender.com"],
      inReplyTo: "<never-stored@x>", subject: "Re: Project update", sentAt: a.sentAt! + 1000,
    });
    const m2 = await materializeMessage(db, ORG, reply, deps);
    expect(m2.threadId).toBe(m1.threadId);
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

  it("countUnread: your own reply (role from) does not re-mark a read personal thread unread", async () => {
    await db.insert(schema.user).values({
      id: "u3", name: "u3", email: "u3@x.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    // Inbound lands → unread, then read.
    const pm = parsed({ messageIdHeader: "<own1@ext>" });
    const m1 = await materializeMessage(db, ORG, pm, deps);
    await materializeDelivery(db, { orgId: ORG, ...m1, mailboxId: "mb_apex", role: "to", viaAliasId: null, subaddressTag: null, sentAt: pm.sentAt });
    await db.insert(schema.threadRead).values({
      id: "tr3", orgId: ORG, userId: "u3", threadId: m1.threadId, mailboxId: "mb_apex", lastReadAt: new Date(Date.now() + 1000),
    });
    expect(await countUnread(db, { mailboxId: "mb_apex", userId: "u3" })).toBe(0);

    // You reply: an own `from` delivery, newer than the cursor. It bumps activity
    // (sort) but NOT last_inbound_at — so a personal thread stays read.
    const mine = parsed({ messageIdHeader: "<own2@acme>", inReplyTo: "<own1@ext>", from: "alice@acme.com", sentAt: Date.now() + 60_000 });
    const m2 = await materializeMessage(db, ORG, mine, deps);
    await materializeDelivery(db, { orgId: ORG, ...m2, mailboxId: "mb_apex", role: "from", viaAliasId: null, subaddressTag: null, sentAt: mine.sentAt });
    expect(await countUnread(db, { mailboxId: "mb_apex", userId: "u3" })).toBe(0);
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

describe("thread visibility (personal vs shared)", () => {
  it("personal mailbox sees only messages it was a party to; shared sees the whole thread", async () => {
    const ck = deps.ck;
    // msg1 lands in BOTH the personal (mb_apex) and shared (mb_sub) mailbox.
    const p1 = parsed({ messageIdHeader: "<v1@ext>", subject: "Project" });
    const m1 = await materializeMessage(db, ORG, p1, deps);
    await materializeDelivery(db, { orgId: ORG, ...m1, mailboxId: "mb_apex", role: "to", viaAliasId: null, subaddressTag: null, sentAt: p1.sentAt });
    await materializeDelivery(db, { orgId: ORG, ...m1, mailboxId: "mb_sub", role: "to", viaAliasId: null, subaddressTag: null, sentAt: p1.sentAt });

    // msg2 is a reply that DROPPED alice — delivered only to the shared mailbox.
    const p2 = parsed({ messageIdHeader: "<v2@ext>", inReplyTo: "<v1@ext>", subject: "Re: Project", sentAt: Date.now() + 1000 });
    const m2 = await materializeMessage(db, ORG, p2, deps);
    expect(m2.threadId).toBe(m1.threadId); // same conversation
    await materializeDelivery(db, { orgId: ORG, ...m2, mailboxId: "mb_sub", role: "to", viaAliasId: null, subaddressTag: null, sentAt: p2.sentAt });

    // Personal alice: only the message she was on — the dropped reply must NOT leak.
    const alice = await getThread(db, { threadId: m1.threadId, mailboxId: "mb_apex", ck });
    expect(alice?.items.map((item: any) => item.id)).toEqual([m1.messageId]);

    // Shared support: the whole conversation (team transparency).
    const support = await getThread(db, { threadId: m1.threadId, mailboxId: "mb_sub", ck });
    expect(support?.items.map((item: any) => item.id).sort()).toEqual([m1.messageId, m2.messageId].sort());
  });

  it("a reply whose parent this mailbox can't see carries replyContext (added on Cc)", async () => {
    const ck = deps.ck;
    // Original went to the shared mailbox only — alice was never on it.
    const p1 = parsed({ messageIdHeader: "<c1@ext>", subject: "Deal", text: "the original context here" });
    const m1 = await materializeMessage(db, ORG, p1, deps);
    await materializeDelivery(db, { orgId: ORG, ...m1, mailboxId: "mb_sub", role: "to", viaAliasId: null, subaddressTag: null, sentAt: p1.sentAt });
    // The reply adds alice on Cc — she gets m2 but never saw m1.
    const p2 = parsed({ messageIdHeader: "<c2@ext>", inReplyTo: "<c1@ext>", subject: "Re: Deal", sentAt: Date.now() + 1000, text: "adding you" });
    const m2 = await materializeMessage(db, ORG, p2, deps);
    await materializeDelivery(db, { orgId: ORG, ...m2, mailboxId: "mb_apex", role: "cc", viaAliasId: null, subaddressTag: null, sentAt: p2.sentAt });

    const alice = await getThread(db, { threadId: m1.threadId, mailboxId: "mb_apex", ck });
    expect(alice?.items.map((item: any) => item.id)).toEqual([m2.messageId]); // only the reply is visible
    const ctx = (alice?.items[0] as any).replyContext;
    expect(ctx?.from).toBe("ext@sender.com");
    expect(ctx?.parentId).toBeNull(); // no access → not a jump link
    expect(ctx?.text).toBe("the original context here"); // FULL parent, not a snippet
  });

  it("every reply to a visible message gets a clickable jump reference (WhatsApp-style)", async () => {
    const ck = deps.ck;
    const a = parsed({ messageIdHeader: "<a@ext>", subject: "T", text: "first message body" });
    const ma = await materializeMessage(db, ORG, a, deps);
    await materializeDelivery(db, { orgId: ORG, ...ma, mailboxId: "mb_sub", role: "to", viaAliasId: null, subaddressTag: null, sentAt: a.sentAt });
    const b = parsed({ messageIdHeader: "<b@ext>", inReplyTo: "<a@ext>", subject: "Re: T", sentAt: Date.now() + 1000, text: "second" });
    const mb = await materializeMessage(db, ORG, b, deps);
    await materializeDelivery(db, { orgId: ORG, ...mb, mailboxId: "mb_sub", role: "to", viaAliasId: null, subaddressTag: null, sentAt: b.sentAt });
    // c replies to a (the OLDER message), not to b right above it.
    const c = parsed({ messageIdHeader: "<c@ext>", inReplyTo: "<a@ext>", subject: "Re: T", sentAt: Date.now() + 2000, text: "third" });
    const mc = await materializeMessage(db, ORG, c, deps);
    await materializeDelivery(db, { orgId: ORG, ...mc, mailboxId: "mb_sub", role: "to", viaAliasId: null, subaddressTag: null, sentAt: c.sentAt });

    const t = await getThread(db, { threadId: ma.threadId, mailboxId: "mb_sub", ck }); // shared: sees all
    const byId = new Map(t!.items.map((item: any) => [item.id, item]));
    // b replies to a — the message directly above — and still gets a jump reference.
    expect((byId.get(mb.messageId) as any).replyContext?.parentId).toBe(ma.messageId);
    const cx = (byId.get(mc.messageId) as any).replyContext;
    expect(cx?.parentId).toBe(ma.messageId); // c jumps to the older message
    expect(cx?.text).toContain("first message");
  });

  it("countUnread: a hidden newer message does NOT phantom-unread a personal mailbox", async () => {
    await db.insert(schema.user).values({
      id: "u9", name: "u9", email: "u9@x.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    const p1 = parsed({ messageIdHeader: "<u1v@ext>" });
    const m1 = await materializeMessage(db, ORG, p1, deps);
    await materializeDelivery(db, { orgId: ORG, ...m1, mailboxId: "mb_apex", role: "to", viaAliasId: null, subaddressTag: null, sentAt: p1.sentAt });
    await db.insert(schema.threadRead).values({
      id: "tr9", orgId: ORG, userId: "u9", threadId: m1.threadId, mailboxId: "mb_apex", lastReadAt: new Date(Date.now() + 500),
    });
    expect(await countUnread(db, { mailboxId: "mb_apex", userId: "u9" })).toBe(0);

    // Newer reply that DROPPED alice — delivered only to the shared mailbox → hidden.
    const p2 = parsed({ messageIdHeader: "<u2v@ext>", inReplyTo: "<u1v@ext>", sentAt: Date.now() + 60_000 });
    const m2 = await materializeMessage(db, ORG, p2, deps);
    await materializeDelivery(db, { orgId: ORG, ...m2, mailboxId: "mb_sub", role: "to", viaAliasId: null, subaddressTag: null, sentAt: p2.sentAt });
    expect(await countUnread(db, { mailboxId: "mb_apex", userId: "u9" })).toBe(0); // NOT phantom-unread

    // A newer reply she IS on flips it unread.
    const p3 = parsed({ messageIdHeader: "<u3v@ext>", inReplyTo: "<u1v@ext>", sentAt: Date.now() + 120_000 });
    const m3 = await materializeMessage(db, ORG, p3, deps);
    await materializeDelivery(db, { orgId: ORG, ...m3, mailboxId: "mb_apex", role: "to", viaAliasId: null, subaddressTag: null, sentAt: p3.sentAt });
    expect(await countUnread(db, { mailboxId: "mb_apex", userId: "u9" })).toBe(1);
  });
});

describe("materialize — render flags computed at ingest", () => {
  it("stores htmlKind='rich' + hasRemoteImages + per-attachment inline from the html", async () => {
    const pm = parsed({
      messageIdHeader: "<rich@ext>",
      html: '<table><tr><td>x</td></tr></table><img src="cid:logo@x"><img src="https://t.co/p.gif">',
      attachments: [
        { partId: "logo@x", filename: "logo.png", contentType: "image/png", size: 10, r2Key: "k1" },
        { partId: "9", filename: "r.pdf", contentType: "application/pdf", size: 20, r2Key: "k2" },
      ],
    });
    const { messageId } = await materializeMessage(db, ORG, pm, deps);
    const m = await db.query.message.findFirst({ where: eq(schema.message.id, messageId) });
    expect(m.htmlKind).toBe("rich");
    expect(m.hasRemoteImages).toBe(true);
    const atts = await db.query.attachment.findMany({ where: eq(schema.attachment.messageId, messageId) });
    expect(atts.find((attachment: any) => attachment.partId === "logo@x").inline).toBe(true); // cid-referenced
    expect(atts.find((attachment: any) => attachment.partId === "9").inline).toBe(false);
  });

  it("strips quotes before deciding htmlKind (blockquote-only-rich → plain)", async () => {
    const pm = parsed({
      messageIdHeader: "<qk@ext>",
      text: "Glad to hear it!",
      html: "<p>Glad to hear it!</p><blockquote>On Sun, ether wrote: fine</blockquote>",
    });
    const { messageId } = await materializeMessage(db, ORG, pm, deps);
    const m = await db.query.message.findFirst({ where: eq(schema.message.id, messageId) });
    expect(m.htmlKind).toBe("plain");
    expect(m.hasRemoteImages).toBe(false);
  });
});
