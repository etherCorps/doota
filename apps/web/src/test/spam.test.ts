// SPDX-License-Identifier: Apache-2.0
// Phase 5 stop gates (client-gaps build guide): corpus-style verdict tests
// biased against false positives (tier 2 is HAM-ONLY, unfamiliarity is
// neutral), lists beat everything, junk placement suppresses notification AND
// vacation, un-junk allow-lists the sender, retention hides (never deletes).
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { importKey } from "@doota/mail-core/crypto";
import { materializeMessage, materializeDelivery, type ParsedMessage } from "@doota/mail-core/materialize";
import { classifyInbound, addSenderListEntry, sweepJunk, latestSenderOf, JUNK_RETENTION_DAYS } from "@doota/mail-core/spam";
import { recordCorrespondents } from "@doota/mail-core/contacts";
import { INBOUND_STAGES } from "@doota/mail-core/queue-consumer";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const ORG = "org1";

let db: any;
let deps: { ck: Awaited<ReturnType<typeof importKey>>; searchKeyB64: string };

beforeEach(async () => {
  db = await makeDb();
  await db.insert(schema.organization).values({
    id: ORG, name: "Acme", slug: "acme-com", domain: "acme.com", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.user).values({
    id: "u1", name: "u1", email: "u1@x.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(schema.mailbox).values({
    id: "mb1", orgId: ORG, localPart: "support", address: "support@acme.com", isActive: true, isPersonal: false,
  });
  await db.insert(schema.mailboxAccess).values({ id: "acc1", userId: "u1", mailboxId: "mb1", canSend: true });
  deps = { ck: await importKey(KEY_B64), searchKeyB64: KEY_B64 };
});

const classify = (over: Partial<Parameters<typeof classifyInbound>[1]> = {}) =>
  classifyInbound(db, { mailboxId: "mb1", fromAddress: "stranger@new.com", dmarcPass: false, authResults: null, ...over });

describe("classifier — false positives are the expensive failure", () => {
  it("a NEVER-SEEN sender with no auth data is ham (neutral, not spam)", async () => {
    expect(await classify()).toEqual({ spam: false, reason: "default" });
  });

  it("dmarc=fail (explicit) is spam; absence of auth results is not", async () => {
    expect(await classify({ authResults: "mx.cf.net; spf=fail; dkim=fail; dmarc=fail" }))
      .toEqual({ spam: true, reason: "dmarc_fail" });
    expect(await classify({ authResults: "mx.cf.net; spf=none" })).toEqual({ spam: false, reason: "default" });
  });

  it("tier 2 ham floor: a replied-to sender is NEVER spam, even with dmarc=fail", async () => {
    await recordCorrespondents(db, [{ mailboxId: "mb1", address: "customer@x.com", seenAt: Date.now(), direction: "sent" }]);
    expect(await classify({ fromAddress: "customer@x.com", authResults: "dmarc=fail" }))
      .toEqual({ spam: false, reason: "replied" });
  });

  it("tier 2: any replied-to address on the domain vouches for colleagues", async () => {
    await recordCorrespondents(db, [{ mailboxId: "mb1", address: "known@corp.com", seenAt: Date.now(), direction: "sent" }]);
    expect(await classify({ fromAddress: "new-person@corp.com", authResults: "dmarc=fail" }))
      .toEqual({ spam: false, reason: "domain_replied" });
  });

  it("tier 2: previously-seen (never junked) sender is weak ham", async () => {
    await recordCorrespondents(db, [{ mailboxId: "mb1", address: "seen@x.com", seenAt: Date.now() }]);
    expect(await classify({ fromAddress: "seen@x.com", authResults: "dmarc=fail" }))
      .toEqual({ spam: false, reason: "known_sender" });
  });

  it("lists beat everything: allow beats dmarc=fail, block beats a replied-to sender", async () => {
    await addSenderListEntry(db, { mailboxId: "mb1", address: "ally@x.com", kind: "allow" });
    expect(await classify({ fromAddress: "ally@x.com", authResults: "dmarc=fail" }))
      .toEqual({ spam: false, reason: "allow_list" });
    await recordCorrespondents(db, [{ mailboxId: "mb1", address: "foe@x.com", seenAt: Date.now(), direction: "sent" }]);
    await addSenderListEntry(db, { mailboxId: "mb1", address: "foe@x.com", kind: "block" });
    expect(await classify({ fromAddress: "foe@x.com" })).toEqual({ spam: true, reason: "block_list" });
  });

  it("@domain entries match the whole domain", async () => {
    await addSenderListEntry(db, { mailboxId: "mb1", address: "@spamhaus.example", kind: "block" });
    expect(await classify({ fromAddress: "anyone@spamhaus.example" }))
      .toEqual({ spam: true, reason: "block_list" });
  });
});

describe("ingest: junk placement is silent end-to-end", () => {
  it("dmarc=fail mail lands in spam, no notification, no vacation reply", async () => {
    await db.insert(schema.mailboxVacation).values({
      mailboxId: "mb1", orgId: ORG, enabled: true, enabledByUserId: "u1", bodyText: "away",
    });
    const pm: ParsedMessage = {
      messageIdHeader: "<s1@ext>", inReplyTo: null, references: null,
      from: "attacker@evil.com", subject: "win money", sentAt: Date.now(),
      text: "spam body", html: null, r2RawKey: null, attachments: [],
    };
    const queue: any[] = [];
    const ctx: any = {
      db,
      env: {
        MAIL_DEK: KEY_B64, MAIL_SEARCH_KEY: KEY_B64,
        MAIL_RAW: { async put() {}, async get() { return null; } },
        MAIL_OUT_QUEUE: { async send(j: any) { queue.push(j); } },
      },
      deps,
      job: {
        r2RawKey: "raw/x", recipient: "support@acme.com", orgId: ORG, resolvedMailboxId: "mb1",
        viaAliasId: null, subaddressTag: null, envelopeFrom: "attacker@evil.com",
        messageIdHeader: pm.messageIdHeader, dmarcPass: false,
        authResults: "mx; spf=fail; dkim=fail; dmarc=fail",
      },
      parsed: { from: { address: pm.from }, to: [{ address: "support@acme.com" }], attachments: [], headers: [] },
      pm,
      rawSize: 500,
    };
    for (const stage of INBOUND_STAGES) await stage.run(ctx);

    const st = await db.query.threadState.findFirst({
      where: and(eq(schema.threadState.threadId, ctx.threadId), eq(schema.threadState.mailboxId, "mb1")),
    });
    expect(st.placement).toBe("spam");
    expect(await db.query.notification.findMany({ where: eq(schema.notification.threadId, ctx.threadId) })).toHaveLength(0);
    // Vacation stayed silent on junk: no submission was enqueued.
    expect(await db.query.submission.findMany({ where: eq(schema.submission.orgId, ORG) })).toHaveLength(0);
  });
});

describe("junk lifecycle", () => {
  async function junkThread(from = "sender@ext.com") {
    const pm: ParsedMessage = {
      messageIdHeader: `<${crypto.randomUUID()}@ext>`, inReplyTo: null, references: null,
      from, subject: "hello", sentAt: Date.now(),
      text: "body", html: null, r2RawKey: null, attachments: [],
    };
    const ids = await materializeMessage(db, ORG, pm, deps);
    await materializeDelivery(db, {
      orgId: ORG, ...ids, mailboxId: "mb1", role: "to", viaAliasId: null, subaddressTag: null, sentAt: pm.sentAt,
      placement: { newThread: "spam", unarchiveOnReply: false },
    });
    return ids;
  }

  it("latestSenderOf resolves the allow-list target for un-junk", async () => {
    const { threadId } = await junkThread("false-positive@customer.com");
    expect(await latestSenderOf(db, threadId)).toBe("false-positive@customer.com");
  });

  it("retention HIDES old junk (hidden_at), never deletes, leaves fresh junk alone", async () => {
    const oldOne = await junkThread("old@x.com");
    await db.update(schema.threadState)
      .set({ lastActivityAt: new Date(Date.now() - (JUNK_RETENTION_DAYS + 5) * 86_400_000) })
      .where(eq(schema.threadState.threadId, oldOne.threadId));
    const fresh = await junkThread("fresh@x.com");

    const hidden = await sweepJunk(db);
    expect(hidden).toBe(1);
    const oldState = await db.query.threadState.findFirst({ where: eq(schema.threadState.threadId, oldOne.threadId) });
    expect(oldState.hiddenAt).not.toBeNull();
    expect(oldState.placement).toBe("spam"); // hidden, not moved, not deleted
    const freshState = await db.query.threadState.findFirst({ where: eq(schema.threadState.threadId, fresh.threadId) });
    expect(freshState.hiddenAt).toBeNull();
    // The message rows survive.
    expect((await db.query.message.findMany({ where: eq(schema.message.orgId, ORG) })).length).toBe(2);
  });
});
