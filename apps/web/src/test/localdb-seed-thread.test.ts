// SPDX-License-Identifier: Apache-2.0
// Server-side helpers: buildSeedThread + buildThreadMessageChanges.
// Uses makeDb (in-memory SQLite + real migrations) + a fake R2 bucket so
// renderFramedBody can decrypt the rich message's raw MIME bytes.
import { describe, it, expect, beforeEach } from "vitest";
import { makeDb } from "./mail-db";
import { importKey } from "@doota/mail-core/crypto";
import { seedThreadWithRichAndPlainMessage, seedMailboxWithThreads } from "./helpers/seed-threads";
import { buildSeedThread, buildThreadMessageChanges } from "$lib/rpc/thread-localdb";
import { RENDER_CACHE_VERSION } from "@doota/mail-core/mime";
import * as mailSchema from "@doota/db/mail.schema";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");

let db: any;
let ck: Awaited<ReturnType<typeof importKey>>;

beforeEach(async () => {
  db = await makeDb();
  ck = await importKey(KEY_B64);
});

describe("buildSeedThread", () => {
  it("returns both messages, cursor, and renderVersion", async () => {
    const { mailboxId, threadId, bucket } = await seedThreadWithRichAndPlainMessage(db, ck);
    const result = await buildSeedThread(db, {
      mailboxId,
      threadId,
      ck,
      userId: "u1",
      includeCollab: false,
      assignedTo: null,
      env: { MAIL_RAW: bucket },
    });

    expect(result.messages).toHaveLength(2);
    expect(typeof result.cursor).toBe("number");
    expect(result.renderVersion).toBe(RENDER_CACHE_VERSION);
  });

  it("rich message has non-null framedHtml containing <!doctype html", async () => {
    const { mailboxId, threadId, richMessageId, bucket } = await seedThreadWithRichAndPlainMessage(db, ck);
    const result = await buildSeedThread(db, {
      mailboxId,
      threadId,
      ck,
      userId: "u1",
      includeCollab: false,
      assignedTo: null,
      env: { MAIL_RAW: bucket },
    });

    const richMsg = result.messages.find((message) => message.id === richMessageId);
    expect(richMsg).toBeDefined();
    expect(richMsg!.framedHtml).not.toBeNull();
    expect(richMsg!.framedHtml!.toLowerCase()).toContain("<!doctype html");
    expect(richMsg!.framedHtml).toContain("rich");
  });

  it("plain message has null framedHtml and non-null bodyStripped", async () => {
    const { mailboxId, threadId, plainMessageId, bucket } = await seedThreadWithRichAndPlainMessage(db, ck);
    const result = await buildSeedThread(db, {
      mailboxId,
      threadId,
      ck,
      userId: "u1",
      includeCollab: false,
      assignedTo: null,
      env: { MAIL_RAW: bucket },
    });

    const plainMsg = result.messages.find((message) => message.id === plainMessageId);
    expect(plainMsg).toBeDefined();
    expect(plainMsg!.framedHtml).toBeNull();
    // bodyStripped is the decrypted plain-text preview
    expect(plainMsg!.bodyStripped ?? plainMsg!.bodyFull).toBeTruthy();
  });

  it("messages are ordered by seq (sentAt order)", async () => {
    const { mailboxId, threadId, richMessageId, bucket } = await seedThreadWithRichAndPlainMessage(db, ck);
    const result = await buildSeedThread(db, {
      mailboxId,
      threadId,
      ck,
      userId: "u1",
      includeCollab: false,
      assignedTo: null,
      env: { MAIL_RAW: bucket },
    });

    // seq values should be ascending
    const seqs = result.messages.map((message) => message.seq);
    expect(seqs).toEqual([...seqs].sort((firstSeq, secondSeq) => firstSeq - secondSeq));
    // First message is the rich one (sent earlier)
    expect(result.messages[0].id).toBe(richMessageId);
  });

  it("returns empty messages for an unknown thread", async () => {
    const { mailboxId, bucket } = await seedThreadWithRichAndPlainMessage(db, ck);
    const result = await buildSeedThread(db, {
      mailboxId,
      threadId: "nonexistent-thread",
      ck,
      userId: "u1",
      includeCollab: false,
      assignedTo: null,
      env: { MAIL_RAW: bucket },
    });

    expect(result.messages).toHaveLength(0);
    expect(result.renderVersion).toBe(RENDER_CACHE_VERSION);
  });
});

describe("buildThreadMessageChanges", () => {
  it("returns upsert for a changed message and advances newSeq", async () => {
    const { mailboxId, threadId, richMessageId, bucket } = await seedThreadWithRichAndPlainMessage(db, ck);
    const seed = await buildSeedThread(db, {
      mailboxId,
      threadId,
      ck,
      userId: "u1",
      includeCollab: false,
      assignedTo: null,
      env: { MAIL_RAW: bucket },
    });

    // Trigger a delivery read-state change → writes a change_log row via trigger.
    await db.run(
      `UPDATE delivery SET is_read=1 WHERE message_id='${richMessageId}' AND mailbox_id='${mailboxId}'`,
    );

    const delta = await buildThreadMessageChanges(db, {
      mailboxId,
      threadId,
      sinceSeq: seed.cursor,
      ck,
      userId: "u1",
      includeCollab: false,
      assignedTo: null,
      env: { MAIL_RAW: bucket },
    });

    expect(delta.cannotCalculate).toBe(false);
    expect(delta.newSeq).toBeGreaterThan(seed.cursor);
    expect(delta.upserts.some((message) => message.id === richMessageId)).toBe(true);
    expect(delta.removals).toHaveLength(0);
  });

  it("returns cannotCalculate when cursor is below the floor", async () => {
    const { mailboxId, threadId, bucket } = await seedThreadWithRichAndPlainMessage(db, ck);
    // Insert a floor above the current cursor.
    await db.insert(mailSchema.changeLogFloor).values({ mailboxId, floorSeq: 999 });

    const delta = await buildThreadMessageChanges(db, {
      mailboxId,
      threadId,
      sinceSeq: 0,
      ck,
      userId: "u1",
      includeCollab: false,
      assignedTo: null,
      env: { MAIL_RAW: bucket },
    });

    expect(delta.cannotCalculate).toBe(true);
  });

  it("ignores change_log entries for other threads", async () => {
    // Seed two threads in the same mailbox.
    const { mailboxId, threadIds } = await seedMailboxWithThreads(db, ck, 2);
    const [targetThreadId, otherThreadId] = threadIds;
    // Wait — seedMailboxWithThreads uses a different mailboxId ("mb_seeded").
    // That's fine, we use its mailboxId.

    // Get the current cursor.
    const seed = await buildSeedThread(db, {
      mailboxId,
      threadId: targetThreadId,
      ck,
      userId: "u1",
      includeCollab: false,
      assignedTo: null,
      env: { MAIL_RAW: undefined },
    });

    // Change something in the other thread via a placement update (triggers Thread change_log).
    await db.run(
      `UPDATE thread_state SET placement='archived' WHERE thread_id='${otherThreadId}' AND mailbox_id='${mailboxId}'`,
    );

    const delta = await buildThreadMessageChanges(db, {
      mailboxId,
      threadId: targetThreadId,
      sinceSeq: seed.cursor,
      ck,
      userId: "u1",
      includeCollab: false,
      assignedTo: null,
      env: { MAIL_RAW: undefined },
    });

    // No Email changes for targetThread → no upserts.
    expect(delta.cannotCalculate).toBe(false);
    expect(delta.upserts).toHaveLength(0);
    expect(delta.removals).toHaveLength(0);
  });
});
