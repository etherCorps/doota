import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { invalidateDomainCache } from "@doota/db/org-domains";
import { importKey } from "@doota/mail-core/crypto";
import { enqueueSend, cancelSend, sweepDueSubmissions } from "@doota/mail-core/outbound";
import { processSubmission } from "@doota/mail-core/outbound-consumer";
import { parseBounce, looksLikeBounce, applyBounce } from "@doota/mail-core/bounce";
import {
  buildQuotedText,
  buildQuotedHtml,
  threadingHeaders,
  mintMessageId,
  tickForStatus,
} from "@doota/mail-core/mail-thread-contract";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const ORG = "org1";

// ---- fakes -------------------------------------------------------------------

function fakeR2() {
  const store = new Map<string, string | ArrayBuffer>();
  return {
    store,
    async put(key: string, val: string | ArrayBuffer) {
      store.set(key, val);
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const v = store.get(key)!;
      return {
        async text() {
          return typeof v === "string" ? v : new TextDecoder().decode(v);
        },
        async arrayBuffer() {
          return typeof v === "string" ? new TextEncoder().encode(v).buffer : v;
        },
      };
    },
  };
}

function fakeQueue() {
  const sent: { body: unknown; opts?: unknown }[] = [];
  return { sent, async send(body: unknown, opts?: unknown) { sent.push({ body, opts }); } };
}

type Builder = { to: string[]; cc?: string[]; bcc?: string[]; headers?: Record<string, string>; subject: string; text?: string; html?: string };
function fakeSender(behavior?: (b: Builder, n: number) => { messageId: string }) {
  const calls: Builder[] = [];
  return {
    calls,
    async send(builder: Builder) {
      calls.push(builder);
      return behavior ? behavior(builder, calls.length) : { messageId: `pm_${calls.length}` };
    },
  };
}

function msg(submissionId: string) {
  return { body: { submissionId }, ack: vi.fn(), retry: vi.fn() };
}

// ---- seed --------------------------------------------------------------------

