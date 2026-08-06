// SPDX-License-Identifier: Apache-2.0
// Phase B (pin) stop gates: the pinned list is a SEPARATE query (newest-pin
// first) over only the pinned set, the main list is unchanged, and a placement
// change never clears the pin (pinned is orthogonal to placement).
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { importKey } from "@doota/mail-core/crypto";
import { materializeMessage, materializeDelivery, type ParsedMessage } from "@doota/mail-core/materialize";
import { listThreads } from "@doota/mail-core/read";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const ORG = "org1";
let db: Awaited<ReturnType<typeof makeDb>>;
let ck: Awaited<ReturnType<typeof importKey>>;
let deps: { ck: Awaited<ReturnType<typeof importKey>>; searchKeyB64: string };

async function seed() {
  await db.insert(schema.organization).values({
    id: ORG, name: "Acme", slug: "acme", domain: "acme.com", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.mailbox).values({
    id: "mb1", orgId: ORG, localPart: "a", address: "a@acme.com", isActive: true, isPersonal: true,
  });
}

function parsed(over: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    messageIdHeader: `<${crypto.randomUUID()}@ext>`, inReplyTo: null, references: null,
    from: "ext@sender.com", subject: "Hi", sentAt: Date.now(),
    text: "Body.", html: null, r2RawKey: null, attachments: [],
    ...over,
  };
}

async function deliver(subject: string) {
  const ids = await materializeMessage(db, ORG, parsed({ subject }), deps);
  await materializeDelivery(db, {
    orgId: ORG, ...ids, mailboxId: "mb1", role: "to", viaAliasId: null, subaddressTag: null, sentAt: Date.now(),
  });
  return ids.threadId;
}

async function pin(threadId: string, at: number) {
  await db
    .update(schema.threadState)
    .set({ pinnedAt: new Date(at) })
    .where(and(eq(schema.threadState.threadId, threadId), eq(schema.threadState.mailboxId, "mb1")));
}

beforeEach(async () => {
  db = await makeDb();
  await seed();
  ck = await importKey(KEY_B64);
  deps = { ck, searchKeyB64: KEY_B64 };
});

describe("pin a mail", () => {
  it("pinnedOnly returns only pinned threads, newest-pin first", async () => {
    const a = await deliver("A");
    const b = await deliver("B");
    const c = await deliver("C");
    await pin(a, 1000);
    await pin(c, 2000); // pinned later → should sort first

    const pinned = await listThreads(db, { mailboxId: "mb1", placement: "inbox", ck, pinnedOnly: true });
    expect(pinned.map((t) => t.threadId)).toEqual([c, a]); // newest pin first, b excluded
    expect(pinned.every((t) => t.pinnedAt !== null)).toBe(true);

    // The main list is unchanged — still returns all three (pin is not a filter here).
    const main = await listThreads(db, { mailboxId: "mb1", placement: "inbox", ck });
    expect(main.map((t) => t.threadId).sort()).toEqual([a, b, c].sort());
  });

  it("a placement change never clears the pin (orthogonal to placement)", async () => {
    const a = await deliver("A");
    await pin(a, 1000);
    // Simulate a move: change placement only (like moveThread, which sets
    // snoozedUntil:null but NOT pinnedAt).
    await db
      .update(schema.threadState)
      .set({ placement: "archived", snoozedUntil: null })
      .where(and(eq(schema.threadState.threadId, a), eq(schema.threadState.mailboxId, "mb1")));

    // Still pinned, now in the archived view.
    const inInbox = await listThreads(db, { mailboxId: "mb1", placement: "inbox", ck, pinnedOnly: true });
    expect(inInbox).toHaveLength(0);
    const inArchive = await listThreads(db, { mailboxId: "mb1", placement: "archived", ck, pinnedOnly: true });
    expect(inArchive.map((t) => t.threadId)).toEqual([a]);
  });
});
