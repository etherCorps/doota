// SPDX-License-Identifier: Apache-2.0
// Endpoint LOGIC is tested through the exported helpers they wrap (remote fns
// need a request context). We test the wrapped pure functions: buildSeed() and
// buildChanges() extracted from the remote handlers.
import { describe, it, expect, beforeEach } from "vitest";
import { makeDb } from "./mail-db";
import { importKey } from "@doota/mail-core/crypto";
import { seedMailboxWithThreads } from "./helpers/seed-threads";
import { buildSeed, buildChanges, buildThreadMessageChanges } from "$lib/rpc/thread-localdb"; // pure helpers (see Step 3)

let db: any, ck: any;
beforeEach(async () => { db = await makeDb(); ck = await importKey(btoa("0123456789abcdef0123456789abcdef")); });

describe("local-first endpoints", () => {
  it("buildSeed returns every placement's rows + a cursor at the current seq", async () => {
    const { mailboxId } = await seedMailboxWithThreads(db, ck, 2);
    const seed = await buildSeed(db, { mailboxId, ck, userId: "u1", includeCollab: true, assignedTo: null });
    expect(seed.rows.length).toBe(2);
    expect(typeof seed.cursor).toBe("number");
  });

  it("buildChanges hydrates upserts and advances the cursor", async () => {
    const { mailboxId, threadIds } = await seedMailboxWithThreads(db, ck, 1);
    const seed = await buildSeed(db, { mailboxId, ck, userId: "u1", includeCollab: true, assignedTo: null });
    // Simulate a placement change → a change_log row via the real trigger.
    await db.run(`UPDATE thread_state SET placement='archived' WHERE mailbox_id='${mailboxId}'`);
    const delta = await buildChanges(db, { mailboxId, sinceSeq: seed.cursor, ck, userId: "u1", includeCollab: true, assignedTo: null });
    expect(delta.cannotCalculate).toBe(false);
    expect(delta.newSeq).toBeGreaterThan(seed.cursor);
    expect(delta.upserts.some((summary) => summary.threadId === threadIds[0] && summary.placement === "archived")).toBe(true);
  });

  it("buildChanges below the floor signals cannotCalculate", async () => {
    const { mailboxId } = await seedMailboxWithThreads(db, ck, 1);
    await db.insert((await import("@doota/db/mail.schema")).changeLogFloor).values({ mailboxId, floorSeq: 999 });
    const delta = await buildChanges(db, { mailboxId, sinceSeq: 0, ck, userId: "u1", includeCollab: true, assignedTo: null });
    expect(delta.cannotCalculate).toBe(true);
  });

  it("buildChanges with assignedTo only surfaces threads assigned to that user", async () => {
    // Seed 2 threads, assign each to a different user id.
    const { mailboxId, threadIds } = await seedMailboxWithThreads(db, ck, 2);
    const [threadForU1, threadForU2] = threadIds;
    // Insert stub user rows so the FK on assignee_user_id is satisfied.
    const { user } = await import("@doota/db/schema");
    await db.insert(user).values({ id: "u1", name: "User One", email: "u1@seed.test", emailVerified: false });
    await db.insert(user).values({ id: "u2", name: "User Two", email: "u2@seed.test", emailVerified: false });
    await db.run(`UPDATE thread_state SET assignee_user_id='u1' WHERE thread_id='${threadForU1}' AND mailbox_id='${mailboxId}'`);
    await db.run(`UPDATE thread_state SET assignee_user_id='u2' WHERE thread_id='${threadForU2}' AND mailbox_id='${mailboxId}'`);

    const seed = await buildSeed(db, { mailboxId, ck, userId: "u1", includeCollab: true, assignedTo: "u1" });
    // Trigger a change so there's a delta to fetch.
    await db.run(`UPDATE thread_state SET placement='archived' WHERE thread_id='${threadForU1}' AND mailbox_id='${mailboxId}'`);
    const delta = await buildChanges(db, { mailboxId, sinceSeq: seed.cursor, ck, userId: "u1", includeCollab: true, assignedTo: "u1" });

    const returnedThreadIds = delta.upserts.map((summary) => summary.threadId);
    expect(returnedThreadIds).toContain(threadForU1);
    expect(returnedThreadIds).not.toContain(threadForU2);
  });

  it("buildChanges resolves Email change_log (delivery ids) to thread ids", async () => {
    // Regression test for the bug where resolveThreadIds matched delivery ids against
    // message.id — meaning Email-type changes never produced thread-list deltas.
    const { mailboxId, threadIds } = await seedMailboxWithThreads(db, ck, 2);
    const [targetThreadId, otherThreadId] = threadIds;
    const seed = await buildSeed(db, { mailboxId, ck, userId: "u1", includeCollab: true, assignedTo: null });

    // Fire an Email change_log row by flipping is_read on a delivery in targetThread.
    // The trigger writes type='Email', object_id=delivery.id (NOT message.id).
    await db.run(
      `UPDATE delivery SET is_read=1 WHERE mailbox_id='${mailboxId}' AND message_id IN (SELECT id FROM message WHERE thread_id='${targetThreadId}')`,
    );

    const delta = await buildChanges(db, {
      mailboxId, sinceSeq: seed.cursor, ck, userId: "u1", includeCollab: true, assignedTo: null,
    });

    // (a) buildChanges must surface targetThread via the Email-type change_log entry.
    const deltaThreadIds = delta.upserts.map((summary) => summary.threadId);
    expect(deltaThreadIds).toContain(targetThreadId);

    // (b) buildThreadMessageChanges for otherThread must NOT include targetThread's message.
    const msgDelta = await buildThreadMessageChanges(db, {
      mailboxId, threadId: otherThreadId, sinceSeq: seed.cursor,
      ck, userId: "u1", includeCollab: true, assignedTo: null,
      env: { MAIL_RAW: undefined },
    });
    expect(msgDelta.upserts).toHaveLength(0);
  });
});
