// SPDX-License-Identifier: Apache-2.0
// Search reindex backfill: rebuilds message_search from encrypted D1 columns
// after the Porter migration DROPs it (or for pre-index mail). Honors
// mailbox.searchIndexed, pages by cursor, and is idempotent.
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { invalidateDomainCache } from "@doota/db/org-domains";
import { materializeMessage, materializeDelivery, type ParsedMessage } from "@doota/mail-core/materialize";
import { plaintextIndex } from "@doota/mail-core/search-index";
import { reindexMessages } from "@doota/mail-core/search-reindex";
import { importKey, type ContentKey } from "@doota/mail-core/crypto";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const ORG = "org1";

let db: any;
let ck: ContentKey;
let seq = 0;
let deps: { ck: ContentKey; searchKeyB64: string };

async function seed() {
  await db.insert(schema.organization).values({
    id: ORG, name: "Acme", slug: "acme-com", domain: "acme.com", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.orgMailSettings).values({ orgId: ORG, subaddressingEnabled: false, routingSubdomains: "[]" });
  await db.insert(schema.mailbox).values([
    { id: "mb_a", orgId: ORG, localPart: "alice", address: "alice@acme.com", isActive: true, isPersonal: true },
    { id: "mb_b", orgId: ORG, localPart: "bob", address: "bob@acme.com", isActive: true, isPersonal: true, searchIndexed: false },
  ]);
  invalidateDomainCache();
}

async function deliver(mailboxId: string, parts: { subject: string; text: string }, searchIndexed = true): Promise<string> {
  const id = `m${++seq}`;
  const pm: ParsedMessage = {
    messageIdHeader: `<${id}@ext>`, inReplyTo: null, references: null,
    from: "ext@sender.com", subject: parts.subject, sentAt: Date.now() + seq,
    text: parts.text, html: null, r2RawKey: `raw/${ORG}/${id}`, attachments: [],
  };
  const { messageId, threadId } = await materializeMessage(db, ORG, pm, deps, searchIndexed);
  await materializeDelivery(db, {
    orgId: ORG, messageId, threadId, mailboxId, role: "to", viaAliasId: null, subaddressTag: null, sentAt: pm.sentAt,
  });
  return messageId;
}

const ids = (hits: { messageId: string }[]) => hits.map((h) => h.messageId);

beforeEach(async () => {
  db = await makeDb();
  await seed();
  ck = await importKey(KEY_B64);
  deps = { ck, searchKeyB64: KEY_B64 };
  seq = 0;
});

describe("reindexMessages", () => {
  it("rebuilds the index after it's dropped, honoring searchIndexed", async () => {
    const a = await deliver("mb_a", { subject: "Invoice", text: "quarterly numbers" });
    const b = await deliver("mb_b", { subject: "HR case", text: "private" }, false);

    // Simulate the post-migration empty table: drop the one indexed row.
    await plaintextIndex(db).remove(a);
    expect(await plaintextIndex(db).search("invoice", { mailboxId: "mb_a" })).toEqual([]);

    const res = await reindexMessages(db, ck);
    expect(res.done).toBe(true);
    // Only the indexed-mailbox message is reindexed; the non-indexed one is skipped.
    expect(res.processed).toBe(1);
    expect(ids(await plaintextIndex(db).search("invoice", { mailboxId: "mb_a" }))).toContain(a);
    expect(await plaintextIndex(db).search("private", { mailboxId: "mb_b" })).toEqual([]);
    // b never entered the index.
    const rows = await db.all(`SELECT message_id FROM message_search WHERE message_id = '${b}'`);
    expect(rows.length ?? rows.results?.length ?? 0).toBe(0);
  });

  it("pages by cursor until done", async () => {
    const made = [
      await deliver("mb_a", { subject: "One", text: "alpha" }),
      await deliver("mb_a", { subject: "Two", text: "beta" }),
      await deliver("mb_a", { subject: "Three", text: "gamma" }),
    ];
    await Promise.all(made.map((id) => plaintextIndex(db).remove(id)));

    const first = await reindexMessages(db, ck, { limit: 2 });
    expect(first.processed).toBe(2);
    expect(first.done).toBe(false);
    expect(first.nextCursor).not.toBeNull();

    const second = await reindexMessages(db, ck, { limit: 2, cursor: first.nextCursor! });
    expect(second.processed).toBe(1);
    expect(second.done).toBe(true);

    // All three searchable again.
    expect(ids(await plaintextIndex(db).search("alpha", { mailboxId: "mb_a" }))).toContain(made[0]);
    expect(ids(await plaintextIndex(db).search("gamma", { mailboxId: "mb_a" }))).toContain(made[2]);
  });

  it("is idempotent — re-running keeps one row per message", async () => {
    const a = await deliver("mb_a", { subject: "Unique subject", text: "body text" });
    await reindexMessages(db, ck);
    await reindexMessages(db, ck);
    const hits = await plaintextIndex(db).search("unique", { mailboxId: "mb_a" });
    expect(hits.filter((h) => h.messageId === a).length).toBe(1);
  });
});
