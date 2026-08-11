// SPDX-License-Identifier: Apache-2.0
// Server-side helpers: buildSeedThread (full timeline).
// Uses makeDb (in-memory SQLite + real migrations) + a fake R2 bucket so
// renderFramedBody can decrypt the rich message's raw MIME bytes.
import { describe, it, expect, beforeEach } from "vitest";
import { makeDb } from "./mail-db";
import { importKey } from "@doota/mail-core/crypto";
import { seedThreadWithRichNoteAndPlainMessage } from "./helpers/seed-threads";
import { buildSeedThread } from "$lib/rpc/thread-localdb";
import { RENDER_CACHE_VERSION } from "@doota/mail-core/mime";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");

let db: any;
let ck: Awaited<ReturnType<typeof importKey>>;

beforeEach(async () => {
  db = await makeDb();
  ck = await importKey(KEY_B64);
});

describe("buildSeedThread (full timeline)", () => {
  it("returns all items (messages + note), cursor, and renderVersion", async () => {
    const { mailboxId, threadId, bucket } = await seedThreadWithRichNoteAndPlainMessage(db, ck);
    const result = await buildSeedThread(db, {
      mailboxId,
      threadId,
      ck,
      userId: "u1",
      includeCollab: true,
      assignedTo: null,
      env: { MAIL_RAW: bucket },
    });

    // At least the 2 messages + 1 note
    expect(result.items.length).toBeGreaterThanOrEqual(3);
    expect(typeof result.cursor).toBe("number");
    expect(result.renderVersion).toBe(RENDER_CACHE_VERSION);
  });

  it("rich message item has non-null framedHtml containing <!doctype html", async () => {
    const { mailboxId, threadId, richMessageId, bucket } = await seedThreadWithRichNoteAndPlainMessage(db, ck);
    const result = await buildSeedThread(db, {
      mailboxId,
      threadId,
      ck,
      userId: "u1",
      includeCollab: true,
      assignedTo: null,
      env: { MAIL_RAW: bucket },
    });

    const richItem = result.items.find((item) => item.itemId === richMessageId);
    expect(richItem).toBeDefined();
    expect(richItem!.itemType).toBe("external_message");
    expect(richItem!.framedHtml).not.toBeNull();
    expect(richItem!.framedHtml!.toLowerCase()).toContain("<!doctype html");
    expect(richItem!.framedHtml).toContain("rich");
  });

  it("plain message has null framedHtml and non-null body in payload", async () => {
    const { mailboxId, threadId, plainMessageId, bucket } = await seedThreadWithRichNoteAndPlainMessage(db, ck);
    const result = await buildSeedThread(db, {
      mailboxId,
      threadId,
      ck,
      userId: "u1",
      includeCollab: true,
      assignedTo: null,
      env: { MAIL_RAW: bucket },
    });

    const plainItem = result.items.find((item) => item.itemId === plainMessageId);
    expect(plainItem).toBeDefined();
    expect(plainItem!.itemType).toBe("external_message");
    expect(plainItem!.framedHtml).toBeNull();
    const payload = plainItem!.payload as any;
    expect(payload.bodyStripped ?? payload.bodyFull).toBeTruthy();
  });

  it("internal note item has null framedHtml and correct itemType", async () => {
    const { mailboxId, threadId, noteId, bucket } = await seedThreadWithRichNoteAndPlainMessage(db, ck);
    const result = await buildSeedThread(db, {
      mailboxId,
      threadId,
      ck,
      userId: "u1",
      includeCollab: true,
      assignedTo: null,
      env: { MAIL_RAW: bucket },
    });

    const noteItem = result.items.find((item) => item.itemId === noteId);
    expect(noteItem).toBeDefined();
    expect(noteItem!.itemType).toBe("internal_note");
    expect(noteItem!.framedHtml).toBeNull();
    const payload = noteItem!.payload as any;
    expect(payload.body).toBeTruthy();
  });

  it("items are ordered by seq (getThread order)", async () => {
    const { mailboxId, threadId, richMessageId, bucket } = await seedThreadWithRichNoteAndPlainMessage(db, ck);
    const result = await buildSeedThread(db, {
      mailboxId,
      threadId,
      ck,
      userId: "u1",
      includeCollab: true,
      assignedTo: null,
      env: { MAIL_RAW: bucket },
    });

    const seqs = result.items.map((item) => item.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    // First item is the rich message (sent earliest)
    expect(result.items[0].itemId).toBe(richMessageId);
  });

  it("returns empty items for an unknown thread", async () => {
    const { mailboxId, bucket } = await seedThreadWithRichNoteAndPlainMessage(db, ck);
    const result = await buildSeedThread(db, {
      mailboxId,
      threadId: "nonexistent-thread",
      ck,
      userId: "u1",
      includeCollab: true,
      assignedTo: null,
      env: { MAIL_RAW: bucket },
    });

    expect(result.items).toHaveLength(0);
    expect(result.renderVersion).toBe(RENDER_CACHE_VERSION);
  });

  it("excludes notes when includeCollab is false", async () => {
    const { mailboxId, threadId, noteId, bucket } = await seedThreadWithRichNoteAndPlainMessage(db, ck);
    const result = await buildSeedThread(db, {
      mailboxId,
      threadId,
      ck,
      userId: "u1",
      includeCollab: false,
      assignedTo: null,
      env: { MAIL_RAW: bucket },
    });

    // Notes should not appear when includeCollab=false
    const noteItem = result.items.find((item) => item.itemId === noteId);
    expect(noteItem).toBeUndefined();
    // But messages should still appear
    expect(result.items.filter((item) => item.itemType === "external_message").length).toBeGreaterThan(0);
  });
});
