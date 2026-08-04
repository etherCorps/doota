// SPDX-License-Identifier: Apache-2.0
// Phase 1 stop gates (client-gaps build guide): move-replaces-labels folder
// behaviour, depth-2 nesting, delete-never-loses-mail, origin-driven
// resurfacing, undo restores origin, per-folder unread counts, mute silence.
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { importKey } from "@doota/mail-core/crypto";
import { materializeMessage, materializeDelivery, type ParsedMessage } from "@doota/mail-core/materialize";
import {
  createLabel,
  updateLabel,
  deleteLabel,
  applyLabel,
  moveThreadToFolder,
  undoMoveToFolder,
  labelsForThreads,
  LabelError,
} from "@doota/mail-core/labels";
import { listThreads, countUnread, countUnreadByLabel } from "@doota/mail-core/read";
import { recordNewMail } from "@doota/mail-core/notify";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const ORG = "org1";

let db: any;
let ck: Awaited<ReturnType<typeof importKey>>;
let deps: { ck: Awaited<ReturnType<typeof importKey>>; searchKeyB64: string };

async function seed() {
  await db.insert(schema.organization).values({
    id: ORG, name: "Acme", slug: "acme-com", domain: "acme.com", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.user).values({
    id: "u1", name: "u1", email: "u1@x.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(schema.mailbox).values({
    id: "mb1", orgId: ORG, localPart: "alice", address: "alice@acme.com", isActive: true, isPersonal: true,
  });
  await db.insert(schema.mailboxAccess).values({ id: "acc1", userId: "u1", mailboxId: "mb1", canSend: true });
}

function parsed(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    messageIdHeader: `<${crypto.randomUUID()}@ext>`, inReplyTo: null, references: null,
    from: "ext@sender.com", subject: "Hello", sentAt: Date.now(),
    text: "Body.", html: null, r2RawKey: null, attachments: [],
    ...overrides,
  };
}

async function deliver(overrides: Partial<ParsedMessage> = {}) {
  const pm = parsed(overrides);
  const ids = await materializeMessage(db, ORG, pm, deps);
  await materializeDelivery(db, {
    orgId: ORG, ...ids, mailboxId: "mb1", role: "to",
    viaAliasId: null, subaddressTag: null, sentAt: pm.sentAt,
  });
  return { ...ids, pm };
}

async function state(threadId: string) {
  return db.query.threadState.findFirst({
    where: and(eq(schema.threadState.threadId, threadId), eq(schema.threadState.mailboxId, "mb1")),
  });
}

beforeEach(async () => {
  db = await makeDb();
  await seed();
  ck = await importKey(KEY_B64);
  deps = { ck, searchKeyB64: KEY_B64 };
});

describe("folder tree (depth 2)", () => {
  it("rejects a third nesting level, on create and on reparent", async () => {
    const root = await createLabel(db, { orgId: ORG, name: "Clients" });
    const child = await createLabel(db, { orgId: ORG, name: "Acme", parentId: root.id });
    await expect(createLabel(db, { orgId: ORG, name: "Deep", parentId: child.id })).rejects.toThrow(LabelError);
    // Reparent that would create depth 3: a parent-with-children can't gain a parent…
    const other = await createLabel(db, { orgId: ORG, name: "Other" });
    await expect(
      updateLabel(db, { orgId: ORG, labelId: root.id, parentId: other.id }),
    ).rejects.toThrow(LabelError);
    // …and a valid reparent works.
    const moved = await updateLabel(db, { orgId: ORG, labelId: child.id, parentId: other.id });
    expect(moved.parentId).toBe(other.id);
  });

  it("rejects duplicate names and self-parenting", async () => {
    const a = await createLabel(db, { orgId: ORG, name: "Invoices" });
    await expect(createLabel(db, { orgId: ORG, name: "Invoices" })).rejects.toThrow(LabelError);
    await expect(updateLabel(db, { orgId: ORG, labelId: a.id, parentId: a.id })).rejects.toThrow(LabelError);
  });
});

