// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from "vitest";
import { createSync } from "$lib/client/localdb/sync.svelte";
import type { MessageDTO } from "@doota/mail-core/mail-thread-contract";

// ---------------------------------------------------------------------------
// Fake helpers
// ---------------------------------------------------------------------------

type MirroredMsg = MessageDTO & { seq: number; framedHtml: string | null };

function makeFakeMsg(id: string): MirroredMsg {
  return {
    type: "external_message",
    id,
    threadId: "t1",
    messageIdHeader: `<${id}@test>`,
    from: "alice@example.com",
    fromName: "Alice",
    to: [],
    cc: [],
    replyTo: null,
    sentAt: 1000,
    contentKind: "bubble",
    subject: "Test",
    bodyStripped: "Hello",
    bodyFull: null,
    htmlKind: null,
    hasRemoteImages: false,
    keywords: [],
    isRead: false,
    outbound: false,
    viaAlias: null,
    seq: 1,
    framedHtml: null,
  } as unknown as MirroredMsg;
}

const FAKE_MSG = makeFakeMsg("msg-1");

function makeLocalDbFake(
  initialSync: { cursor: number; renderVersion: string } | null = null,
) {
  let storedSync = initialSync;
  const seedCalls: { threadId: string; messages: MirroredMsg[]; cursor: number; renderVersion: string }[] = [];
  const applyDeltasCalls: {
    threadId: string;
    upserts: MessageDTO[];
    removals: string[];
    newCursor: number;
  }[] = [];

  return {
    // Mailbox stubs (not exercised in thread tests)
    async getCursor(_mailboxId: string) { return null; },
    async seed(_mailboxId: string, _rows: any[], _cursor: number) {},
    async applyDeltas(_mailboxId: string, _upserts: any[], _removals: string[], _newCursor: number) {},

    // Thread methods
    async getThreadSync(_threadId: string) {
      return storedSync;
    },
    async seedThreadMessages(
      threadId: string,
      messages: MirroredMsg[],
      cursor: number,
      renderVersion: string,
    ) {
      storedSync = { cursor, renderVersion };
      seedCalls.push({ threadId, messages, cursor, renderVersion });
    },
    async applyMessageDeltas(
      threadId: string,
      upserts: MessageDTO[],
      removals: string[],
      newCursor: number,
    ) {
      if (storedSync) storedSync = { ...storedSync, cursor: newCursor };
      applyDeltasCalls.push({ threadId, upserts, removals, newCursor });
    },

    // Inspection handles
    seedCalls,
    applyDeltasCalls,
    get storedSync() { return storedSync; },
  };
}