async function seed(db: any) {
  await db.insert(schema.organization).values({
    id: ORG, name: "Acme", slug: "acme-com", domain: "acme.com", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.orgMailSettings).values({
    orgId: ORG, subaddressingEnabled: false, routingSubdomains: "[]", returnPathDomain: "bounce.acme.com",
  });
  const u = (id: string, email: string) => ({
    id, name: id, email, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(schema.user).values([u("u1", "alice-ext@x.com"), u("u2", "bob-ext@x.com")]);
  await db.insert(schema.mailbox).values([
    { id: "mb_alice", orgId: ORG, localPart: "alice", address: "alice@acme.com", isActive: true, isPersonal: true },
    { id: "mb_bob", orgId: ORG, localPart: "bob", address: "bob@acme.com", isActive: true, isPersonal: true },
  ]);
  await db.insert(schema.mailboxAccess).values([
    { id: "acc1", userId: "u1", mailboxId: "mb_alice", canManage: true, canSend: true },
    { id: "acc2", userId: "u2", mailboxId: "mb_bob", canManage: true, canSend: true },
  ]);
  invalidateDomainCache();
}

let db: any;
let ck: Awaited<ReturnType<typeof importKey>>;
let r2: ReturnType<typeof fakeR2>;
let queue: ReturnType<typeof fakeQueue>;

function enqEnv() {
  return { MAIL_DEK: KEY_B64, MAIL_SEARCH_KEY: KEY_B64, MAIL_RAW: r2 as never, MAIL_OUT_QUEUE: queue as never };
}
function consEnv(sender: ReturnType<typeof fakeSender>) {
  return {
    DB: {} as never, MAIL_RAW: r2 as never, MAIL_DEK: KEY_B64, MAIL_SEARCH_KEY: KEY_B64,
    EMAIL_SENDER: sender as never, MAIL_OUT_QUEUE: queue as never,
  };
}

const baseReq = (over: Partial<Parameters<typeof enqueueSend>[2]> = {}) => ({
  orgId: ORG, mailboxId: "mb_alice", createdByUserId: "u1", fromAddress: "alice@acme.com",
  subject: "Hi", text: "hello there", idempotencyKey: crypto.randomUUID(),
  ...over,
});

beforeEach(async () => {
  db = await makeDb();
  await seed(db);
  ck = await importKey(KEY_B64);
  r2 = fakeR2();
  queue = fakeQueue();
});

// ---- pure helpers ------------------------------------------------------------

describe("outbound construction (Part E)", () => {
  it("mints an owned Message-ID on the sending domain", () => {
    expect(mintMessageId("acme.com")).toMatch(/^<[0-9a-f-]+@acme\.com>$/);
  });

  it("builds In-Reply-To + References from the parent (external threading)", () => {
    const h = threadingHeaders({ messageIdHeader: "<p2@acme.com>", references: "<p0@x> <p1@x>" });
    expect(h["In-Reply-To"]).toBe("<p2@acme.com>");
    expect(h.References).toBe("<p0@x> <p1@x> <p2@acme.com>");
  });

  it("re-quotes parent history into text + html replies", () => {
    const parent = { from: "bob@x.com", sentAt: Date.parse("2026-01-01T00:00:00Z"), bodyFull: "old line" };
    expect(buildQuotedText("new reply", parent)).toContain("> old line");
    expect(buildQuotedText("new reply", parent)).toMatch(/wrote:/);
    expect(buildQuotedHtml("<p>hi</p>", parent)).toContain("<blockquote");
  });

  it("maps status to WhatsApp ticks (Part H)", () => {
    expect(tickForStatus("queued")).toBe("clock");
    expect(tickForStatus("sent")).toBe("single");
    expect(tickForStatus("delivered")).toBe("double");
    expect(tickForStatus("bounced_hard")).toBe("warning");
  });
});

describe("bounce parsing (Part F)", () => {
  it("recognizes a DSN by null sender / mailer-daemon / return-path", () => {
    expect(looksLikeBounce({ envelopeFrom: "", fromAddress: null, subject: null, recipient: null, returnPathDomain: null })).toBe(true);
    expect(looksLikeBounce({ envelopeFrom: "x", fromAddress: "MAILER-DAEMON@mx.google.com", subject: null, recipient: null, returnPathDomain: null })).toBe(true);
    expect(looksLikeBounce({ envelopeFrom: "x", fromAddress: "friend@x.com", subject: "hi", recipient: "b@bounce.acme.com", returnPathDomain: "bounce.acme.com" })).toBe(true);
    expect(looksLikeBounce({ envelopeFrom: "x", fromAddress: "friend@x.com", subject: "hi", recipient: "a@acme.com", returnPathDomain: "bounce.acme.com" })).toBe(false);
  });

  it("parses hard vs soft + original Message-ID", () => {
    const hard = parseBounce("Message-ID: <orig@acme.com>\nFinal-Recipient: rfc822; dead@x.com\nAction: failed\nStatus: 5.1.1");
    expect(hard.originalMessageId).toBe("<orig@acme.com>");
    expect(hard.failures).toEqual([{ address: "dead@x.com", kind: "hard" }]);
    const soft = parseBounce("Final-Recipient: rfc822; busy@x.com\nStatus: 4.2.2");
    expect(soft.failures[0].kind).toBe("soft");
  });
});

// ---- integration -------------------------------------------------------------

describe("enqueue + sender copy (Parts B/D)", () => {
  it("writes submission + recipients + sender copy in Sent", async () => {
    const { submissionId, threadId } = await enqueueSend(db, enqEnv(), baseReq({ to: ["out@ext.com"] }));
    const sub = await db.query.submission.findFirst({ where: eq(schema.submission.id, submissionId) });
    expect(sub.status).toBe("queued");
    const recips = await db.query.submissionRecipient.findMany({ where: eq(schema.submissionRecipient.submissionId, submissionId) });
    expect(recips.map((r: any) => r.address)).toEqual(["out@ext.com"]);
    // Sender's own copy: a `from` delivery + thread_state placed in `sent`.
    const fromDel = await db.query.delivery.findFirst({ where: eq(schema.delivery.mailboxId, "mb_alice") });
    expect(fromDel.role).toBe("from");
    const ts = await db.query.threadState.findFirst({ where: eq(schema.threadState.threadId, threadId) });
    expect(ts.placement).toBe("sent");
    expect(queue.sent.length).toBe(1);
  });

  it("dedupes on idempotency key (double-send guard)", async () => {
    const key = "idem-1";
    const a = await enqueueSend(db, enqEnv(), baseReq({ to: ["out@ext.com"], idempotencyKey: key }));
    const b = await enqueueSend(db, enqEnv(), baseReq({ to: ["out@ext.com"], idempotencyKey: key }));
    expect(b.deduped).toBe(true);
    expect(b.submissionId).toBe(a.submissionId);
    const count = (await db.query.submission.findMany({ where: eq(schema.submission.orgId, ORG) })).length;
    expect(count).toBe(1);
  });
});

describe("consumer send (Parts B/C/G)", () => {
  async function ready(over: Partial<Parameters<typeof enqueueSend>[2]> = {}) {
    const { submissionId } = await enqueueSend(db, enqEnv(), baseReq({ undoSeconds: 0, ...over }));
    return submissionId;
  }

  it("sends external recipients and marks them sent", async () => {
    const id = await ready({ to: ["out@ext.com"] });
    const sender = fakeSender();
    const m = msg(id);
    await processSubmission(db, consEnv(sender), ck, m);
    expect(sender.calls.length).toBe(1);
    expect(m.ack).toHaveBeenCalled();
    const r = await db.query.submissionRecipient.findFirst({ where: eq(schema.submissionRecipient.submissionId, id) });
    expect(r.status).toBe("sent");
  });

  it("does NOT re-send on redelivery (idempotent)", async () => {
    const id = await ready({ to: ["out@ext.com"] });
    const sender = fakeSender();
    await processSubmission(db, consEnv(sender), ck, msg(id));
    await processSubmission(db, consEnv(sender), ck, msg(id)); // redelivery
    expect(sender.calls.length).toBe(1);
  });

  it("chunks recipients at 50 per provider call", async () => {
    const to = Array.from({ length: 60 }, (_, i) => `r${i}@ext.com`);
    const id = await ready({ to });
    const sender = fakeSender();
    await processSubmission(db, consEnv(sender), ck, msg(id));
    expect(sender.calls.length).toBe(2);
    expect(sender.calls[0].to.length).toBe(50);
    expect(sender.calls[1].to.length).toBe(10);
  });

  it("splits mixed internal/external under one submission", async () => {
    const id = await ready({ to: ["bob@acme.com", "out@ext.com"] });
    const sender = fakeSender();
    await processSubmission(db, consEnv(sender), ck, msg(id));
    // External went to the provider; internal did NOT.
    expect(sender.calls.length).toBe(1);
    expect(sender.calls[0].to).toEqual(["out@ext.com"]);
    const recips = await db.query.submissionRecipient.findMany({ where: eq(schema.submissionRecipient.submissionId, id) });
    const byAddr = Object.fromEntries(recips.map((r: any) => [r.address, r.status]));
    expect(byAddr["bob@acme.com"]).toBe("delivered"); // materialized directly
    expect(byAddr["out@ext.com"]).toBe("sent");
    // Internal recipient got a real delivery row into their mailbox.
    const bobDel = await db.query.delivery.findFirst({ where: eq(schema.delivery.mailboxId, "mb_bob") });
    expect(bobDel).toBeTruthy();
  });

  it("keeps BCC out of transmitted headers (envelope-only)", async () => {
    const id = await ready({ to: ["open@ext.com"], bcc: ["secret@ext.com"] });
    const sender = fakeSender();
    await processSubmission(db, consEnv(sender), ck, msg(id));
    const b = sender.calls[0];
    expect(b.bcc).toContain("secret@ext.com");
    expect(b.to).not.toContain("secret@ext.com");
    expect(JSON.stringify(b.headers ?? {})).not.toContain("secret@ext.com");
  });

  it("rejects when the rate-limit cap is exceeded", async () => {
    // Pre-fill the mailbox window to its cap so the next send trips it.
    const HOUR = 60 * 60 * 1000;
    const ws = new Date(Math.floor(Date.now() / HOUR) * HOUR);
    await db.insert(schema.sendCounter).values({ scope: "mailbox", scopeKey: "mb_alice", windowStart: ws, count: 500 });
    const id = await ready({ to: ["out@ext.com"] });
    const sender = fakeSender();
    await processSubmission(db, consEnv(sender), ck, msg(id));
    expect(sender.calls.length).toBe(0);
    const sub = await db.query.submission.findFirst({ where: eq(schema.submission.id, id) });
    expect(sub.status).toBe("failed");
    expect(sub.lastError).toMatch(/rate limit/);
  });

  it("threads a reply with In-Reply-To + References for external clients", async () => {
    // First send establishes a parent message with our own Message-ID.
    const first = await enqueueSend(db, enqEnv(), baseReq({ to: ["out@ext.com"], undoSeconds: 0 }));
    const parentMsg = await db.query.message.findFirst({ where: eq(schema.message.id, first.messageId), columns: { messageIdHeader: true } });
    const parentId = parentMsg.messageIdHeader;
    // Reply referencing it.
    const reply = await enqueueSend(db, enqEnv(), baseReq({ to: ["out@ext.com"], parentMessageId: parentId, undoSeconds: 0 }));
    const sender = fakeSender();
    await processSubmission(db, consEnv(sender), ck, msg(reply.submissionId));
    expect(sender.calls[0].headers?.["In-Reply-To"]).toBe(parentId);
    expect(sender.calls[0].headers?.["References"]).toContain(parentId);
  });
});

describe("undo (Part I)", () => {
  it("cancels within the window, and the consumer then no-ops", async () => {
    const { submissionId } = await enqueueSend(db, enqEnv(), baseReq({ to: ["out@ext.com"], undoSeconds: 30 }));
    expect(await cancelSend(db, submissionId)).toBe(true);
    const sub = await db.query.submission.findFirst({ where: eq(schema.submission.id, submissionId) });
    expect(sub.status).toBe("canceled");
    const sender = fakeSender();
    const m = msg(submissionId);
    await processSubmission(db, consEnv(sender), ck, m);
    expect(sender.calls.length).toBe(0);
    expect(m.ack).toHaveBeenCalled();
  });

  it("cannot cancel once the window has closed", async () => {
    const { submissionId } = await enqueueSend(db, enqEnv(), baseReq({ to: ["out@ext.com"], undoSeconds: 0 }));
    await db.update(schema.submission).set({ undoUntil: new Date(Date.now() - 1000) }).where(eq(schema.submission.id, submissionId));
    expect(await cancelSend(db, submissionId)).toBe(false);
  });
});

describe("scheduled send sweep (Part B.3)", () => {
  it("enqueues due submissions whose hold elapsed", async () => {
    const { submissionId } = await enqueueSend(db, enqEnv(), baseReq({ to: ["out@ext.com"], undoSeconds: 0 }));
    // Simulate a scheduled row that was never enqueued (past due, still queued).
    await db.update(schema.submission).set({ undoUntil: new Date(Date.now() - 1000) }).where(eq(schema.submission.id, submissionId));
    const q = fakeQueue();
    const n = await sweepDueSubmissions(db, q as never);
    expect(n).toBe(1);
    expect(q.sent[0].body).toEqual({ submissionId });
  });
});

describe("retries + bounces (Parts B/F)", () => {
  it("retries a soft provider failure, then gives up after the cap", async () => {
    const id = (await enqueueSend(db, enqEnv(), baseReq({ to: ["out@ext.com"], undoSeconds: 0 }))).submissionId;
    const softSender = fakeSender(() => { throw new Error("temporary glitch"); });

    // Fresh attempt → soft error re-thrown so the batch handler retries.
    await expect(processSubmission(db, consEnv(softSender), ck, msg(id))).rejects.toThrow(/glitch/);

    // At the attempt cap → give up: submission failed, job acked (no more retries).
    await db.update(schema.submission).set({ attempts: 4, status: "queued" }).where(eq(schema.submission.id, id));
    const m = msg(id);
    await processSubmission(db, consEnv(softSender), ck, m);
    expect(m.ack).toHaveBeenCalled();
    const sub = await db.query.submission.findFirst({ where: eq(schema.submission.id, id) });
    expect(sub.status).toBe("failed");
  });

  it("a hard bounce suppresses the address and blocks the next send", async () => {
    // Send once to get a submission + our Message-ID.
    const first = await enqueueSend(db, enqEnv(), baseReq({ to: ["dead@ext.com"], undoSeconds: 0 }));
    const parentMsg = await db.query.message.findFirst({ where: eq(schema.message.id, first.messageId), columns: { messageIdHeader: true } });
    await processSubmission(db, consEnv(fakeSender()), ck, msg(first.submissionId));

    // A DSN comes back referencing that Message-ID.
    const dsn = parseBounce(`Message-ID: ${parentMsg.messageIdHeader}\nFinal-Recipient: rfc822; dead@ext.com\nStatus: 5.1.1`);
    await applyBounce(db, ORG, dsn);
    const supp = await db.query.suppression.findFirst({ where: eq(schema.suppression.address, "dead@ext.com") });
    expect(supp.reason).toBe("hard_bounce");
    const bouncedRecip = await db.query.submissionRecipient.findFirst({ where: eq(schema.submissionRecipient.submissionId, first.submissionId) });
    expect(bouncedRecip.status).toBe("bounced");

    // Next send to the suppressed address is dropped before the provider.
    const second = await enqueueSend(db, enqEnv(), baseReq({ to: ["dead@ext.com"], undoSeconds: 0 }));
    const sender = fakeSender();
    await processSubmission(db, consEnv(sender), ck, msg(second.submissionId));
    expect(sender.calls.length).toBe(0);
    const dropped = await db.query.submissionRecipient.findFirst({ where: eq(schema.submissionRecipient.submissionId, second.submissionId) });
    expect(dropped.status).toBe("dropped");
  });
});
