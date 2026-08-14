// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from "vitest";
import { createSync } from "$lib/client/localdb/sync.svelte";
import type { TimelineItem } from "$lib/client/localdb/schema";

// ---------------------------------------------------------------------------
// Fake helpers
// ---------------------------------------------------------------------------

type MirroredItem = TimelineItem & { seq: number; framedHtml: string | null };

function makeFakeItem(id: string): MirroredItem {
  return {
    type: "external_message",
    id,
    threadId: "t1",
    seq: 1,
    framedHtml: null,
  };
}

const FAKE_ITEM = makeFakeItem("msg-1");

function makeLocalDbFake(
  initialSync: { cursor: number; renderVersion: string } | null = null,
) {
  let storedSync = initialSync;
  const seedCalls: { threadId: string; items: MirroredItem[]; cursor: number; renderVersion: string }[] = [];

  return {
    // Mailbox stubs (not exercised in thread tests)
    async getCursor(_mailboxId: string) { return null; },
    async seed(_mailboxId: string, _rows: any[], _cursor: number) {},
    async applyDeltas(_mailboxId: string, _upserts: any[], _removals: string[], _newCursor: number) {},

    // Thread methods
    async getThreadSync(_threadId: string) {
      return storedSync;
    },
    async seedThreadItems(
      threadId: string,
      items: MirroredItem[],
      cursor: number,
      renderVersion: string,
    ) {
      storedSync = { cursor, renderVersion };
      seedCalls.push({ threadId, items, cursor, renderVersion });
    },

    // Inspection handles
    seedCalls,
    get storedSync() { return storedSync; },
  };
}

