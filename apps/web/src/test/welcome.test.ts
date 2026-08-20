// SPDX-License-Identifier: Apache-2.0
// The welcome message seeded into a new mailbox. The whole design rests on it
// being a REAL message rather than fabricated rows, so the test proves exactly
// that: the synthesized RFC822 survives the SAME PostalMime the inbound
// consumer uses, materializes into a normal message + delivery, and converges
// rather than duplicating when a retried provision seeds it twice.
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import PostalMime from "postal-mime";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { importKey, getDecryptedBlob, type ContentKey } from "@doota/mail-core/crypto";
import { materializeMessage, materializeDelivery, type ParsedMessage } from "@doota/mail-core/materialize";
import { buildWelcomeRaw, seedWelcomeMessage, welcomeMessageId } from "@doota/mail-core/welcome";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const ORG = "org1";
const MAILBOX = "mb_alice";
const ADDRESS = "alice@acme.com";

const INPUT = {
  orgId: ORG,
  mailboxId: MAILBOX,
  address: ADDRESS,
  displayName: "Alice",
  from: "no-reply@acme.com",
  appOrigin: "https://mail.acme.com/",
};

function fakeR2() {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    async put(key: string, val: any) {
      store.set(key, typeof val === "string" ? new TextEncoder().encode(val).buffer : val);
    },
    async get(key: string) {
      const v = store.get(key);
      return v ? { arrayBuffer: async () => v } : null;
    },
  };
}
function fakeQueue() {
  const sent: any[] = [];
  return { sent, async send(body: any) { sent.push(body); } };
}

let db: any;
let ck: ContentKey;
let r2: ReturnType<typeof fakeR2>;
let queue: ReturnType<typeof fakeQueue>;

