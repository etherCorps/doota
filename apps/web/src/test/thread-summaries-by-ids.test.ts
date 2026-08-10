// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import { makeDb } from "./mail-db";
import { importKey } from "@doota/mail-core/crypto";
import { threadSummariesByIds } from "@doota/mail-core/read";
import { seedMailboxWithThreads } from "./helpers/seed-threads";

let db: any, ck: any;
beforeEach(async () => {
  db = await makeDb();
  ck = await importKey(btoa("0123456789abcdef0123456789abcdef"));
});

describe("threadSummariesByIds", () => {
  it("returns summaries only for the requested, still-present threads", async () => {
    const { mailboxId, threadIds } = await seedMailboxWithThreads(db, ck, 3);
    const some = [threadIds[0], threadIds[2], "gone_id"];
    const out = await threadSummariesByIds(db, {
      mailboxId,
      threadIds: some,
      ck,
      userId: "u1",
      includeCollab: true,
      assignedTo: null,
    });
    expect(out.map((summary) => summary.threadId).sort()).toEqual(
      [threadIds[0], threadIds[2]].sort(),
    );
  });

  it("returns empty array when threadIds is empty", async () => {
    const { mailboxId } = await seedMailboxWithThreads(db, ck, 1);
    const out = await threadSummariesByIds(db, {
      mailboxId,
      threadIds: [],
      ck,
      userId: "u1",
      includeCollab: false,
      assignedTo: null,
    });
    expect(out).toEqual([]);
  });
});
