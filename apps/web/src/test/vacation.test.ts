// SPDX-License-Identifier: Apache-2.0
// Phase 4 stop gates (client-gaps build guide): the RFC 3834 test matrix —
// every "never reply" condition asserts NO reply was sent; the loop test
// proves two responders exchange at most one message each; the outgoing reply
// carries Auto-Submitted: auto-replied through the provider filter.
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { importKey } from "@doota/mail-core/crypto";
import {
  vacationSuppressReason,
  maybeVacationReply,
  type VacationCheckInput,
} from "@doota/mail-core/vacation";
import { processSubmission } from "@doota/mail-core/outbound-consumer";
import { invalidateDomainCache } from "@doota/db/org-domains";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const ORG = "org1";

let db: any;
let ck: Awaited<ReturnType<typeof importKey>>;
let r2: any;
let queue: any;
let kv: any;

function fakeR2() {
  const store = new Map<string, any>();
  return {
    store,
    async put(key: string, val: any) {
      store.set(key, typeof val === "string" ? new TextEncoder().encode(val).buffer : val);
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const v = store.get(key);
      return { arrayBuffer: async () => v, text: async () => new TextDecoder().decode(v) };
    },
  };
}
function fakeQueue() {
  const sent: any[] = [];
  return { sent, async send(body: any) { sent.push(body); } };
}
function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, val: string) { store.set(key, val); },
  };
}