beforeEach(async () => {
  db = await makeDb();
  await db.insert(schema.organization).values({
    id: ORG, name: "Acme", slug: "acme-com", domain: "acme.com", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.mailbox).values({
    id: MAILBOX, orgId: ORG, localPart: "alice", address: ADDRESS, isActive: true, isPersonal: true,
  });
  ck = await importKey(KEY_B64);
  r2 = fakeR2();
  queue = fakeQueue();
});

/** Run the seeded raw through the consumer's own parse + materialize path. */
async function ingestSeeded(): Promise<{ messageId: string; threadId: string }> {
  const job = queue.sent[queue.sent.length - 1];
  const buf = await getDecryptedBlob(r2 as never, job.r2RawKey, ck);
  const parsed = (await PostalMime.parse(buf!)) as any;
  const pm: ParsedMessage = {
    messageIdHeader: job.messageIdHeader,
    inReplyTo: null,
    references: null,
    from: INPUT.from,
    subject: parsed.subject,
    sentAt: Date.now(),
    text: parsed.text ?? null,
    html: parsed.html ?? null,
    r2RawKey: job.r2RawKey,
    attachments: [],
  };
  const out = await materializeMessage(db, ORG, pm, { ck, searchKeyB64: KEY_B64 });
  await materializeDelivery(db, {
    orgId: ORG,
    messageId: out.messageId,
    threadId: out.threadId,
    mailboxId: MAILBOX,
    role: "to",
    viaAliasId: null,
    subaddressTag: null,
    sentAt: Date.now(),
  });
  return out;
}

describe("welcome message — RFC822 shape", () => {
  it("parses with the real PostalMime and carries both body parts", async () => {
    const { raw } = buildWelcomeRaw(INPUT);
    const parsed = (await PostalMime.parse(raw)) as any;

    expect(parsed.subject).toBe("Welcome to Doota");
    // Both halves of the multipart/alternative must survive: the HTML is what
    // renders, the text twin is what gets indexed and shown as list preview.
    expect(parsed.html).toContain("Conversations, not messages");
    expect(parsed.text).toContain("Conversations, not messages");
    expect(parsed.text).toContain(ADDRESS);
  });

  it("addresses the new mailbox and names the person", async () => {
    const parsed = (await PostalMime.parse(buildWelcomeRaw(INPUT).raw)) as any;
    expect(parsed.to?.[0]?.address).toBe(ADDRESS);
    expect(parsed.from?.address).toBe(INPUT.from);
    expect(parsed.text).toContain("Hi Alice,");
  });

  it("falls back to a nameless greeting", async () => {
    const parsed = (await PostalMime.parse(
      buildWelcomeRaw({ ...INPUT, displayName: null }).raw,
    )) as any;
    expect(parsed.text).toContain("Hi,");
    expect(parsed.text).not.toContain("Hi null");
  });

  it("marks itself auto-generated so no responder answers it", () => {
    // RFC 3834 — our own vacation stage and any forwarding destination's
    // responder both key off this. A welcome message that triggers an
    // auto-reply loop would be a spectacular own goal.
    expect(buildWelcomeRaw(INPUT).raw).toContain("Auto-Submitted: auto-generated");
  });

  it("is byte-identical across rebuilds for the same mailbox", () => {
    // The idempotent R2 put depends on this — a random MIME boundary or a
    // re-read clock would write a second object under the same key.
    const at = new Date("2026-08-20T04:00:00Z");
    expect(buildWelcomeRaw({ ...INPUT, sentAt: at }).raw).toBe(
      buildWelcomeRaw({ ...INPUT, sentAt: at }).raw,
    );
  });

  it("derives the message id from the mailbox, not the clock", () => {
    expect(buildWelcomeRaw(INPUT).messageId).toBe(welcomeMessageId(MAILBOX, "acme.com"));
  });

  it("escapes the display name into the HTML part", async () => {
    const raw = buildWelcomeRaw({ ...INPUT, displayName: '<img src=x onerror="alert(1)">' }).raw;
    const parsed = (await PostalMime.parse(raw)) as any;
    // The HTML part must carry it inert. (The text/plain twin holds the literal
    // characters, which is correct — it is text, and renders as a text bubble.)
    expect(parsed.html).not.toContain("<img src=x");
    expect(parsed.html).toContain("&lt;img src=x");
  });

  it("cannot be folded into an injected header", async () => {
    const raw = buildWelcomeRaw({ ...INPUT, from: "evil@acme.com\r\nBcc: victim@elsewhere.test" }).raw;
    expect(raw).not.toContain("Bcc: victim@elsewhere.test\r\n");
    const parsed = (await PostalMime.parse(raw)) as any;
    expect(parsed.bcc ?? []).toHaveLength(0);
  });
});

describe("welcome message — seeding", () => {
  it("stages an encrypted raw and enqueues an inbound job", async () => {
    await seedWelcomeMessage({ MAIL_RAW: r2 as never, MAIL_QUEUE: queue as never }, ck, INPUT);

    expect(queue.sent).toHaveLength(1);
    const job = queue.sent[0];
    expect(job.resolvedMailboxId).toBe(MAILBOX);
    expect(job.recipient).toBe(ADDRESS);
    // No DMARC evaluation happened, so we claim none. The classifier junks only
    // on an explicit fail, so absent auth is neutral — the message reaches the inbox.
    expect(job.dmarcPass).toBe(false);
    expect(job.authResults).toBeNull();

    const stored = r2.store.get(job.r2RawKey);
    expect(stored).toBeTruthy();
    // Stored encrypted: the plaintext subject must not be readable off the bytes.
    expect(new TextDecoder().decode(stored!)).not.toContain("Welcome to Doota");
    const round = await getDecryptedBlob(r2 as never, job.r2RawKey, ck);
    expect(new TextDecoder().decode(round!)).toContain("Welcome to Doota");
  });

  it("materializes into a normal message and inbox delivery", async () => {
    await seedWelcomeMessage({ MAIL_RAW: r2 as never, MAIL_QUEUE: queue as never }, ck, INPUT);
    const { messageId } = await ingestSeeded();

    const deliveries = await db
      .select()
      .from(schema.delivery)
      .where(eq(schema.delivery.messageId, messageId));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].mailboxId).toBe(MAILBOX);
  });

  it("converges when a retried provision seeds it twice", async () => {
    const env = { MAIL_RAW: r2 as never, MAIL_QUEUE: queue as never };
    await seedWelcomeMessage(env, ck, INPUT);
    const first = await ingestSeeded();
    await seedWelcomeMessage(env, ck, INPUT);
    const second = await ingestSeeded();

    // Same R2 key, same message row, one delivery — provisioning is explicitly
    // retry-safe, so the seed has to be too or a retry doubles the user's inbox.
    expect(queue.sent[0].r2RawKey).toBe(queue.sent[1].r2RawKey);
    expect(r2.store.size).toBe(1);
    expect(second.messageId).toBe(first.messageId);
    const deliveries = await db
      .select()
      .from(schema.delivery)
      .where(eq(schema.delivery.messageId, first.messageId));
    expect(deliveries).toHaveLength(1);
  });
});
