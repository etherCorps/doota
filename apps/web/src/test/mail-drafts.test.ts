// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { importKey, decryptContent } from "@doota/mail-core/crypto";
import {
  createDraft,
  saveDraft,
  getDraft,
  discardDraft,
  stageDraftAttachment,
  sendDraft,
  undoDraftSend,
  MAX_ATTACHMENT_BYTES,
} from "@doota/mail-core/drafts";
import { listSendIdentities } from "@doota/mail-core/identities";
import { listScheduled, listFailedSends, sweepStaleDrafts } from "@doota/mail-core/drafts";
import * as mail from "@doota/db/mail.schema";
import { suggestRecipients } from "@doota/mail-core/contacts";
import { getThread } from "@doota/mail-core/read";
import { encryptContent } from "@doota/mail-core/crypto";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const ORG = "org1";

// R2 fake with the list/delete surface drafts.ts needs.
function fakeR2() {
  const store = new Map<string, ArrayBuffer | string>();
  return {
    store,
    async put(key: string, val: ArrayBuffer | string) {
      store.set(key, val);
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const v = store.get(key)!;
      return {
        async arrayBuffer() {
          return typeof v === "string" ? new TextEncoder().encode(v).buffer : v;
        },
        async text() {
          return typeof v === "string" ? v : new TextDecoder().decode(v);
        },
      };
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix }: { prefix: string }) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}
function fakeQueue() {
  const sent: unknown[] = [];
  return { sent, async send(body: unknown) { sent.push(body); } };
}