describe("move replaces, add label doesn't", () => {
  it("moveToFolder leaves exactly one folder; addLabel is additive", async () => {
    const { threadId } = await deliver();
    const a = await createLabel(db, { orgId: ORG, name: "A" });
    const b = await createLabel(db, { orgId: ORG, name: "B" });
    await applyLabel(db, { orgId: ORG, threadId, mailboxId: "mb1", labelId: a.id });
    await applyLabel(db, { orgId: ORG, threadId, mailboxId: "mb1", labelId: b.id });
    expect((await labelsForThreads(db, { mailboxId: "mb1", threadIds: [threadId] })).get(threadId)).toHaveLength(2);

    const c = await createLabel(db, { orgId: ORG, name: "C" });
    await moveThreadToFolder(db, { orgId: ORG, threadId, mailboxId: "mb1", labelId: c.id, userId: "u1" });
    const after = (await labelsForThreads(db, { mailboxId: "mb1", threadIds: [threadId] })).get(threadId)!;
    expect(after.map((l) => l.labelId)).toEqual([c.id]);
    // Filing IS moving: the thread left the inbox and is stamped user-origin.
    expect(await state(threadId)).toMatchObject({
      placement: "archived", placementOrigin: "user", placementUserId: "u1",
    });
  });

  it("moveToFolder(null) returns the thread to Inbox and clears its folders", async () => {
    const { threadId } = await deliver();
    const a = await createLabel(db, { orgId: ORG, name: "A" });
    await moveThreadToFolder(db, { orgId: ORG, threadId, mailboxId: "mb1", labelId: a.id, userId: "u1" });
    await moveThreadToFolder(db, { orgId: ORG, threadId, mailboxId: "mb1", labelId: null, userId: "u1" });
    expect((await labelsForThreads(db, { mailboxId: "mb1", threadIds: [threadId] })).get(threadId)).toBeUndefined();
    expect((await state(threadId)).placement).toBe("inbox");
  });

  it("the folder view lists the filed thread; undo restores labels AND origin", async () => {
    const { threadId } = await deliver();
    const a = await createLabel(db, { orgId: ORG, name: "A" });
    const snap = await moveThreadToFolder(db, { orgId: ORG, threadId, mailboxId: "mb1", labelId: a.id, userId: "u1" });
    const view = await listThreads(db, { mailboxId: "mb1", placement: "inbox", labelId: a.id, ck });
    expect(view.map((t) => t.threadId)).toEqual([threadId]);

    await undoMoveToFolder(db, snap);
    expect((await labelsForThreads(db, { mailboxId: "mb1", threadIds: [threadId] })).get(threadId)).toBeUndefined();
    expect(await state(threadId)).toMatchObject({
      placement: "inbox", placementOrigin: "default", placementUserId: null, placementAt: null,
    });
  });
});

describe("delete folder never loses mail", () => {
  it("re-files contents to the target folder when given", async () => {
    const { threadId } = await deliver();
    const a = await createLabel(db, { orgId: ORG, name: "A" });
    const b = await createLabel(db, { orgId: ORG, name: "B" });
    await moveThreadToFolder(db, { orgId: ORG, threadId, mailboxId: "mb1", labelId: a.id, userId: "u1" });
    await deleteLabel(db, { orgId: ORG, labelId: a.id, moveContentsToLabelId: b.id });
    const labels = (await labelsForThreads(db, { mailboxId: "mb1", threadIds: [threadId] })).get(threadId)!;
    expect(labels.map((l) => l.labelId)).toEqual([b.id]);
  });

  it("without a target the thread keeps its placement — never hidden or deleted", async () => {
    const { threadId } = await deliver();
    const a = await createLabel(db, { orgId: ORG, name: "A" });
    await moveThreadToFolder(db, { orgId: ORG, threadId, mailboxId: "mb1", labelId: a.id, userId: "u1" });
    await deleteLabel(db, { orgId: ORG, labelId: a.id });
    expect((await state(threadId)).placement).toBe("archived");
    expect((await state(threadId)).hiddenAt).toBeNull();
    // Children hop up to root instead of dangling.
    const root = await createLabel(db, { orgId: ORG, name: "R" });
    const kid = await createLabel(db, { orgId: ORG, name: "K", parentId: root.id });
    await deleteLabel(db, { orgId: ORG, labelId: root.id });
    expect((await db.query.label.findFirst({ where: eq(schema.label.id, kid.id) })).parentId).toBeNull();
  });
});

