import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { importKey, encryptContent, decryptContent } from "@doota/mail-core/crypto";
import { createNote, editNote, softDeleteNote, listNotes } from "@doota/mail-core/notes";
import { assignThread, listSystemEvents, isSharedMailbox } from "@doota/mail-core/collab";
import { searchNotes } from "@doota/mail-core/search";
import { getThread } from "@doota/mail-core/read";
import { createDraft, sendDraft } from "@doota/mail-core/drafts";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const ORG = "org1";

function fakeR2() {
  const store = new Map<string, ArrayBuffer | string>();
  return {
    store,
    async put(k: string, v: ArrayBuffer | string) { store.set(k, v); },
    async get(k: string) {
      if (!store.has(k)) return null;
      const v = store.get(k)!;
      return { async arrayBuffer() { return typeof v === "string" ? new TextEncoder().encode(v).buffer : v; }, async text() { return typeof v === "string" ? v : new TextDecoder().decode(v); } };
    },
    async delete(k: string) { store.delete(k); },
    async list({ prefix }: { prefix: string }) { return { objects: [...store.keys()].filter((x) => x.startsWith(prefix)).map((key) => ({ key })) }; },
  };
}
function fakeQueue() { const sent: unknown[] = []; return { sent, async send(b: unknown) { sent.push(b); } }; }

let db: any;
let ck: Awaited<ReturnType<typeof importKey>>;
let r2: ReturnType<typeof fakeR2>;
let queue: ReturnType<typeof fakeQueue>;
const env = () => ({ MAIL_DEK: KEY_B64, MAIL_SEARCH_KEY: KEY_B64, MAIL_RAW: r2 as never, MAIL_OUT_QUEUE: queue as never });