async function seed(db: any) {
  await db.insert(schema.organization).values({
    id: ORG, name: "Acme", slug: "acme-com", domain: "acme.com", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.orgMailSettings).values({
    orgId: ORG, subaddressingEnabled: true, routingSubdomains: "[]", returnPathDomain: "bounce.acme.com",
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
  // Alice owns an enabled hide-my-email alias.
  await db.insert(schema.alias).values({
    id: "al1", orgId: ORG, mailboxId: "mb_alice", address: "secretcat@acme.com", label: "shopping", isEnabled: true,
  });
}

let db: any;
let ck: Awaited<ReturnType<typeof importKey>>;
let r2: ReturnType<typeof fakeR2>;
let queue: ReturnType<typeof fakeQueue>;
const env = () => ({ MAIL_DEK: KEY_B64, MAIL_SEARCH_KEY: KEY_B64, MAIL_RAW: r2 as never, MAIL_OUT_QUEUE: queue as never });

beforeEach(async () => {
  db = await makeDb();
  await seed(db);
  ck = await importKey(KEY_B64);
  r2 = fakeR2();
  queue = fakeQueue();
});

describe("drafts — creation & persistence", () => {
  it("round-trips an encrypted draft (survives navigation) and never stores plaintext", async () => {
    const d = await createDraft(db, ck, "u1", {
      mailboxId: "mb_alice", kind: "new", to: ["out@ext.com"], subject: "Hello", body: "secret body",
    });
    const row = await db.query.draft.findFirst({ where: eq(schema.draft.id, d.id) });
    expect(row.bodyEnc).not.toContain("secret body"); // ciphertext at rest
    const reopened = await getDraft(db, ck, d.id, "u1");
    expect(reopened.body).toBe("secret body");
    expect(reopened.subject).toBe("Hello");
    expect(reopened.to).toEqual(["out@ext.com"]);
  });

  it("rejects a forged sending identity server-side (can() denies mb_bob for u1)", async () => {
    await expect(
      createDraft(db, ck, "u1", { mailboxId: "mb_bob", kind: "new", to: ["x@ext.com"] }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("another user cannot read your draft", async () => {
    const d = await createDraft(db, ck, "u1", { mailboxId: "mb_alice", kind: "new", body: "mine" });
    await expect(getDraft(db, ck, d.id, "u2")).rejects.toMatchObject({ status: 403 });
  });
});

describe("drafts — autosave conflict", () => {
  it("bumps revision on a clean save and rejects a stale write without clobbering", async () => {
    const d = await createDraft(db, ck, "u1", { mailboxId: "mb_alice", kind: "new", body: "v0" });
    const s1 = await saveDraft(db, ck, "u1", { draftId: d.id, clientRevision: d.clientRevision, body: "v1" });
    expect(s1.ok).toBe(true);

    // A second tab still holding the old revision must not overwrite.
    const stale = await saveDraft(db, ck, "u1", { draftId: d.id, clientRevision: d.clientRevision, body: "vX" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.draft.body).toBe("v1"); // server state preserved
  });
});

describe("drafts — from-selector identities", () => {
  it("lists the mailbox + its enabled alias, marks subaddressable, hides others' mailboxes", async () => {
    const ids = await listSendIdentities(db, "u1");
    const addrs = ids.map((i) => i.address).sort();
    expect(addrs).toEqual(["alice@acme.com", "secretcat@acme.com"]);
    expect(ids.every((i) => i.available)).toBe(true);
    expect(ids.find((i) => i.kind === "mailbox")!.subaddressable).toBe(true);
    expect(ids.find((i) => i.kind === "alias")!.subaddressable).toBe(false);
    expect(ids.some((i) => i.address === "bob@acme.com")).toBe(false);
  });
});

describe("reply defaulting — thread DTO exposes the alias it arrived on", () => {
  it("surfaces viaAliasId + messageIdHeader so a reply can default to that alias", async () => {
    // Inbound mail delivered to alice THROUGH her alias.
    await db.insert(schema.thread).values({ id: "th1", orgId: ORG, lastMessageAt: new Date() });
    await db.insert(schema.message).values({
      id: "m1", orgId: ORG, threadId: "th1", messageIdHeader: "<in@ext.com>",
      fromAddr: "customer@ext.com", sentAt: new Date(),
      toAddrs: JSON.stringify(["alice@acme.com", "teammate@ext.com"]),
      ccAddrs: JSON.stringify(["watcher@ext.com"]),
      replyTo: "sales@ext.com",
      subjectEnc: await encryptContent(ck, "Order?"), bodyStrippedEnc: await encryptContent(ck, "hi"),
    });
    await db.insert(schema.delivery).values({
      id: "d1", orgId: ORG, messageId: "m1", mailboxId: "mb_alice", role: "to", viaAliasId: "al1",
    });
    await db.insert(schema.threadState).values({ id: "ts1", orgId: ORG, threadId: "th1", mailboxId: "mb_alice", placement: "inbox" });

    const dto = await getThread(db, { threadId: "th1", mailboxId: "mb_alice", ck });
    const item: any = dto!.items[0];
    expect(item.viaAliasId).toBe("al1"); // reply-default source
    expect(item.viaAlias).toBe("secretcat@acme.com");
    expect(item.messageIdHeader).toBe("<in@ext.com>"); // reply parent target
    // Reply-all audience source (Reply-To honored, original To/Cc preserved).
    expect(item.replyTo).toBe("sales@ext.com");
    expect(item.to).toEqual(["alice@acme.com", "teammate@ext.com"]);
    expect(item.cc).toEqual(["watcher@ext.com"]);
  });

  it("a reply-all draft sends To + Cc through the outbound recipient rows", async () => {
    const d = await createDraft(db, ck, "u1", {
      mailboxId: "mb_alice", kind: "reply_all",
      to: ["customer@ext.com", "teammate@ext.com"], cc: ["watcher@ext.com"], body: "all",
    });
    const { submissionId } = await sendDraft(db, env(), ck, "u1", { draftId: d.id });
    const recips = await db.query.submissionRecipient.findMany({
      where: eq(schema.submissionRecipient.submissionId, submissionId),
    });
    const byAddr = new Map(recips.map((r: any) => [r.address, r.role]));
    expect(byAddr.get("teammate@ext.com")).toBe("to");
    expect(byAddr.get("watcher@ext.com")).toBe("cc");
  });
});

describe("drafts — send integration & alias defaulting", () => {
  it("sends as the chosen alias (hide-my-email: envelope From is the alias)", async () => {
    const d = await createDraft(db, ck, "u1", {
      mailboxId: "mb_alice", kind: "reply", fromAliasId: "al1", to: ["out@ext.com"], body: "hi",
    });
    const { submissionId } = await sendDraft(db, env(), ck, "u1", { draftId: d.id });
    const sub = await db.query.submission.findFirst({ where: eq(schema.submission.id, submissionId) });
    expect(sub.envelopeFrom).toBe("secretcat@acme.com");
    expect(sub.fromAliasId).toBe("al1");
    const row = await db.query.draft.findFirst({ where: eq(schema.draft.id, d.id) });
    expect(row.status).toBe("sent"); // retained tombstone
    expect(row.submissionId).toBe(submissionId);
  });

  it("sends a rich (HTML) body and stores clean text for the timeline", async () => {
    const d = await createDraft(db, ck, "u1", {
      mailboxId: "mb_alice", kind: "new", to: ["out@ext.com"], body: "<b>Hello</b> world",
    });
    const { submissionId } = await sendDraft(db, env(), ck, "u1", { draftId: d.id });
    const sub = await db.query.submission.findFirst({ where: eq(schema.submission.id, submissionId) });
    const message = await db.query.message.findFirst({ where: eq(schema.message.id, sub.messageId) });
    const stripped = await decryptContent(ck, message.bodyStrippedEnc);
    expect(stripped).toBe("Hello world"); // tags stripped for display/search
  });

  it("trims accidental trailing whitespace from the sent body, even nested in inline tags", async () => {
    const d = await createDraft(db, ck, "u1", {
      mailboxId: "mb_alice", kind: "new", to: ["out@ext.com"],
      body: "<p>hello <strong>world </strong></p><p>&nbsp;</p><p><br></p>",
    });
    const { submissionId } = await sendDraft(db, env(), ck, "u1", { draftId: d.id });
    const sub = await db.query.submission.findFirst({ where: eq(schema.submission.id, submissionId) });
    const message = await db.query.message.findFirst({ where: eq(schema.message.id, sub.messageId) });
    const html = await decryptContent(ck, message.bodyHtmlEnc);
    expect(html).toBe("<p>hello <strong>world</strong></p>");
  });

  it("keeps BCC out of message headers — bcc lives only as a submission recipient", async () => {
    const d = await createDraft(db, ck, "u1", {
      mailboxId: "mb_alice", kind: "new", to: ["a@ext.com"], bcc: ["hidden@ext.com"], subject: "s", body: "b",
    });
    const { submissionId } = await sendDraft(db, env(), ck, "u1", { draftId: d.id });
    const recips = await db.query.submissionRecipient.findMany({
      where: eq(schema.submissionRecipient.submissionId, submissionId),
    });
    const bcc = recips.find((r: any) => r.address === "hidden@ext.com");
    expect(bcc.role).toBe("bcc");
    // The shared message carries no bcc column/header; only envelope + recipient rows do.
    const sub = await db.query.submission.findFirst({ where: eq(schema.submission.id, submissionId) });
    const message = await db.query.message.findFirst({ where: eq(schema.message.id, sub.messageId) });
    expect(JSON.stringify(message)).not.toContain("hidden@ext.com");
  });
});

describe("drafts — send claim (double-send race)", () => {
  it("concurrent sends of one draft mint exactly one submission (loser 409s)", async () => {
    const d = await createDraft(db, ck, "u1", {
      mailboxId: "mb_alice", kind: "new", to: ["out@ext.com"], body: "once",
    });
    const results = await Promise.allSettled([
      sendDraft(db, env(), ck, "u1", { draftId: d.id }),
      sendDraft(db, env(), ck, "u1", { draftId: d.id }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const subs = await db.query.submission.findMany({
      where: eq(schema.submission.createdByUserId, "u1"),
    });
    expect(subs).toHaveLength(1);
  });

  it("a failed send reverts the claim so the draft stays editable", async () => {
    // No recipients → send rejects after the claim; the draft must come back.
    const d = await createDraft(db, ck, "u1", { mailboxId: "mb_alice", kind: "new", body: "stuck?" });
    await expect(sendDraft(db, env(), ck, "u1", { draftId: d.id })).rejects.toThrow();
    const row = await db.query.draft.findFirst({ where: eq(schema.draft.id, d.id) });
    expect(row.status).toBe("editing");
  });
});

describe("drafts — undo restores an editable state", () => {
  it("undo cancels the submission, removes the ghost bubble, and reopens the draft", async () => {
    const d = await createDraft(db, ck, "u1", { mailboxId: "mb_alice", kind: "new", to: ["out@ext.com"], body: "one" });
    const { submissionId } = await sendDraft(db, env(), ck, "u1", { draftId: d.id, undoSeconds: 300 });
    const subBefore = await db.query.submission.findFirst({ where: eq(schema.submission.id, submissionId) });
    const messageId = subBefore.messageId;

    const restored = await undoDraftSend(db, env(), ck, "u1", submissionId);
    expect(restored).not.toBeNull();
    expect(restored!.status).toBe("editing");

    // Immutable message deleted (not mutated); no ghost sender delivery remains.
    const msg = await db.query.message.findFirst({ where: eq(schema.message.id, messageId) });
    expect(msg).toBeUndefined();
    const fromDel = await db.query.delivery.findFirst({ where: eq(schema.delivery.messageId, messageId) });
    expect(fromDel).toBeUndefined();
  });

  it("retry after undo mints a NEW message (no duplicate, immutability preserved)", async () => {
    const d = await createDraft(db, ck, "u1", { mailboxId: "mb_alice", kind: "new", to: ["out@ext.com"], body: "one" });
    const first = await sendDraft(db, env(), ck, "u1", { draftId: d.id, undoSeconds: 300 });
    const firstMsg = (await db.query.submission.findFirst({ where: eq(schema.submission.id, first.submissionId) })).messageId;
    await undoDraftSend(db, env(), ck, "u1", first.submissionId);

    const second = await sendDraft(db, env(), ck, "u1", { draftId: d.id, undoSeconds: 300 });
    const secondMsg = (await db.query.submission.findFirst({ where: eq(schema.submission.id, second.submissionId) })).messageId;
    expect(secondMsg).not.toBe(firstMsg);
    expect(second.submissionId).not.toBe(first.submissionId);
  });
});

describe("inbound HTML render", () => {
  it("preserves + exposes the HTML body (rendered sandboxed) alongside text", async () => {
    await db.insert(schema.thread).values({ id: "thh", orgId: ORG, lastMessageAt: new Date() });
    await db.insert(schema.message).values({
      id: "mh", orgId: ORG, threadId: "thh", messageIdHeader: "<h@ext.com>", fromAddr: "n@ext.com", sentAt: new Date(),
      bodyStrippedEnc: await encryptContent(ck, "Hello"),
      bodyHtmlEnc: await encryptContent(ck, "<p>Hello <b>world</b></p>"),
    });
    await db.insert(schema.delivery).values({ id: "dh", orgId: ORG, messageId: "mh", mailboxId: "mb_alice", role: "to" });
    await db.insert(schema.threadState).values({ id: "tsh", orgId: ORG, threadId: "thh", mailboxId: "mb_alice", placement: "inbox" });

    const dto = await getThread(db, { threadId: "thh", mailboxId: "mb_alice", ck });
    const item: any = dto!.items[0];
    expect(item.bodyHtml).toBe("<p>Hello <b>world</b></p>");
    expect(item.bodyStripped).toBe("Hello");
  });
});

describe("stale-draft GC", () => {
  it("deletes abandoned drafts past the cutoff and cleans their R2 objects", async () => {
    const d = await createDraft(db, ck, "u1", { mailboxId: "mb_alice", kind: "new", body: "abandoned" });
    await stageDraftAttachment(db, env(), d.id, "u1", {
      name: "a.txt", type: "text/plain", size: 3, bytes: new TextEncoder().encode("abc").buffer,
    });
    // Backdate it 20 days.
    await db.update(mail.draft).set({ updatedAt: new Date(Date.now() - 20 * 864e5) }).where(eq(mail.draft.id, d.id));
    const n = await sweepStaleDrafts(db, env(), 14 * 864e5);
    expect(n).toBe(1);
    expect(r2.store.size).toBe(0);
    expect(await db.query.draft.findFirst({ where: eq(schema.draft.id, d.id) })).toBeUndefined();
  });

  it("keeps a recently-edited draft", async () => {
    await createDraft(db, ck, "u1", { mailboxId: "mb_alice", kind: "new", body: "fresh" });
    expect(await sweepStaleDrafts(db, env(), 14 * 864e5)).toBe(0);
  });
});

describe("scheduled sends", () => {
  it("lists a future scheduled send with its subject and recipient", async () => {
    const d = await createDraft(db, ck, "u1", {
      mailboxId: "mb_alice", kind: "new", to: ["out@ext.com"], subject: "Later", body: "hi",
    });
    await sendDraft(db, env(), ck, "u1", { draftId: d.id, sendAt: Date.now() + 3600_000 });
    const list = await listScheduled(db, ck, "u1");
    expect(list).toHaveLength(1);
    expect(list[0].subject).toBe("Later");
    expect(list[0].to).toBe("out@ext.com");
    expect(list[0].sendAt).toBeGreaterThan(Date.now());
  });
});

describe("failed sends (notifier feed)", () => {
  it("lists the user's failed submissions with subject, recipient and reason", async () => {
    const d = await createDraft(db, ck, "u1", {
      mailboxId: "mb_alice", kind: "new", to: ["dead@ext.com"], subject: "Doomed", body: "hi",
    });
    await sendDraft(db, env(), ck, "u1", { draftId: d.id });
    await db.update(schema.submission)
      .set({ status: "failed", lastError: "rate limit exceeded (mailbox)" })
      .where(eq(schema.submission.createdByUserId, "u1"));

    const failures = await listFailedSends(db, ck, "u1");
    expect(failures).toHaveLength(1);
    expect(failures[0].subject).toBe("Doomed");
    expect(failures[0].to).toBe("dead@ext.com");
    expect(failures[0].reason).toBe("rate limit exceeded (mailbox)");
    expect(failures[0].threadId).toBeTruthy();
    // Another user sees nothing.
    expect(await listFailedSends(db, ck, "u2")).toEqual([]);
  });
});

describe("recipient autocomplete", () => {
  it("suggests prior correspondents (sent-to and received-from), prefix-filtered", async () => {
    // u1 emailed someone.
    const d = await createDraft(db, ck, "u1", { mailboxId: "mb_alice", kind: "new", to: ["colleague@ext.com"], body: "x" });
    await sendDraft(db, env(), ck, "u1", { draftId: d.id });
    // someone emailed alice.
    await db.insert(schema.thread).values({ id: "thc", orgId: ORG, lastMessageAt: new Date() });
    await db.insert(schema.message).values({
      id: "mc", orgId: ORG, threadId: "thc", messageIdHeader: "<c@ext.com>", fromAddr: "customer@ext.com", sentAt: new Date(),
    });
    await db.insert(schema.delivery).values({ id: "dc", orgId: ORG, messageId: "mc", mailboxId: "mb_alice", role: "to" });

    const all = (await suggestRecipients(db, "u1", "")).map((s) => s.address);
    expect(all).toContain("colleague@ext.com");
    expect(all).toContain("customer@ext.com");
    const filtered = await suggestRecipients(db, "u1", "custo");
    expect(filtered.map((s) => s.address)).toEqual(["customer@ext.com"]);
  });
});

describe("drafts — attachments", () => {
  it("enforces the per-file size limit server-side (before writing bytes)", async () => {
    const d = await createDraft(db, ck, "u1", { mailboxId: "mb_alice", kind: "new", body: "b" });
    await expect(
      stageDraftAttachment(db, env(), d.id, "u1", {
        name: "big.bin", type: "application/octet-stream", size: MAX_ATTACHMENT_BYTES + 1, bytes: new ArrayBuffer(8),
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(r2.store.size).toBe(0); // nothing written on rejection
  });

  it("discarding a draft garbage-collects its staged R2 objects", async () => {
    const d = await createDraft(db, ck, "u1", { mailboxId: "mb_alice", kind: "new", body: "b" });
    await stageDraftAttachment(db, env(), d.id, "u1", {
      name: "a.txt", type: "text/plain", size: 3, bytes: new TextEncoder().encode("abc").buffer,
    });
    expect(r2.store.size).toBe(1);
    await discardDraft(db, env(), d.id, "u1");
    expect(r2.store.size).toBe(0);
    const row = await db.query.draft.findFirst({ where: eq(schema.draft.id, d.id) });
    expect(row).toBeUndefined();
  });
});
