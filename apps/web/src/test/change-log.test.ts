// SPDX-License-Identifier: Apache-2.0
// Phase 0 stop gates (client-gaps build guide): change_log triggers write
// exactly one row per observable mutation, non-observable writes burn no seq,
// prune raises the floor and a below-floor token gets a resync signal, and the
// inbound pipeline's rules-eval stage structurally precedes notification
// dispatch.
import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { materializeMessage, materializeDelivery, type ParsedMessage } from "@doota/mail-core/materialize";
import { changesSince, pruneChangeLog, CHANGE_LOG_RETENTION_DAYS } from "@doota/mail-core/change-log";
import { INBOUND_STAGES } from "@doota/mail-core/queue-consumer";
import { importKey } from "@doota/mail-core/crypto";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const ORG = "org1";

async function seed(db: any) {
  await db.insert(schema.organization).values({
    id: ORG, name: "Acme", slug: "acme-com", domain: "acme.com", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.mailbox).values([
    { id: "mb_a", orgId: ORG, localPart: "alice", address: "alice@acme.com", isActive: true, isPersonal: true },
    { id: "mb_b", orgId: ORG, localPart: "support", address: "support@acme.com", isActive: true, isPersonal: false },
  ]);
}

function parsed(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    messageIdHeader: "<m1@ext>", inReplyTo: null, references: null,
    from: "ext@sender.com", subject: "Hello", sentAt: Date.now(),
    text: "Body.", html: null, r2RawKey: "raw/org1/m1", attachments: [],
    ...overrides,
  };
}

async function rowsFor(db: any, mailboxId: string) {
  return db
    .select()
    .from(schema.changeLog)
    .where(eq(schema.changeLog.mailboxId, mailboxId))
    .orderBy(schema.changeLog.seq);
}

let db: any;
let deps: { ck: Awaited<ReturnType<typeof importKey>>; searchKeyB64: string };

beforeEach(async () => {
  db = await makeDb();
  await seed(db);
  deps = { ck: await importKey(KEY_B64), searchKeyB64: KEY_B64 };
});

async function deliverOne(mailboxId = "mb_a", header = "<m1@ext>") {
  const pm = parsed({ messageIdHeader: header });
  const { messageId, threadId } = await materializeMessage(db, ORG, pm, deps);
  await materializeDelivery(db, {
    orgId: ORG, messageId, threadId, mailboxId,
    role: "to", viaAliasId: null, subaddressTag: null, sentAt: pm.sentAt,
  });
  return { messageId, threadId };
}

describe("change_log triggers — Email (delivery)", () => {
  it("insert/update/delete each write exactly one row with the right action", async () => {
    await deliverOne();
    let rows = await rowsFor(db, "mb_a");
    const emails = rows.filter((r: any) => r.type === "Email");
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ type: "Email", action: "created", mailboxId: "mb_a" });

    const del = await db.query.delivery.findFirst({ where: eq(schema.delivery.mailboxId, "mb_a") });
    await db.update(schema.delivery).set({ isRead: true }).where(eq(schema.delivery.id, del!.id));
    rows = await rowsFor(db, "mb_a");
    expect(rows.filter((r: any) => r.type === "Email" && r.action === "updated")).toHaveLength(1);

    await db.delete(schema.delivery).where(eq(schema.delivery.id, del!.id));
    rows = await rowsFor(db, "mb_a");
    const destroyed = rows.filter((r: any) => r.type === "Email" && r.action === "destroyed");
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0].objectId).toBe(del!.id); // object_id survives the delete
  });

  it("a non-observable write burns no seq", async () => {
    await deliverOne();
    const before = (await rowsFor(db, "mb_a")).length;
    const del = await db.query.delivery.findFirst({ where: eq(schema.delivery.mailboxId, "mb_a") });
    // subaddress_tag is not a watched column — a client can't observe it changing.
    await db.update(schema.delivery).set({ subaddressTag: "x" }).where(eq(schema.delivery.id, del!.id));
    // Recency bumps on thread_state are the guide's canonical must-not-fire case.
    await db
      .update(schema.threadState)
      .set({ lastActivityAt: new Date(), lastInboundAt: new Date() })
      .where(eq(schema.threadState.mailboxId, "mb_a"));
    expect((await rowsFor(db, "mb_a")).length).toBe(before);
  });

  it("an inbound redelivery to an existing thread burns no Thread seq (snooze clear is conditional)", async () => {
    const { messageId, threadId } = await deliverOne();
    const before = (await rowsFor(db, "mb_a")).filter((r: any) => r.type === "Thread").length;
    // Same-thread second delivery, thread not snoozed → the thread_state update
    // must keep watched columns out of SET entirely.
    const pm = parsed({ messageIdHeader: "<m2@ext>", inReplyTo: "<m1@ext>" });
    const second = await materializeMessage(db, ORG, pm, deps);
    expect(second.threadId).toBe(threadId);
    await materializeDelivery(db, {
      orgId: ORG, messageId: second.messageId, threadId, mailboxId: "mb_a",
      role: "to", viaAliasId: null, subaddressTag: null, sentAt: pm.sentAt,
    });
    const after = (await rowsFor(db, "mb_a")).filter((r: any) => r.type === "Thread").length;
    expect(after).toBe(before);
    expect(messageId).not.toBe(second.messageId);
  });
});