async function seed(db: any) {
  await db.insert(schema.organization).values({ id: ORG, name: "Acme", slug: "acme-com", domain: "acme.com", status: "active", createdAt: new Date() });
  await db.insert(schema.orgMailSettings).values({ orgId: ORG, subaddressingEnabled: false, routingSubdomains: "[]", returnPathDomain: "bounce.acme.com" });
  const u = (id: string, email: string) => ({ id, name: id, email, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(schema.user).values([u("u1", "a@x.com"), u("u2", "b@x.com")]);
  await db.insert(schema.mailbox).values([
    { id: "mb_alice", orgId: ORG, localPart: "alice", address: "alice@acme.com", isActive: true, isPersonal: true },
    { id: "mb_support", orgId: ORG, localPart: "support", address: "support@acme.com", isActive: true, isPersonal: false },
  ]);
  await db.insert(schema.mailboxAccess).values([
    { id: "ac1", userId: "u1", mailboxId: "mb_alice", canManage: true, canSend: true },
    { id: "ac2", userId: "u1", mailboxId: "mb_support", canManage: true, canSend: true },
    { id: "ac3", userId: "u2", mailboxId: "mb_support", canManage: false, canSend: true },
  ]);
  // A thread delivered to both mailboxes.
  await db.insert(schema.thread).values({ id: "th1", orgId: ORG, lastMessageAt: new Date() });
  await db.insert(schema.threadState).values([
    { id: "ts_a", orgId: ORG, threadId: "th1", mailboxId: "mb_alice", placement: "inbox" },
    { id: "ts_s", orgId: ORG, threadId: "th1", mailboxId: "mb_support", placement: "inbox" },
  ]);
}

beforeEach(async () => {
  db = await makeDb();
  await seed(db);
  ck = await importKey(KEY_B64);
  r2 = fakeR2();
  queue = fakeQueue();
});

describe("SAFETY — a note can never reach the outbound path", () => {
  it("sending in a thread that has a note never sources the note's content", async () => {
    await createNote(db, ck, KEY_B64, { orgId: ORG, threadId: "th1", mailboxId: "mb_alice", authorUserId: "u1", body: "SECRET INTERNAL — do not send" });

    // A normal send in the same thread.
    const d = await createDraft(db, ck, "u1", { mailboxId: "mb_alice", kind: "reply", threadId: "th1", to: ["out@ext.com"], body: "public reply" });
    const { submissionId } = await sendDraft(db, env(), ck, "u1", { draftId: d.id });

    const sub = await db.query.submission.findFirst({ where: eq(schema.submission.id, submissionId) });
    const msg = await db.query.message.findFirst({ where: eq(schema.message.id, sub.messageId) });
    // The submission's message is the reply, never the note.
    expect(await decryptContent(ck, msg.bodyStrippedEnc)).toBe("public reply");
    // No message/submission row anywhere carries the note text.
    const msgs = await db.query.message.findMany();
    for (const m of msgs) {
      expect(await decryptContent(ck, m.bodyStrippedEnc)).not.toContain("SECRET INTERNAL");
      expect(await decryptContent(ck, m.bodyHtmlEnc)).not.toContain("SECRET INTERNAL");
    }
    // The note lives only in internal_note; nothing points a submission at it.
    const note = await db.query.internalNote.findFirst();
    const subForNote = await db.query.submission.findFirst({ where: eq(schema.submission.messageId, note.id) });
    expect(subForNote).toBeUndefined();
  });
});

describe("notes — visibility follows mailbox_access", () => {
  it("getThread omits notes when includeCollab is false (org-admin read, no grant)", async () => {
    await createNote(db, ck, KEY_B64, { orgId: ORG, threadId: "th1", mailboxId: "mb_alice", authorUserId: "u1", body: "note" });
    const withoutGrant = await getThread(db, { threadId: "th1", mailboxId: "mb_alice", ck, includeCollab: false });
    expect(withoutGrant!.items.some((i) => i.type === "internal_note")).toBe(false);
    const withGrant = await getThread(db, { threadId: "th1", mailboxId: "mb_alice", ck, includeCollab: true });
    expect(withGrant!.items.some((i) => i.type === "internal_note")).toBe(true);
  });

  it("a note in one mailbox is invisible in another for the same thread", async () => {
    await createNote(db, ck, KEY_B64, { orgId: ORG, threadId: "th1", mailboxId: "mb_alice", authorUserId: "u1", body: "alice-only" });
    const support = await getThread(db, { threadId: "th1", mailboxId: "mb_support", ck, includeCollab: true });
    expect(support!.items.some((i) => i.type === "internal_note")).toBe(false);
  });
});

describe("assignment", () => {
  it("rejects an assignee lacking mailbox_access", async () => {
    await expect(
      assignThread(db, { orgId: ORG, threadId: "th1", mailboxId: "mb_alice", assigneeUserId: "u2", actorUserId: "u1" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("emits NO system event for a personal mailbox, but does for a shared one", async () => {
    expect(await isSharedMailbox(db, "mb_alice")).toBe(false);
    expect(await isSharedMailbox(db, "mb_support")).toBe(true);

    await assignThread(db, { orgId: ORG, threadId: "th1", mailboxId: "mb_alice", assigneeUserId: "u1", actorUserId: "u1" });
    expect(await listSystemEvents(db, "th1", "mb_alice")).toHaveLength(0);

    await assignThread(db, { orgId: ORG, threadId: "th1", mailboxId: "mb_support", assigneeUserId: "u2", actorUserId: "u1" });
    const events = await listSystemEvents(db, "th1", "mb_support");
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("assigned");
    expect(events[0].data.assigneeUserId).toBe("u2");
  });
});

describe("note search", () => {
  it("is mailbox-scoped, blind-tokenized, and drops soft-deleted notes", async () => {
    const n = await createNote(db, ck, KEY_B64, { orgId: ORG, threadId: "th1", mailboxId: "mb_alice", authorUserId: "u1", body: "refund requested urgently" });
    // Blind: the stored FTS tokens are HMACs, not the plaintext words.
    const fts = await db.all(`SELECT tokens FROM note_fts WHERE note_id = '${n.id}'`);
    expect(String(fts[0]?.tokens ?? "")).not.toContain("refund");

    expect(await searchNotes(db, { searchKeyB64: KEY_B64, mailboxId: "mb_alice", queryText: "refund" })).toContain(n.id);
    // Scoped: not found from another mailbox.
    expect(await searchNotes(db, { searchKeyB64: KEY_B64, mailboxId: "mb_support", queryText: "refund" })).toEqual([]);

    // Soft delete → tombstone in list, gone from search.
    await softDeleteNote(db, { noteId: n.id, userId: "u1" });
    const notes = await listNotes(db, ck, "th1", "mb_alice");
    expect(notes[0].deleted).toBe(true);
    expect(notes[0].body).toBeNull();
    expect(await searchNotes(db, { searchKeyB64: KEY_B64, mailboxId: "mb_alice", queryText: "refund" })).toEqual([]);
  });

  it("only the author can edit a note", async () => {
    const n = await createNote(db, ck, KEY_B64, { orgId: ORG, threadId: "th1", mailboxId: "mb_support", authorUserId: "u1", body: "mine" });
    await expect(editNote(db, ck, KEY_B64, { noteId: n.id, userId: "u2", body: "hijack" })).rejects.toMatchObject({ status: 403 });
  });
});

describe("timeline ordering across mixed kinds", () => {
  it("interleaves messages, notes, and system events by time", async () => {
    const base = Date.now() - 100000;
    await db.insert(schema.message).values({ id: "m1", orgId: ORG, threadId: "th1", messageIdHeader: "<m1@x>", fromAddr: "c@x.com", sentAt: new Date(base), bodyStrippedEnc: await encryptContent(ck, "hello") });
    await db.insert(schema.delivery).values({ id: "d1", orgId: ORG, messageId: "m1", mailboxId: "mb_support", role: "to" });
    // note after the message
    await db.insert(schema.internalNote).values({ id: "n1", orgId: ORG, threadId: "th1", mailboxId: "mb_support", authorUserId: "u1", bodyEnc: await encryptContent(ck, "note"), createdAt: new Date(base + 1000) });
    // event after the note
    await db.insert(schema.systemEvent).values({ id: "e1", orgId: ORG, threadId: "th1", mailboxId: "mb_support", actorUserId: "u1", eventType: "assigned", data: "{}", createdAt: new Date(base + 2000) });

    const dto = await getThread(db, { threadId: "th1", mailboxId: "mb_support", ck, includeCollab: true });
    const kinds = dto!.items.map((i) => i.type);
    expect(kinds).toEqual(["external_message", "internal_note", "system_event"]);
  });
});
