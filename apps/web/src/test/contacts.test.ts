// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { recordCorrespondents, suggestRecipients, topRecipients } from "@doota/mail-core/contacts";

const ORG = "org1";
const USER = "u1";
const MB = "mb1";

async function seed(db: any) {
  await db.insert(schema.organization).values({ id: ORG, name: "Acme", slug: "acme", domain: "acme.com", status: "active", createdAt: new Date() });
  await db.insert(schema.user).values({ id: USER, name: "Alice", email: "alice@acme.com" });
  await db.insert(schema.mailbox).values({ id: MB, orgId: ORG, localPart: "alice", address: "alice@acme.com", isActive: true, isPersonal: true });
  await db.insert(schema.mailboxAccess).values({ id: "acc1", userId: USER, mailboxId: MB, canManage: true });
}

let db: any;
beforeEach(async () => {
  db = await makeDb();
  await seed(db);
});

describe("correspondent autocomplete", () => {
  it("suggests recorded correspondents, most-recent first", async () => {
    await recordCorrespondents(db, [
      { mailboxId: MB, address: "old@ext.com", name: "Old", seenAt: 1000 },
      { mailboxId: MB, address: "new@ext.com", name: "New", seenAt: 5000 },
    ]);
    const top = await topRecipients(db, USER);
    expect(top.map((recipient) => recipient.address)).toEqual(["new@ext.com", "old@ext.com"]);
    expect(top.find((recipient) => recipient.address === "new@ext.com")?.name).toBe("New");
  });

  it("dedups per (mailbox,address), keeps newest last_seen + fills a name", async () => {
    await recordCorrespondents(db, [{ mailboxId: MB, address: "x@ext.com", name: null, seenAt: 1000 }]);
    await recordCorrespondents(db, [{ mailboxId: MB, address: "X@Ext.com", name: "Xavier", seenAt: 9000 }]);
    // An out-of-order older write must NOT move recency backwards.
    await recordCorrespondents(db, [{ mailboxId: MB, address: "x@ext.com", name: null, seenAt: 500 }]);
    const rows = await db.select().from(schema.correspondent);
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe("x@ext.com"); // lowercased
    expect(rows[0].name).toBe("Xavier"); // filled from the later write, not nulled back
    expect(rows[0].lastSeenAt.getTime()).toBe(9000); // monotonic
  });

  it("prefix-filters (type-ahead)", async () => {
    await recordCorrespondents(db, [
      { mailboxId: MB, address: "bob@ext.com", name: null, seenAt: 3000 },
      { mailboxId: MB, address: "carol@ext.com", name: null, seenAt: 4000 },
    ]);
    const hits = await suggestRecipients(db, USER, "bob");
    expect(hits.map((recipient) => recipient.address)).toEqual(["bob@ext.com"]);
  });

  it("scopes to the caller's accessible mailboxes", async () => {
    // A correspondent on a mailbox the user has no access to must not leak.
    await db.insert(schema.mailbox).values({ id: "mb2", orgId: ORG, localPart: "bob", address: "bob@acme.com", isActive: true, isPersonal: true });
    await recordCorrespondents(db, [{ mailboxId: "mb2", address: "secret@ext.com", name: null, seenAt: 8000 }]);
    const top = await topRecipients(db, USER);
    expect(top.find((recipient) => recipient.address === "secret@ext.com")).toBeUndefined();
  });
});

describe("correspondent interaction facts (Phase 3)", () => {
  it("inbound bumps message_count + first_seen_at once; sent stamps last_replied_at", async () => {
    const { makeDb } = await import("./mail-db");
    const { recordCorrespondents } = await import("@doota/mail-core/contacts");
    const schema = await import("@doota/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const db: any = await makeDb();
    await db.insert(schema.organization).values({ id: "o1", name: "A", slug: "a", domain: "a.com", status: "active", createdAt: new Date() });
    await db.insert(schema.mailbox).values({ id: "mb1", orgId: "o1", localPart: "a", address: "a@a.com", isActive: true });

    const t0 = Date.now();
    await recordCorrespondents(db, [{ mailboxId: "mb1", address: "ext@x.com", name: "Ext", seenAt: t0 }]);
    await recordCorrespondents(db, [{ mailboxId: "mb1", address: "ext@x.com", seenAt: t0 + 1000 }]);
    let row = await db.query.correspondent.findFirst({
      where: and(eq(schema.correspondent.mailboxId, "mb1"), eq(schema.correspondent.address, "ext@x.com")),
    });
    expect(row.messageCount).toBe(2);
    expect(row.firstSeenAt.getTime()).toBe(t0); // set once, never advanced
    expect(row.lastRepliedAt).toBeNull();

    await recordCorrespondents(db, [{ mailboxId: "mb1", address: "ext@x.com", seenAt: t0 + 2000, direction: "sent" }]);
    row = await db.query.correspondent.findFirst({
      where: and(eq(schema.correspondent.mailboxId, "mb1"), eq(schema.correspondent.address, "ext@x.com")),
    });
    expect(row.lastRepliedAt.getTime()).toBe(t0 + 2000);
    expect(row.messageCount).toBe(2); // a send is not an inbound message
  });
});