function makeSyncWithThreadDeps(
  localdb: ReturnType<typeof makeLocalDbFake>,
  seedThreadFn: any,
  renderVersion = "14",
) {
  return createSync({
    localdb: localdb as any,
    seedFn: vi.fn(async () => ({ rows: [], cursor: 0 })),
    changesFn: vi.fn(async () => ({ upserts: [], removals: [], newSeq: 0, cannotCalculate: false })),
    seedThreadFn,
    currentRenderVersion: () => renderVersion,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ensureThread", () => {
  it("no thread_synced → seeds (seedThreadFn + seedThreadItems called), threadState live", async () => {
    const fakeDb = makeLocalDbFake(null);
    const seedThreadFn = vi.fn(async (_threadId: string) => ({
      items: [FAKE_ITEM],
      cursor: 42,
      renderVersion: "14",
    }));

    const sync = makeSyncWithThreadDeps(fakeDb, seedThreadFn);
    await sync.ensureThread("t1");

    expect(seedThreadFn).toHaveBeenCalledOnce();
    expect(seedThreadFn).toHaveBeenCalledWith("t1");
    expect(fakeDb.seedCalls).toHaveLength(1);
    expect(fakeDb.seedCalls[0]).toMatchObject({
      threadId: "t1",
      items: [FAKE_ITEM],
      cursor: 42,
      renderVersion: "14",
    });
    expect(sync.threadState).toBe("live");
  });

  it("renderVersion mismatch → reseeds (seedThreadFn called)", async () => {
    // Stored renderVersion "13" but currentRenderVersion is "14" → must reseed.
    const fakeDb = makeLocalDbFake({ cursor: 10, renderVersion: "13" });
    const seedThreadFn = vi.fn(async (_threadId: string) => ({
      items: [FAKE_ITEM],
      cursor: 99,
      renderVersion: "14",
    }));

    const sync = makeSyncWithThreadDeps(fakeDb, seedThreadFn, "14");
    await sync.ensureThread("t1");

    expect(seedThreadFn).toHaveBeenCalledOnce();
    expect(fakeDb.seedCalls[0].renderVersion).toBe("14");
    expect(sync.threadState).toBe("live");
  });

  it("thread present + version matches → revalidates (re-seeds — no delta path)", async () => {
    // Slice 3: even when already mirrored + version matches, we re-seed (revalidate-whole).
    // This catches notes/system events that have no incremental delta.
    const fakeDb = makeLocalDbFake({ cursor: 5, renderVersion: "14" });
    const seedThreadFn = vi.fn(async (_threadId: string) => ({
      items: [FAKE_ITEM],
      cursor: 10,
      renderVersion: "14",
    }));

    const sync = makeSyncWithThreadDeps(fakeDb, seedThreadFn, "14");
    await sync.ensureThread("t1");

    // seedThreadFn IS called (revalidate), no delta path at all
    expect(seedThreadFn).toHaveBeenCalledOnce();
    expect(fakeDb.seedCalls).toHaveLength(1);
    expect(fakeDb.seedCalls[0]).toMatchObject({ threadId: "t1", cursor: 10 });
    expect(sync.threadState).toBe("live");
  });
});

describe("onThreadRealtime", () => {
  it("realtime push → reseeds (seedThreadFn + seedThreadItems), threadState live", async () => {
    // Start mirrored and current.
    const fakeDb = makeLocalDbFake({ cursor: 10, renderVersion: "14" });
    const seedThreadFn = vi.fn(async (_threadId: string) => ({
      items: [FAKE_ITEM],
      cursor: 20,
      renderVersion: "14",
    }));

    const sync = makeSyncWithThreadDeps(fakeDb, seedThreadFn, "14");

    // Warm up (revalidate)
    await sync.ensureThread("t1");
    expect(sync.threadState).toBe("live");
    expect(seedThreadFn).toHaveBeenCalledOnce();

    // Simulate realtime push — should reseed again
    await sync.onThreadRealtime("t1");

    expect(seedThreadFn).toHaveBeenCalledTimes(2);
    expect(fakeDb.seedCalls).toHaveLength(2);
    expect(sync.threadState).toBe("live");
  });

  it("realtime push before ensureThread (idle FSM) → reseeds, threadState live", async () => {
    const fakeDb = makeLocalDbFake(null);
    const seedThreadFn = vi.fn(async (_threadId: string) => ({
      items: [FAKE_ITEM],
      cursor: 5,
      renderVersion: "14",
    }));

    const sync = makeSyncWithThreadDeps(fakeDb, seedThreadFn, "14");
    expect(sync.threadState).toBe("idle");

    await sync.onThreadRealtime("t1");

    expect(seedThreadFn).toHaveBeenCalledOnce();
    expect(fakeDb.seedCalls).toHaveLength(1);
    expect(sync.threadState).toBe("live");
  });

  it("pushes while a revalidation is in flight coalesce into ONE replay (delivered-tick case)", async () => {
    const fakeDb = makeLocalDbFake({ cursor: 10, renderVersion: "14" });
    let resolveFirstSeed!: () => void;
    const firstSeedGate = new Promise<void>((resolve) => {
      resolveFirstSeed = resolve;
    });
    let seedCallCount = 0;
    const seedThreadFn = vi.fn(async (_threadId: string) => {
      seedCallCount++;
      // Only the first fetch is slow — the replay resolves immediately.
      if (seedCallCount === 1) await firstSeedGate;
      return { items: [FAKE_ITEM], cursor: 10 + seedCallCount, renderVersion: "14" };
    });

    const sync = makeSyncWithThreadDeps(fakeDb, seedThreadFn, "14");

    // A send's ticks: "sent" starts a revalidation, "delivered" (and a
    // straggler) land while it's still in flight.
    const sentTick = sync.onThreadRealtime("t1");
    const deliveredTick = sync.onThreadRealtime("t1");
    const straggler = sync.onThreadRealtime("t1");

    resolveFirstSeed();
    await Promise.all([sentTick, deliveredTick, straggler]);

    // Exactly one replayed revalidation: a drop leaves it at 1 (delivered tick
    // never renders until reopen), a queue would run 3.
    expect(seedThreadFn).toHaveBeenCalledTimes(2);
    expect(fakeDb.storedSync?.cursor).toBe(12); // replay's data won
    expect(sync.threadState).toBe("live");
  });

  it("busy state is per-thread — a different thread's revalidation is not blocked or coalesced", async () => {
    const fakeDb = makeLocalDbFake({ cursor: 10, renderVersion: "14" });
    let resolveSlowSeed!: () => void;
    const slowSeedGate = new Promise<void>((resolve) => {
      resolveSlowSeed = resolve;
    });
    const seedThreadFn = vi.fn(async (threadId: string) => {
      if (threadId === "t-slow") await slowSeedGate;
      return { items: [FAKE_ITEM], cursor: 99, renderVersion: "14" };
    });

    const sync = makeSyncWithThreadDeps(fakeDb, seedThreadFn, "14");

    const slow = sync.onThreadRealtime("t-slow");
    await sync.onThreadRealtime("t-other"); // completes while t-slow is in flight
    resolveSlowSeed();
    await slow;

    // One call each — no cross-thread blocking, no spurious replay.
    expect(seedThreadFn).toHaveBeenCalledTimes(2);
    const calledWith = seedThreadFn.mock.calls.map((call) => call[0]);
    expect(calledWith.sort()).toEqual(["t-other", "t-slow"]);
  });
});