describe("resurfacing by placement_origin (Phase 1 core)", () => {
  async function reply(threadId: string, parentHeader: string) {
    const pm = parsed({ inReplyTo: parentHeader, sentAt: Date.now() + 1000 });
    const ids = await materializeMessage(db, ORG, pm, deps);
    expect(ids.threadId).toBe(threadId);
    await materializeDelivery(db, {
      orgId: ORG, ...ids, mailboxId: "mb1", role: "to",
      viaAliasId: null, subaddressTag: null, sentAt: pm.sentAt,
    });
  }

  it("user-archived thread returns to Inbox on a new reply", async () => {
    const { threadId, pm } = await deliver();
    await db.update(schema.threadState)
      .set({ placement: "archived", placementOrigin: "user", placementUserId: "u1" })
      .where(eq(schema.threadState.threadId, threadId));
    await reply(threadId, pm.messageIdHeader);
    expect((await state(threadId)).placement).toBe("inbox");
    expect((await state(threadId)).placementOrigin).toBe("user"); // stays sticky against rules
  });

  it("rule-filed thread stays put on a new reply", async () => {
    const { threadId, pm } = await deliver();
    await db.update(schema.threadState)
      .set({ placement: "archived", placementOrigin: "rule", placementRuleId: "r1" })
      .where(eq(schema.threadState.threadId, threadId));
    await reply(threadId, pm.messageIdHeader);
    expect((await state(threadId)).placement).toBe("archived");
  });

  it("muted thread stays put on a new reply and stays silent", async () => {
    const { threadId, pm } = await deliver();
    await db.update(schema.threadState)
      .set({ placement: "archived", placementOrigin: "user", muted: true })
      .where(eq(schema.threadState.threadId, threadId));
    await reply(threadId, pm.messageIdHeader);
    expect((await state(threadId)).placement).toBe("archived");
    // Silent: no bell row for a muted thread.
    await recordNewMail(db, { orgId: ORG, mailboxId: "mb1", threadId });
    const rows = await db.query.notification.findMany({ where: eq(schema.notification.threadId, threadId) });
    expect(rows).toHaveLength(0);
  });

  it("spam/trash are never resurrected by a reply", async () => {
    const { threadId, pm } = await deliver();
    await db.update(schema.threadState).set({ placement: "trash", placementOrigin: "user" })
      .where(eq(schema.threadState.threadId, threadId));
    await reply(threadId, pm.messageIdHeader);
    expect((await state(threadId)).placement).toBe("trash");
  });
});

describe("per-folder notification setting", () => {
  it("a thread filed only into notify-off folders is silent; mixed folders notify", async () => {
    const { threadId } = await deliver();
    const quiet = await createLabel(db, { orgId: ORG, name: "Quiet" });
    await updateLabel(db, { orgId: ORG, labelId: quiet.id, notifyNewMail: false });
    await moveThreadToFolder(db, { orgId: ORG, threadId, mailboxId: "mb1", labelId: quiet.id, userId: "u1" });
    await recordNewMail(db, { orgId: ORG, mailboxId: "mb1", threadId });
    expect(await db.query.notification.findMany({ where: eq(schema.notification.threadId, threadId) })).toHaveLength(0);

    const loud = await createLabel(db, { orgId: ORG, name: "Loud" });
    await applyLabel(db, { orgId: ORG, threadId, mailboxId: "mb1", labelId: loud.id });
    await recordNewMail(db, { orgId: ORG, mailboxId: "mb1", threadId });
    expect((await db.query.notification.findMany({ where: eq(schema.notification.threadId, threadId) })).length).toBe(1);
  });
});

describe("unread counts", () => {
  it("folder badge counts unread filed threads; inbox count drops after a move", async () => {
    const t1 = await deliver();
    const t2 = await deliver();
    expect(await countUnread(db, { mailboxId: "mb1", userId: "u1" })).toBe(2);

    const a = await createLabel(db, { orgId: ORG, name: "A" });
    await moveThreadToFolder(db, { orgId: ORG, threadId: t1.threadId, mailboxId: "mb1", labelId: a.id, userId: "u1" });
    expect(await countUnread(db, { mailboxId: "mb1", userId: "u1" })).toBe(1);
    const byLabel = await countUnreadByLabel(db, { mailboxId: "mb1", userId: "u1" });
    expect(byLabel.get(a.id)).toBe(1);

    // Reading the filed thread clears the folder badge.
    await db.insert(schema.threadRead).values({
      orgId: ORG, userId: "u1", threadId: t1.threadId, mailboxId: "mb1", lastReadAt: new Date(Date.now() + 60_000),
    });
    expect((await countUnreadByLabel(db, { mailboxId: "mb1", userId: "u1" })).get(a.id)).toBeUndefined();
    expect(t2.threadId).not.toBe(t1.threadId);
  });
});
