// SPDX-License-Identifier: Apache-2.0
// Endpoint LOGIC is tested through the exported helpers they wrap (remote fns
// need a request context). We test the wrapped pure functions: buildSeed() and
// buildChanges() extracted from the remote handlers.
import { describe, it, expect, beforeEach } from "vitest";
import { makeDb } from "./mail-db";
import { importKey } from "@doota/mail-core/crypto";
import { seedMailboxWithThreads } from "./helpers/seed-threads";
import { buildSeed, buildChanges } from "$lib/rpc/thread-localdb"; // pure helpers (see Step 3)

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
});
