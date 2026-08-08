// SPDX-License-Identifier: Apache-2.0
// Plaintext FTS5 search index: ingest indexes subject+stripped-body, search is
// mailbox-scoped + trash-excluded + BM25-ranked (subject weighted), purge removes
// the row, and a non-indexed mailbox is never searchable. Exercises the REAL
// materialize → indexContent → message_search path against in-memory D1.
import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { invalidateDomainCache } from "@doota/db/org-domains";
import { materializeMessage, materializeDelivery, type ParsedMessage } from "@doota/mail-core/materialize";
import { plaintextIndex, buildMatch } from "@doota/mail-core/search-index";
import { importKey, type ContentKey } from "@doota/mail-core/crypto";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const ORG = "org1";

async function seed(db: any) {
  await db.insert(schema.organization).values({
    id: ORG, name: "Acme", slug: "acme-com", domain: "acme.com", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.orgMailSettings).values({ orgId: ORG, subaddressingEnabled: false, routingSubdomains: "[]" });
  await db.insert(schema.mailbox).values([
    { id: "mb_a", orgId: ORG, localPart: "alice", address: "alice@acme.com", isActive: true, isPersonal: true },
    { id: "mb_b", orgId: ORG, localPart: "bob", address: "bob@acme.com", isActive: true, isPersonal: true },
  ]);
  invalidateDomainCache();
}

let db: any;
let ck: ContentKey;
let seq = 0;
let deps: { ck: ContentKey; searchKeyB64: string };

beforeEach(async () => {
  db = await makeDb();
  await seed(db);
  ck = await importKey(KEY_B64);
  deps = { ck, searchKeyB64: KEY_B64 };
  seq = 0;
});

// Materialize a message + deliver it to a mailbox (creates delivery + thread_state).
async function deliver(
  mailboxId: string,
  parts: { subject: string; text: string },
  searchIndexed = true,
): Promise<string> {
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

describe("buildMatch", () => {
  it("prefixes barewords and strips FTS operators", () => {
    expect(buildMatch("invoice")).toBe("invoice*");
    expect(buildMatch("acme invoice")).toBe("acme* invoice*");
    // operator/syntax chars neutralized (no injection, no bare AND/OR/NEAR)
    expect(buildMatch('foo* OR bar" NEAR')).toBe("foo* or* bar* near*");
    expect(buildMatch("   ")).toBe("");
  });
  it("keeps quoted phrases as phrases", () => {
    expect(buildMatch('"quarterly review"')).toBe('"quarterly review"');
    expect(buildMatch('"quarterly review" budget')).toBe('"quarterly review" budget*');
  });
});

describe("plaintext search index", () => {
  it("finds a message by subject and body, mailbox-scoped", async () => {
    const m = await deliver("mb_a", { subject: "Quarterly review", text: "Let's discuss the invoice numbers." });
    const idx = plaintextIndex(db);
    expect(ids(await idx.search("quarterly", { mailboxId: "mb_a" }))).toContain(m);
    expect(ids(await idx.search("invoice", { mailboxId: "mb_a" }))).toContain(m);
    // Another mailbox can't see it (scoped via deliveries).
    expect(await idx.search("quarterly", { mailboxId: "mb_b" })).toEqual([]);
  });

  it("supports prefix (auto) and exact phrase queries", async () => {
    const m = await deliver("mb_a", { subject: "Quarterly planning", text: "budget and headcount" });
    const idx = plaintextIndex(db);
    expect(ids(await idx.search("quart", { mailboxId: "mb_a" }))).toContain(m); // prefix
    expect(ids(await idx.search('"quarterly planning"', { mailboxId: "mb_a" }))).toContain(m); // phrase
    expect(await idx.search('"planning quarterly"', { mailboxId: "mb_a" })).toEqual([]); // wrong order
  });

  it("ranks a subject hit above a body-only hit (BM25 subject weight)", async () => {
    const subjectHit = await deliver("mb_a", { subject: "Widget order", text: "unrelated content here" });
    const bodyHit = await deliver("mb_a", { subject: "Unrelated", text: "please ship the widget soon" });
    const order = ids(await plaintextIndex(db).search("widget", { mailboxId: "mb_a" }));
    expect(order.indexOf(subjectHit)).toBeLessThan(order.indexOf(bodyHit));
  });

  it("remove() deletes the index row (purge parity)", async () => {
    const m = await deliver("mb_a", { subject: "Secret memo", text: "confidential" });
    const idx = plaintextIndex(db);
    expect(ids(await idx.search("secret", { mailboxId: "mb_a" }))).toContain(m);
    await idx.remove(m);
    expect(await idx.search("secret", { mailboxId: "mb_a" })).toEqual([]);
  });

  it("excludes trashed threads from results", async () => {
    const m = await deliver("mb_a", { subject: "Trash me", text: "old thread" });
    await db.update(schema.threadState).set({ placement: "trash" }).where(eq(schema.threadState.mailboxId, "mb_a"));
    expect(await plaintextIndex(db).search("trash", { mailboxId: "mb_a" })).toEqual([]);
  });

  it("does NOT index a message for a non-indexed mailbox", async () => {
    const m = await deliver("mb_b", { subject: "Sensitive HR case", text: "private details" }, /* searchIndexed */ false);
    expect(await plaintextIndex(db).search("sensitive", { mailboxId: "mb_b" })).toEqual([]);
    // Row genuinely absent from the index, not just filtered.
    const rows = await db.all(`SELECT message_id FROM message_search WHERE message_id = '${m}'`);
    expect(rows.length ?? rows.results?.length ?? 0).toBe(0);
  });
});
