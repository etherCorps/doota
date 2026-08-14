// SPDX-License-Identifier: AGPL-3.0-or-later
// Sync engine for the local-first thread mirror.
//
// createSync() returns an object whose ensure()/onRealtime() methods drive a
// runed FiniteStateMachine through five states:
//
//   idle ──ensure──► seeding ──► live
//                               │
//   live ──onRealtime──► resyncing ──► live
//                                │
//                          cannotCalculate ──► seeding ──► live
//
// Any seedFn/changesFn error puts the machine in `error`; the next
// ensure()/onRealtime() call will retry from there.
//
// Thread-level sync (ensureThread / onThreadRealtime) uses a SEPARATE FSM
// from the mailbox FSM. Sharing one FSM across both flows would cause state
// contention: a mailbox resync would block thread navigation and vice-versa.
// ponytail: two FSMs, same state/event alphabet — simplest isolation.
//
// Slice 3: thread sync is revalidate-whole — no incremental delta path.
// Both ensureThread (present or absent) and onThreadRealtime re-fetch the full
// seedThreadFn result and replace all local thread_item rows via seedThreadItems.
// ponytail: re-seeding costs one R2+sanitize+frame pass per revalidation; upgrade
// to per-message delta (slice-2 path) when profiling shows this is a bottleneck.

import { FiniteStateMachine } from "runed";
import type { ThreadSummary } from "@doota/mail-core/read";
import type { TimelineItem } from "./schema";

// ---------------------------------------------------------------------------
// Injected-dependency types (mirrors the real localdb facade + remote fns)
// ---------------------------------------------------------------------------

export type SyncLocalDb = {
  getCursor(mailboxId: string): Promise<number | null>;
  seed(mailboxId: string, rows: ThreadSummary[], cursor: number): Promise<void>;
  applyDeltas(
    mailboxId: string,
    upserts: ThreadSummary[],
    removals: string[],
    newCursor: number,
  ): Promise<void>;
  // Thread timeline mirror methods (slice 3)
  getThreadSync(threadId: string): Promise<{ cursor: number; renderVersion: string } | null>;
  seedThreadItems(threadId: string, items: SeedThreadItem[], cursor: number, renderVersion: string): Promise<void>;
};

export type SeedFn = (mailboxId: string) => Promise<{ rows: ThreadSummary[]; cursor: number }>;

export type ChangesFn = (args: {
  mailboxId: string;
  sinceSeq: number;
}) => Promise<{ upserts: ThreadSummary[]; removals: string[]; newSeq: number; cannotCalculate: boolean }>;

/** Wire-shape of one thread timeline item as returned by the server seed endpoint. */
export type SeedThreadItem = { seq: number; payload: TimelineItem; framedHtml: string | null };

/** Slice-3 seedThread returns the full timeline (items = SeedThreadItem[] with seq + payload + framedHtml). */
export type SeedThreadFn = (threadId: string) => Promise<{
  items: SeedThreadItem[];
  cursor: number;
  renderVersion: string;
}>;

// ---------------------------------------------------------------------------
// FSM types
// ---------------------------------------------------------------------------

type SyncState = "idle" | "seeding" | "live" | "resyncing" | "error";
type SyncEvent = "SEED" | "RESYNC" | "DONE" | "ERROR";

// ---------------------------------------------------------------------------
// createSync
// ---------------------------------------------------------------------------

