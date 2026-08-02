// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { importKey } from "@doota/mail-core/crypto";
import { assignedOnlyFor, assignedOnlyMailboxIds, grantAccess } from "@doota/mail-core/mailbox";
import { listThreads, getThread, countUnread } from "@doota/mail-core/read";
import { assignThread } from "@doota/mail-core/collab";

/**
 * Shared-mailbox access levels: a manager (can_manage) sees the whole mailbox;
 * an assigned-only member sees ONLY threads assigned to them — and the whole
 * thread once assigned.
 */

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const ORG = "org1";

let db: any;
let ck: Awaited<ReturnType<typeof importKey>>;

beforeEach(async () => {
  db = await makeDb();
  ck = await importKey(KEY_B64);
  await db.insert(schema.organization).values({ id: ORG, name: "Acme", slug: "acme-com", domain: "acme.com", status: "active", createdAt: new Date() });
  const u = (id: string, email: string) => ({ id, name: id, email, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(schema.user).values([u("mgr", "m@x.com"), u("agent", "a@x.com")]);
  await db.insert(schema.mailbox).values({ id: "mb_support", orgId: ORG, localPart: "support", address: "support@acme.com", isActive: true, isPersonal: false });
  await grantAccess(db, { userId: "mgr", mailboxId: "mb_support", canManage: true, canSend: true });
  await grantAccess(db, { userId: "agent", mailboxId: "mb_support", canSend: true, assignedOnly: true });

  // Two inbox threads, plus one message each so the list has something to show.
  for (const threadNum of [1, 2]) {
    await db.insert(schema.thread).values({ id: `th${threadNum}`, orgId: ORG, lastMessageAt: new Date(threadNum * 1000) });
    await db.insert(schema.threadState).values({
      id: `ts${threadNum}`, orgId: ORG, threadId: `th${threadNum}`, mailboxId: "mb_support",
      placement: "inbox", lastActivityAt: new Date(threadNum * 1000), lastInboundAt: new Date(threadNum * 1000),
    });
    await db.insert(schema.message).values({
      id: `m${threadNum}`, orgId: ORG, threadId: `th${threadNum}`, messageIdHeader: `<${threadNum}@x>`,
      fromAddr: "out@ext.com", toAddrs: "support@acme.com", ccAddrs: "",
      sentAt: new Date(threadNum * 1000), direction: "inbound",
    });
    await db.insert(schema.delivery).values({ id: `d${threadNum}`, orgId: ORG, messageId: `m${threadNum}`, mailboxId: "mb_support", role: "to" });
  }
});

const list = (userId: string, assignedTo: string | null) =>
  listThreads(db, { mailboxId: "mb_support", placement: "inbox", ck, userId, assignedTo });

describe("shared mailbox — assigned-only access", () => {
  it("resolves the visibility filter per grant (manager unrestricted)", async () => {
    expect(await assignedOnlyFor(db, "mgr", "mb_support")).toBeNull();
    expect(await assignedOnlyFor(db, "agent", "mb_support")).toBe("agent");
    expect(await assignedOnlyMailboxIds(db, "agent")).toEqual(["mb_support"]);
    expect(await assignedOnlyMailboxIds(db, "mgr")).toEqual([]);
  });

  it("a restricted member sees nothing until a thread is assigned to them", async () => {
    const filter = await assignedOnlyFor(db, "agent", "mb_support");
    expect(await list("agent", filter)).toHaveLength(0);
    expect(await getThread(db, { threadId: "th1", mailboxId: "mb_support", ck, userId: "agent", assignedTo: filter })).toBeNull();
    expect(await countUnread(db, { mailboxId: "mb_support", userId: "agent", assignedTo: filter })).toBe(0);

    await assignThread(db, { orgId: ORG, threadId: "th1", mailboxId: "mb_support", assigneeUserId: "agent", actorUserId: "mgr" });

    const rows = await list("agent", filter);
    expect(rows.map((thread) => thread.threadId)).toEqual(["th1"]); // th2 still invisible
    expect(await getThread(db, { threadId: "th1", mailboxId: "mb_support", ck, userId: "agent", assignedTo: filter })).not.toBeNull();
    expect(await getThread(db, { threadId: "th2", mailboxId: "mb_support", ck, userId: "agent", assignedTo: filter })).toBeNull();
    expect(await countUnread(db, { mailboxId: "mb_support", userId: "agent", assignedTo: filter })).toBe(1);
  });

  it("a manager sees the whole mailbox, assigned or not", async () => {
    await assignThread(db, { orgId: ORG, threadId: "th1", mailboxId: "mb_support", assigneeUserId: "agent", actorUserId: "mgr" });
    const rows = await list("mgr", await assignedOnlyFor(db, "mgr", "mb_support"));
    expect(rows.map((thread) => thread.threadId).sort()).toEqual(["th1", "th2"]);
    expect(await countUnread(db, { mailboxId: "mb_support", userId: "mgr" })).toBe(2);
  });

  it("promoting a restricted member to manager lifts the restriction", async () => {
    await grantAccess(db, { userId: "agent", mailboxId: "mb_support", canManage: true, canSend: true, assignedOnly: true });
    expect(await assignedOnlyFor(db, "agent", "mb_support")).toBeNull();
  });
});