function makeSyncWithThreadDeps(
  localdb: ReturnType<typeof makeLocalDbFake>,
  seedThreadFn: any,
  threadChangesFn: any,
  renderVersion = "14",
) {
  return createSync({
    localdb: localdb as any,
    seedFn: vi.fn(async () => ({ rows: [], cursor: 0 })),
    changesFn: vi.fn(async () => ({ upserts: [], removals: [], newSeq: 0, cannotCalculate: false })),
    seedThreadFn,
    threadChangesFn,
    currentRenderVersion: () => renderVersion,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ensureThread", () => {
  it("no thread_synced → seeds (seedThreadFn + seedThreadMessages called), threadState live", async () => {
    const fakeDb = makeLocalDbFake(null);
    const seedThreadFn = vi.fn(async (_threadId: string) => ({
      messages: [FAKE_MSG],
      cursor: 42,
      renderVersion: "14",
    }));
    const threadChangesFn = vi.fn(async () => ({
      upserts: [],
      removals: [],
      newSeq: 43,
      cannotCalculate: false,
    }));

    const sync = makeSyncWithThreadDeps(fakeDb, seedThreadFn, threadChangesFn);
    await sync.ensureThread("t1");

    expect(seedThreadFn).toHaveBeenCalledOnce();
    expect(seedThreadFn).toHaveBeenCalledWith("t1");
    expect(fakeDb.seedCalls).toHaveLength(1);
    expect(fakeDb.seedCalls[0]).toMatchObject({
      threadId: "t1",
      messages: [FAKE_MSG],
      cursor: 42,
      renderVersion: "14",
    });
    expect(threadChangesFn).not.toHaveBeenCalled();
    expect(sync.threadState).toBe("live");
  });

  it("renderVersion mismatch → reseeds (seedThreadFn called, not just delta)", async () => {
    // Stored renderVersion "13" but currentRenderVersion is "14" → must reseed.
    const fakeDb = makeLocalDbFake({ cursor: 10, renderVersion: "13" });
    const seedThreadFn = vi.fn(async (_threadId: string) => ({
      messages: [FAKE_MSG],
      cursor: 99,
      renderVersion: "14",
    }));
    const threadChangesFn = vi.fn(async () => ({
      upserts: [],
      removals: [],
      newSeq: 100,
      cannotCalculate: false,
    }));

    const sync = makeSyncWithThreadDeps(fakeDb, seedThreadFn, threadChangesFn, "14");
    await sync.ensureThread("t1");

    expect(seedThreadFn).toHaveBeenCalledOnce();
    expect(threadChangesFn).not.toHaveBeenCalled();
    expect(fakeDb.seedCalls[0].renderVersion).toBe("14");
    expect(sync.threadState).toBe("live");
  });

  it("cursor present + version matches → delta resync (threadChangesFn + applyMessageDeltas)", async () => {
    const fakeDb = makeLocalDbFake({ cursor: 5, renderVersion: "14" });
    const seedThreadFn = vi.fn(async (_threadId: string) => ({
      messages: [],
      cursor: 0,
      renderVersion: "14",
    }));
    const threadChangesFn = vi.fn(async (_args: { threadId: string; sinceSeq: number }) => ({
      upserts: [FAKE_MSG],
      removals: ["old-msg"],
      newSeq: 20,
      cannotCalculate: false,
    }));

    const sync = makeSyncWithThreadDeps(fakeDb, seedThreadFn, threadChangesFn, "14");
    await sync.ensureThread("t1");

    expect(seedThreadFn).not.toHaveBeenCalled();
    expect(threadChangesFn).toHaveBeenCalledWith({ threadId: "t1", sinceSeq: 5 });
    expect(fakeDb.applyDeltasCalls).toHaveLength(1);
    expect(fakeDb.applyDeltasCalls[0]).toMatchObject({
      threadId: "t1",
      upserts: [FAKE_MSG],
      removals: ["old-msg"],
      newCursor: 20,
    });
    expect(sync.threadState).toBe("live");
  });
});

describe("onThreadRealtime", () => {
  it("in live state → threadChangesFn(cursor) + applyMessageDeltas called with upserts/removals/newSeq", async () => {
    // Start with a synced thread (cursor 10, current renderVersion)
    const fakeDb = makeLocalDbFake({ cursor: 10, renderVersion: "14" });
    const seedThreadFn = vi.fn(async () => ({ messages: [], cursor: 0, renderVersion: "14" }));
    const threadChangesFn = vi.fn(async (_args: { threadId: string; sinceSeq: number }) => ({
      upserts: [FAKE_MSG],
      removals: ["old"],
      newSeq: 20,
      cannotCalculate: false,
    }));

    const sync = makeSyncWithThreadDeps(fakeDb, seedThreadFn, threadChangesFn, "14");

    // Warm up via ensureThread (delta path: version matches)
    await sync.ensureThread("t1");
    expect(sync.threadState).toBe("live");

    // Simulate realtime push
    await sync.onThreadRealtime("t1");

    // Should have been called twice: once from ensureThread, once from onThreadRealtime
    expect(threadChangesFn).toHaveBeenCalledTimes(2);
    // Second call uses the updated cursor (20 from first delta)
    expect(threadChangesFn).toHaveBeenLastCalledWith({ threadId: "t1", sinceSeq: 20 });
    expect(fakeDb.applyDeltasCalls).toHaveLength(2);
    const lastDelta = fakeDb.applyDeltasCalls[1];
    expect(lastDelta).toMatchObject({
      threadId: "t1",
      upserts: [FAKE_MSG],
      removals: ["old"],
      newCursor: 20,
    });
    expect(sync.threadState).toBe("live");
  });
});

describe("onThreadRealtime before ensureThread (idle FSM)", () => {
  // Regression: threadFsm idle must accept RESYNC. If idle lacked RESYNC, runed
  // would silently drop the send and the FSM would stay idle after a successful
  // delta — threadState stuck "idle" instead of "live".
  it("realtime push before any open → delta runs, threadState reaches live", async () => {
    // Thread has a stored sync row (simulates: message arrived after login but user
    // never opened the thread; the row was created server-side or by a prior session)
    const fakeDb = makeLocalDbFake({ cursor: 3, renderVersion: "14" });
    const seedThreadFn = vi.fn(async () => ({ messages: [], cursor: 0, renderVersion: "14" }));
    const threadChangesFn = vi.fn(async (_args: { threadId: string; sinceSeq: number }) => ({
      upserts: [FAKE_MSG],
      removals: [],
      newSeq: 10,
      cannotCalculate: false,
    }));

    const sync = makeSyncWithThreadDeps(fakeDb, seedThreadFn, threadChangesFn, "14");
    // FSM is idle (ensureThread was never called)
    expect(sync.threadState).toBe("idle");

    await sync.onThreadRealtime("t1");

    // Delta path ran: threadChangesFn called, applyMessageDeltas called
    expect(threadChangesFn).toHaveBeenCalledWith({ threadId: "t1", sinceSeq: 3 });
    expect(fakeDb.applyDeltasCalls).toHaveLength(1);
    expect(fakeDb.applyDeltasCalls[0]).toMatchObject({
      threadId: "t1",
      upserts: [FAKE_MSG],
      removals: [],
      newCursor: 10,
    });
    // FSM must reach live (not stuck idle)
    expect(sync.threadState).toBe("live");
    // Seed must NOT have been called
    expect(seedThreadFn).not.toHaveBeenCalled();
  });
});

describe("cannotCalculate → reseed", () => {
  it("threadChangesFn cannotCalculate:true → seedThreadFn + seedThreadMessages called, threadState live", async () => {
    const fakeDb = makeLocalDbFake({ cursor: 5, renderVersion: "14" });
    const seedThreadFn = vi.fn(async (_threadId: string) => ({
      messages: [FAKE_MSG],
      cursor: 99,
      renderVersion: "14",
    }));
    const threadChangesFn = vi.fn(async () => ({
      upserts: [],
      removals: [],
      newSeq: 0,
      cannotCalculate: true,
    }));

    const sync = makeSyncWithThreadDeps(fakeDb, seedThreadFn, threadChangesFn, "14");
    await sync.ensureThread("t1");

    // Took the delta path but got cannotCalculate → should reseed
    expect(seedThreadFn).toHaveBeenCalledOnce();
    expect(fakeDb.seedCalls).toHaveLength(1);
    expect(fakeDb.seedCalls[0].cursor).toBe(99);
    expect(sync.threadState).toBe("live");
  });

  it("onThreadRealtime cannotCalculate:true → reseeds", async () => {
    const fakeDb = makeLocalDbFake({ cursor: 5, renderVersion: "14" });
    const seedThreadFn = vi.fn(async (_threadId: string) => ({
      messages: [FAKE_MSG],
      cursor: 77,
      renderVersion: "14",
    }));
    const threadChangesFn = vi.fn(async () => ({
      upserts: [],
      removals: [],
      newSeq: 0,
      cannotCalculate: true,
    }));

    const sync = makeSyncWithThreadDeps(fakeDb, seedThreadFn, threadChangesFn, "14");
    await sync.onThreadRealtime("t1");

    expect(seedThreadFn).toHaveBeenCalledOnce();
    expect(fakeDb.seedCalls[0].cursor).toBe(77);
    expect(sync.threadState).toBe("live");
  });
});