export function createSync(deps: {
  localdb: SyncLocalDb;
  seedFn: SeedFn;
  changesFn: ChangesFn;
  // Thread-level sync deps (optional; callers that don't need thread sync can omit)
  seedThreadFn?: SeedThreadFn;
  currentRenderVersion?: () => string;
}) {
  const { localdb, seedFn, changesFn } = deps;
  const seedThreadFn = deps.seedThreadFn;
  const currentRenderVersion = deps.currentRenderVersion ?? (() => "");

  const fsm = new FiniteStateMachine<SyncState, SyncEvent>("idle", {
    idle: { SEED: "seeding", RESYNC: "resyncing", ERROR: "error" },
    seeding: { DONE: "live", ERROR: "error" },
    live: { SEED: "seeding", RESYNC: "resyncing", ERROR: "error" },
    resyncing: { SEED: "seeding", DONE: "live", ERROR: "error" },
    error: { SEED: "seeding", RESYNC: "resyncing" },
  });

  // Pushes arriving while a sync is in flight coalesce into ONE replayed
  // resync after the in-flight op settles (dirty flag, not a queue). Without
  // the replay, a burst — send ticks, a reply landing mid-seed — whose
  // change_log row commits after the in-flight read simply never shows until
  // the next unrelated event, which for a quiet mailbox can be hours away.
  let pendingResyncMailboxId: string | null = null;

  function isBusy(): boolean {
    return fsm.current === "seeding" || fsm.current === "resyncing";
  }

  async function drainPendingResync(): Promise<void> {
    while (pendingResyncMailboxId !== null) {
      const mailboxToResync = pendingResyncMailboxId;
      pendingResyncMailboxId = null;
      await doResync(mailboxToResync);
    }
  }

  async function doSeed(mailboxId: string): Promise<void> {
    fsm.send("SEED");
    try {
      const { rows, cursor } = await seedFn(mailboxId);
      await localdb.seed(mailboxId, rows, cursor);
      fsm.send("DONE");
    } catch (_err) {
      fsm.send("ERROR");
    }
  }

  async function doResync(mailboxId: string): Promise<void> {
    fsm.send("RESYNC");
    try {
      const cursor = await localdb.getCursor(mailboxId);
      const result = await changesFn({ mailboxId, sinceSeq: cursor ?? 0 });
      if (result.cannotCalculate) {
        // changesFn says it can't diff — fall back to a full reseed
        const { rows, newCursor } = await (async () => {
          const freshSeed = await seedFn(mailboxId);
          return { rows: freshSeed.rows, newCursor: freshSeed.cursor };
        })();
        await localdb.seed(mailboxId, rows, newCursor);
        fsm.send("DONE");
      } else {
        await localdb.applyDeltas(mailboxId, result.upserts, result.removals, result.newSeq);
        fsm.send("DONE");
      }
    } catch (_err) {
      fsm.send("ERROR");
    }
  }

  // ---------------------------------------------------------------------------
  // Thread-level FSM (separate from mailbox FSM to avoid cross-flow contention)
  // ---------------------------------------------------------------------------

  const threadFsm = new FiniteStateMachine<SyncState, SyncEvent>("idle", {
    idle: { SEED: "seeding", RESYNC: "resyncing", ERROR: "error" },
    seeding: { DONE: "live", ERROR: "error" },
    live: { SEED: "seeding", RESYNC: "resyncing", ERROR: "error" },
    resyncing: { SEED: "seeding", DONE: "live", ERROR: "error" },
    error: { SEED: "seeding", RESYNC: "resyncing" },
  });

  // ponytail: per-threadId busy set so concurrent ensureThread/onThreadRealtime
  // calls for DIFFERENT threads don't block each other, while concurrent calls
  // for the SAME thread coalesce into one replayed revalidation (same
  // dirty-flag policy as mailbox). Without the replay a send's delivered tick
  // — which lands while the sent tick's revalidation is still in flight —
  // never renders until the thread is reopened.
  const busyThreadIds = new Set<string>();
  const dirtyThreadIds = new Set<string>();

  function isThreadBusy(threadId: string): boolean {
    return busyThreadIds.has(threadId);
  }

  /**
   * Fetch the full thread timeline and replace local rows.
   * Used by both ensureThread (absent + present) and onThreadRealtime.
   * ponytail: revalidate-whole — notes/system have no incremental delta;
   * upgrade to per-message delta when profiling warrants it.
   */
  async function revalidateThread(threadId: string): Promise<void> {
    if (!seedThreadFn) return;
    threadFsm.send("SEED");
    busyThreadIds.add(threadId);
    try {
      const seed = await seedThreadFn(threadId);
      await localdb.seedThreadItems(threadId, seed.items, seed.cursor, seed.renderVersion);
      threadFsm.send("DONE");
    } catch (_err) {
      threadFsm.send("ERROR");
    } finally {
      busyThreadIds.delete(threadId);
    }
    // A push landed for this thread while the revalidation above was in
    // flight — its data may postdate what we just fetched, so go again.
    if (dirtyThreadIds.delete(threadId)) await revalidateThread(threadId);
  }

  return {
    /**
     * Ensure the local mirror is initialised for mailboxId.
     * - No cursor → seed from scratch.
     * - Cursor present → catch-up resync.
     */
    async ensure(mailboxId: string): Promise<void> {
      if (isBusy()) {
        pendingResyncMailboxId = mailboxId;
        return;
      }
      const cursor = await localdb.getCursor(mailboxId);
      if (cursor === null) {
        await doSeed(mailboxId);
      } else {
        await doResync(mailboxId);
      }
      await drainPendingResync();
    },

    /**
     * Called when a realtime push arrives — pulls the delta and applies it.
     * If a sync is already in flight the push coalesces into one replayed
     * resync after it settles (see the dirty-flag comment above).
     */
    async onRealtime(mailboxId: string): Promise<void> {
      if (isBusy()) {
        pendingResyncMailboxId = mailboxId;
        return;
      }
      await doResync(mailboxId);
      await drainPendingResync();
    },

    /** Current FSM state — reactive ($state-backed via runed). */
    get state(): SyncState {
      return fsm.current;
    },

    /**
     * Ensure the thread timeline mirror is initialised for threadId.
     * Slice 3: always revalidates (re-seeds the whole thread) regardless of
     * whether a sync row exists, because notes/system events have no incremental
     * delta path. renderVersion drift also triggers revalidation (same action).
     */
    async ensureThread(threadId: string): Promise<void> {
      if (isThreadBusy(threadId)) {
        dirtyThreadIds.add(threadId);
        return;
      }
      // ponytail: absent + present + version-drifted all take the same revalidate-whole
      // action (slice 3 has no incremental delta); drop the getThreadSync read.
      await revalidateThread(threadId);
    },

    /**
     * Called when a realtime push arrives for a thread — revalidates (re-seeds)
     * the full thread timeline. If one is already in flight for this thread the
     * push coalesces into one replayed revalidation after it settles.
     */
    async onThreadRealtime(threadId: string): Promise<void> {
      if (isThreadBusy(threadId)) {
        dirtyThreadIds.add(threadId);
        return;
      }
      await revalidateThread(threadId);
    },

    /** Current thread FSM state — reactive ($state-backed via runed). */
    get threadState(): SyncState {
      return threadFsm.current;
    },
  };
}
