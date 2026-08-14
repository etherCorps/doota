// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from "vitest";
import { createSync } from "$lib/client/localdb/sync.svelte";
import type { ThreadSummary } from "@doota/mail-core/read";

// ---------------------------------------------------------------------------
// Fake helpers
// ---------------------------------------------------------------------------

function makeLocalDbFake(initialCursor: number | null = null) {
  let storedCursor = initialCursor;
  const seedCalls: { mailboxId: string; rows: ThreadSummary[]; cursor: number }[] = [];
  const applyDeltasCalls: {
    mailboxId: string;
    upserts: ThreadSummary[];
    removals: string[];
    newCursor: number;
  }[] = [];

  return {
    async getCursor(_mailboxId: string): Promise<number | null> {
      return storedCursor;
    },
    async seed(mailboxId: string, rows: ThreadSummary[], cursor: number): Promise<void> {
      storedCursor = cursor;
      seedCalls.push({ mailboxId, rows, cursor });
    },
    async applyDeltas(
      mailboxId: string,
      upserts: ThreadSummary[],
      removals: string[],
      newCursor: number,
    ): Promise<void> {
      storedCursor = newCursor;
      applyDeltasCalls.push({ mailboxId, upserts, removals, newCursor });
    },
    // Inspection handles
    seedCalls,
    applyDeltasCalls,
    get storedCursor() {
      return storedCursor;
    },
  };
}

const FAKE_THREAD: ThreadSummary = {
  threadId: "t1",
  subject: "Hello",
  snippet: null,
  from: null,
  fromName: null,
  participants: [],
  participantCount: 1,
  lastMessageAt: null,
  isStarred: false,
  unread: false,
  hasNotes: false,
  assigneeUserId: null,
  placement: "inbox",
  pinnedAt: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSync", () => {
  it("ensure() on empty store seeds then reaches 'live'", async () => {
    const fakeDb = makeLocalDbFake(null);
    const seedFn = vi.fn(async (_mailboxId: string) => ({
      rows: [FAKE_THREAD],
      cursor: 42,
    }));
    const changesFn = vi.fn(async () => ({
      upserts: [],
      removals: [],
      newSeq: 43,
      cannotCalculate: false,
    }));

    const sync = createSync({ localdb: fakeDb as any, seedFn, changesFn });
    await sync.ensure("mb_test");

    expect(seedFn).toHaveBeenCalledOnce();
    expect(fakeDb.seedCalls).toHaveLength(1);
    expect(fakeDb.seedCalls[0]).toMatchObject({
      mailboxId: "mb_test",
      rows: [FAKE_THREAD],
      cursor: 42,
    });
    expect(changesFn).not.toHaveBeenCalled();
    expect(sync.state).toBe("live");
  });

  it("onRealtime() in 'live' calls changesFn with stored cursor and applyDeltas", async () => {
    const fakeDb = makeLocalDbFake(10); // cursor already present
    const seedFn = vi.fn(async (_mailboxId: string) => ({ rows: [], cursor: 10 }));
    const changesFn = vi.fn(async (_args: { mailboxId: string; sinceSeq: number }) => ({
      upserts: [FAKE_THREAD],
      removals: ["old_thread"],
      newSeq: 20,
      cannotCalculate: false,
    }));

    const sync = createSync({ localdb: fakeDb as any, seedFn, changesFn });
    // Warm up to live state via ensure (cursor present → resyncing → live)
    await sync.ensure("mb_test");
    // Confirm we're live (ensure with a cursor does a catch-up → live)
    expect(sync.state).toBe("live");

    // Now simulate a realtime push
    await sync.onRealtime("mb_test");

    expect(changesFn).toHaveBeenCalledWith({ mailboxId: "mb_test", sinceSeq: 20 });
    expect(fakeDb.applyDeltasCalls).toHaveLength(2); // one from ensure's catch-up + one from onRealtime
    const lastCall = fakeDb.applyDeltasCalls[fakeDb.applyDeltasCalls.length - 1];
    expect(lastCall).toMatchObject({
      mailboxId: "mb_test",
      upserts: [FAKE_THREAD],
      removals: ["old_thread"],
      newCursor: 20,
    });
    expect(sync.state).toBe("live");
  });

  it("changesFn cannotCalculate:true → reseeds (seedFn + localdb.seed), state 'live'", async () => {
    const fakeDb = makeLocalDbFake(5);
    const seedFn = vi.fn(async (_mailboxId: string) => ({
      rows: [FAKE_THREAD],
      cursor: 99,
    }));
    const changesFn = vi.fn(async (_args: { mailboxId: string; sinceSeq: number }) => ({
      upserts: [],
      removals: [],
      newSeq: 0,
      cannotCalculate: true,
    }));

    const sync = createSync({ localdb: fakeDb as any, seedFn, changesFn });
    // Put into live state — ensure with cursor does a changesFn (cannotCalculate) → reseed
    await sync.ensure("mb_test");

    expect(seedFn).toHaveBeenCalledOnce();
    expect(fakeDb.seedCalls).toHaveLength(1);
    expect(fakeDb.seedCalls[0].cursor).toBe(99);
    expect(sync.state).toBe("live");
  });

  it("error in seedFn → state 'error'", async () => {
    const fakeDb = makeLocalDbFake(null);
    const seedFn = vi.fn(async () => {
      throw new Error("network down");
    });
    const changesFn = vi.fn();

    const sync = createSync({ localdb: fakeDb as any, seedFn, changesFn });
    await sync.ensure("mb_test");

    expect(sync.state).toBe("error");
  });

  it("pushes while busy coalesce into ONE replayed resync (not dropped, not one-per-push)", async () => {
    const fakeDb = makeLocalDbFake(null);
    let resolveChanges!: () => void;
    const slowChanges = new Promise<void>((resolve) => {
      resolveChanges = resolve;
    });

    const seedFn = vi.fn(async (_mailboxId: string) => ({ rows: [], cursor: 1 }));
    let changesFnCallCount = 0;
    const changesFn = vi.fn(async (_args: { mailboxId: string; sinceSeq: number }) => {
      changesFnCallCount++;
      // Only the first call is slow — the replay resolves immediately.
      if (changesFnCallCount === 1) await slowChanges;
      return { upserts: [], removals: [], newSeq: changesFnCallCount + 1, cannotCalculate: false };
    });

    const sync = createSync({ localdb: fakeDb as any, seedFn, changesFn });
    // Seed first
    await sync.ensure("mb_test");
    expect(sync.state).toBe("live");

    // Three concurrent pushes: the first runs, the other two land while busy.
    const first = sync.onRealtime("mb_test");
    const second = sync.onRealtime("mb_test");
    const third = sync.onRealtime("mb_test");

    resolveChanges();
    await Promise.all([first, second, third]);

    // The two while-busy pushes coalesce into exactly one replayed resync:
    // a drop would leave the count at 1, a queue would push it to 3.
    expect(changesFnCallCount).toBe(2);
    expect(sync.state).toBe("live");
  });
});