async function seed() {
  await db.insert(schema.organization).values({
    id: ORG, name: "Acme", slug: "acme-com", domain: "acme.com", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.orgMailSettings).values({
    orgId: ORG, subaddressingEnabled: false, routingSubdomains: "[]", returnPathDomain: "bounce.acme.com",
  });
  await db.insert(schema.user).values({
    id: "u1", name: "u1", email: "u1@x.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(schema.mailbox).values({
    id: "mb1", orgId: ORG, localPart: "alice", address: "alice@acme.com", isActive: true, isPersonal: true,
  });
  await db.insert(schema.mailboxAccess).values({ id: "acc1", userId: "u1", mailboxId: "mb1", canSend: true });
  await db.insert(schema.mailboxVacation).values({
    mailboxId: "mb1", orgId: ORG, enabled: true, enabledByUserId: "u1",
    subject: "", bodyText: "Away until Monday.", intervalDays: 4,
  });
  invalidateDomainCache();
}

beforeEach(async () => {
  db = await makeDb();
  await seed();
  ck = await importKey(KEY_B64);
  r2 = fakeR2();
  queue = fakeQueue();
  kv = fakeKv();
});

function env() {
  return {
    MAIL_DEK: KEY_B64, MAIL_SEARCH_KEY: KEY_B64,
    MAIL_RAW: r2 as never, MAIL_OUT_QUEUE: queue as never, AUTH_KV: kv as never,
  };
}

const check = (over: Partial<VacationCheckInput> = {}): Omit<VacationCheckInput, "mailboxAddress"> => ({
  junk: false,
  envelopeFrom: "friend@ext.com",
  role: "to",
  headers: [],
  fromAddress: "friend@ext.com",
  ...over,
});

async function attempt(over: Partial<VacationCheckInput> = {}, messageId = `<${crypto.randomUUID()}@ext>`) {
  return maybeVacationReply(db, env(), {
    mailboxId: "mb1", orgId: ORG, check: check(over), messageIdHeader: messageId, subject: "Hi",
  });
}

async function submissionCount() {
  return (await db.query.submission.findMany({ where: eq(schema.submission.orgId, ORG) })).length;
}

describe("RFC 3834 never-reply matrix — each asserts NO reply", () => {
  const cases: [string, Partial<VacationCheckInput>, string][] = [
    ["null return-path (bounce)", { envelopeFrom: "" }, "null_return_path"],
    ["explicit <> return-path", { envelopeFrom: "<>" }, "null_return_path"],
    ["Auto-Submitted: auto-replied", { headers: [{ key: "Auto-Submitted", value: "auto-replied" }] }, "auto_submitted"],
    ["Auto-Submitted: auto-generated", { headers: [{ key: "auto-submitted", value: "auto-generated" }] }, "auto_submitted"],
    ["Precedence: bulk", { headers: [{ key: "Precedence", value: "bulk" }] }, "precedence"],
    ["Precedence: list", { headers: [{ key: "Precedence", value: "list" }] }, "precedence"],
    ["Precedence: junk", { headers: [{ key: "Precedence", value: "junk" }] }, "precedence"],
    ["List-Id present", { headers: [{ key: "List-Id", value: "<dev.lists.example.com>" }] }, "list_mail"],
    ["List-Unsubscribe present", { headers: [{ key: "List-Unsubscribe", value: "<mailto:u@x>" }] }, "list_mail"],
    ["own address not in To/Cc (bcc'd)", { role: "bcc" }, "not_addressed"],
    ["classified junk", { junk: true }, "junk"],
    ["our own forward marker", { headers: [{ key: "X-Doota-Forwarded", value: "1" }] }, "doota_forward"],
  ];
  for (const [name, over, reason] of cases) {
    it(name, async () => {
      const res = await attempt(over);
      expect(res).toEqual({ sent: false, reason });
      expect(await submissionCount()).toBe(0);
    });
  }

  it("Auto-Submitted: no is NOT a suppression", () => {
    expect(
      vacationSuppressReason({ ...check({ headers: [{ key: "Auto-Submitted", value: "no" }] }), mailboxAddress: "alice@acme.com" }),
    ).toBeNull();
  });

  it("never replies to itself", async () => {
    const res = await attempt({ envelopeFrom: "alice@acme.com", fromAddress: "alice@acme.com" });
    expect(res).toEqual({ sent: false, reason: "self" });
  });
});

describe("the reply itself", () => {
  it("sends once, marks Auto-Submitted: auto-replied on the WIRE, threads on the trigger", async () => {
    const res = await attempt({}, "<trigger@ext>");
    expect(res.sent).toBe(true);
    expect(await submissionCount()).toBe(1);

    // Drive the real consumer: the header must survive the provider filter
    // (it's on Cloudflare's allowlist) — that is what stops the OTHER side's
    // responder from answering.
    const sub = await db.query.submission.findFirst({ where: eq(schema.submission.orgId, ORG) });
    const calls: any[] = [];
    const sender = { calls, async send(email: any) { calls.push(email); return { messageId: "pm_1" }; } };
    await processSubmission(
      db,
      { DB: {} as never, MAIL_RAW: r2, MAIL_DEK: KEY_B64, MAIL_SEARCH_KEY: KEY_B64, EMAIL_SENDER: sender as never, MAIL_OUT_QUEUE: queue as never },
      ck,
      { body: { submissionId: sub.id }, ack: () => {}, retry: () => {} },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["Auto-Submitted"]).toBe("auto-replied");
    expect(calls[0].to).toEqual(["friend@ext.com"]);
  });

  it("dedupes per sender within the interval (KV TTL), and per message on redelivery", async () => {
    const first = await attempt({}, "<t1@ext>");
    expect(first.sent).toBe(true);
    const second = await attempt({}, "<t2@ext>");
    expect(second).toEqual({ sent: false, reason: "deduped" });
    expect(await submissionCount()).toBe(1);
    // Redelivered job for the SAME message: idempotency key dedupes even
    // without KV.
    kv.store.clear();
    const redelivered = await attempt({}, "<t1@ext>");
    expect(redelivered.sent).toBe(true); // enqueueSend returned the existing row
    expect(await submissionCount()).toBe(1);
  });

  it("window gating: disabled / not started / ended", async () => {
    await db.update(schema.mailboxVacation).set({ enabled: false }).where(eq(schema.mailboxVacation.mailboxId, "mb1"));
    expect((await attempt()).reason).toBe("disabled");
    await db.update(schema.mailboxVacation)
      .set({ enabled: true, startsAt: new Date(Date.now() + 86_400_000) })
      .where(eq(schema.mailboxVacation.mailboxId, "mb1"));
    expect((await attempt()).reason).toBe("not_started");
    await db.update(schema.mailboxVacation)
      .set({ startsAt: null, endsAt: new Date(Date.now() - 1000) })
      .where(eq(schema.mailboxVacation.mailboxId, "mb1"));
    expect((await attempt()).reason).toBe("ended");
  });

  it("own hourly ceiling caps a mail bomb", async () => {
    let sent = 0;
    for (let i = 0; i < 35; i++) {
      const res = await attempt(
        { envelopeFrom: `bomb${i}@ext.com`, fromAddress: `bomb${i}@ext.com` },
        `<bomb${i}@ext>`,
      );
      if (res.sent) sent++;
      else expect(res.reason).toBe("rate_hourly");
    }
    expect(sent).toBe(30);
  });
});

describe("loop test — two responders exchange at most one message each", () => {
  it("A's auto-reply arriving at B (Auto-Submitted) never triggers B's responder", async () => {
    // A replies to a human mail from B's address.
    const aReply = await attempt({ envelopeFrom: "bob@other.com", fromAddress: "bob@other.com" }, "<human@other>");
    expect(aReply.sent).toBe(true);

    // That reply lands at B — carrying Auto-Submitted: auto-replied. B's
    // responder (same code) must stay silent. B replying zero times means A
    // also never gets a counter-reply: total exchange = 1 message each max.
    const bSide = vacationSuppressReason({
      junk: false,
      envelopeFrom: "alice@acme.com",
      role: "to",
      headers: [{ key: "Auto-Submitted", value: "auto-replied" }],
      fromAddress: "alice@acme.com",
      mailboxAddress: "bob@other.com",
    });
    expect(bSide).toBe("auto_submitted");
  });
});