describe("change_log triggers — Thread (thread_state)", () => {
  it("insert logs created; placement change logs updated", async () => {
    const { threadId } = await deliverOne();
    let threads = (await rowsFor(db, "mb_a")).filter((r: any) => r.type === "Thread");
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ action: "created", objectId: threadId });

    await db
      .update(schema.threadState)
      .set({ placement: "archived" })
      .where(and(eq(schema.threadState.threadId, threadId), eq(schema.threadState.mailboxId, "mb_a")));
    threads = (await rowsFor(db, "mb_a")).filter((r: any) => r.type === "Thread");
    expect(threads.filter((r: any) => r.action === "updated")).toHaveLength(1);
  });
});

describe("change_log triggers — Mailbox (label / thread_label)", () => {
  it("label create/rename logs only to the label's own mailbox (never the org's others)", async () => {
    await db.insert(schema.label).values({ id: "lb1", orgId: ORG, mailboxId: "mb_a", name: "Invoices" });
    const rows = (await rowsFor(db, "mb_a")).filter((r: any) => r.type === "Mailbox");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "created", objectId: "lb1" });
    // Privacy: the other mailbox never even learns the folder exists.
    expect((await rowsFor(db, "mb_b")).filter((r: any) => r.type === "Mailbox")).toHaveLength(0);
    await db.update(schema.label).set({ name: "Bills" }).where(eq(schema.label.id, "lb1"));
    const updated = (await rowsFor(db, "mb_a")).filter(
      (r: any) => r.type === "Mailbox" && r.action === "updated",
    );
    expect(updated).toHaveLength(1);
    expect((await rowsFor(db, "mb_b")).filter((r: any) => r.type === "Mailbox")).toHaveLength(0);
  });

  it("thread_label apply/remove logs against the one mailbox it belongs to", async () => {
    const { threadId } = await deliverOne();
    await db.insert(schema.label).values({ id: "lb1", orgId: ORG, mailboxId: "mb_a", name: "Invoices" });
    const baseline = (await rowsFor(db, "mb_b")).length;
    await db.insert(schema.threadLabel).values({ id: "tl1", threadId, mailboxId: "mb_a", labelId: "lb1" });
    const applied = (await rowsFor(db, "mb_a")).filter(
      (r: any) => r.type === "Mailbox" && r.action === "updated" && r.objectId === "lb1",
    );
    expect(applied).toHaveLength(1);
    // The OTHER mailbox saw nothing from this per-mailbox membership change.
    expect((await rowsFor(db, "mb_b")).length).toBe(baseline);
  });
});

describe("change_log triggers — EmailSubmission", () => {
  it("insert logs created; status change logs updated; nothing on attempts bump", async () => {
    const { messageId } = await deliverOne();
    await db.insert(schema.submission).values({
      id: "sub1", orgId: ORG, messageId, mailboxId: "mb_a",
      envelopeFrom: "alice@acme.com", idempotencyKey: "idem1",
    });
    let subs = (await rowsFor(db, "mb_a")).filter((r: any) => r.type === "EmailSubmission");
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ action: "created", objectId: "sub1" });

    await db.update(schema.submission).set({ attempts: 3 }).where(eq(schema.submission.id, "sub1"));
    subs = (await rowsFor(db, "mb_a")).filter((r: any) => r.type === "EmailSubmission");
    expect(subs).toHaveLength(1); // attempts is not observable

    await db.update(schema.submission).set({ status: "sent" }).where(eq(schema.submission.id, "sub1"));
    subs = (await rowsFor(db, "mb_a")).filter((r: any) => r.type === "EmailSubmission");
    expect(subs.filter((r: any) => r.action === "updated")).toHaveLength(1);
  });
});

describe("changesSince + prune floor", () => {
  it("returns ordered changes past a token and pages with hasMore", async () => {
    await deliverOne("mb_a", "<m1@ext>");
    await deliverOne("mb_a", "<m2@ext>");
    const res = await changesSince(db, "mb_a", 0);
    expect(res.cannotCalculateChanges).toBe(false);
    if (res.cannotCalculateChanges) throw new Error("unreachable");
    expect(res.changes.length).toBeGreaterThanOrEqual(3); // 2 Email created + Thread rows
    const seqs = res.changes.map((c) => c.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    const paged = await changesSince(db, "mb_a", 0, 1);
    if (paged.cannotCalculateChanges) throw new Error("unreachable");
    expect(paged.changes).toHaveLength(1);
    expect(paged.hasMore).toBe(true);
  });

  it("prune deletes past-retention rows, raises the floor, and a below-floor token resyncs", async () => {
    await deliverOne();
    const before = await rowsFor(db, "mb_a");
    expect(before.length).toBeGreaterThan(0);
    const maxSeq = before[before.length - 1].seq;

    const future = Date.now() + (CHANGE_LOG_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
    const prunedCount = await pruneChangeLog(db, future);
    expect(prunedCount).toBeGreaterThan(0);
    expect(await rowsFor(db, "mb_a")).toHaveLength(0);

    const floor = await db.query.changeLogFloor.findFirst({
      where: eq(schema.changeLogFloor.mailboxId, "mb_a"),
    });
    expect(floor?.floorSeq).toBe(maxSeq);

    // Below-floor token → full resync signal, never a silently incomplete diff.
    const stale = await changesSince(db, "mb_a", 0);
    expect(stale.cannotCalculateChanges).toBe(true);
    // At-floor token is still answerable (empty diff).
    const atFloor = await changesSince(db, "mb_a", maxSeq);
    expect(atFloor.cannotCalculateChanges).toBe(false);
  });

  it("a repeat prune never lowers the floor", async () => {
    await deliverOne();
    const future = Date.now() + (CHANGE_LOG_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
    await pruneChangeLog(db, future);
    const floor1 = await db.query.changeLogFloor.findFirst({
      where: eq(schema.changeLogFloor.mailboxId, "mb_a"),
    });
    await deliverOne("mb_a", "<m2@ext>");
    await pruneChangeLog(db, future + 40 * 24 * 60 * 60 * 1000);
    const floor2 = await db.query.changeLogFloor.findFirst({
      where: eq(schema.changeLogFloor.mailboxId, "mb_a"),
    });
    expect(floor2!.floorSeq).toBeGreaterThanOrEqual(floor1!.floorSeq);
  });
});

describe("inbound pipeline stage order (0b)", () => {
  it("rulesEval structurally precedes placement and notify", () => {
    const names = INBOUND_STAGES.map((s) => s.name);
    expect(names.indexOf("rulesEval")).toBeGreaterThan(-1);
    expect(names.indexOf("rulesEval")).toBeLessThan(names.indexOf("placement"));
    expect(names.indexOf("placement")).toBeLessThan(names.indexOf("notify"));
    expect(names.indexOf("metadata")).toBe(0);
  });
});

describe("user placement origin (0c)", () => {
  it("thread_state carries who filed it and why", async () => {
    const { threadId } = await deliverOne();
    // Simulate what moveThread stamps (the rpc layer adds auth on top).
    await db
      .update(schema.threadState)
      .set({ placement: "archived", placementOrigin: "user", placementUserId: "u1", placementAt: new Date() })
      .where(and(eq(schema.threadState.threadId, threadId), eq(schema.threadState.mailboxId, "mb_a")));
    const st = await db.query.threadState.findFirst({
      where: and(eq(schema.threadState.threadId, threadId), eq(schema.threadState.mailboxId, "mb_a")),
    });
    expect(st).toMatchObject({ placementOrigin: "user", placementUserId: "u1", muted: false });
    expect(st!.placementAt).toBeTruthy();
  });
});
