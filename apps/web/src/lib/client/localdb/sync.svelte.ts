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
//   idle ──ensureThread──► seeding ──► live
//   live ──onThreadRealtime──► resyncing ──► live
//                                      │
//                               cannotCalculate ──► seeding ──► live

import { FiniteStateMachine } from "runed";
import type { ThreadSummary } from "@doota/mail-core/read";
import type { MessageDTO } from "@doota/mail-core/mail-thread-contract";

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
  // Thread-message mirror methods
  getThreadSync(threadId: string): Promise<{ cursor: number; renderVersion: string } | null>;
  seedThreadMessages(threadId: string, messages: MessageDTO[], cursor: number, renderVersion: string): Promise<void>;
  applyMessageDeltas(threadId: string, upserts: MessageDTO[], removals: string[], newCursor: number): Promise<void>;
};

export type SeedFn = (mailboxId: string) => Promise<{ rows: ThreadSummary[]; cursor: number }>;

export type ChangesFn = (args: {
  mailboxId: string;
  sinceSeq: number;
}) => Promise<{ upserts: ThreadSummary[]; removals: string[]; newSeq: number; cannotCalculate: boolean }>;

// MirroredMessage is what the seed/delta RPCs return (MessageDTO + seq + framedHtml)
type MirroredMessage = MessageDTO & { seq: number; framedHtml: string | null };

export type SeedThreadFn = (threadId: string) => Promise<{
  messages: MirroredMessage[];
  cursor: number;
  renderVersion: string;
}>;

export type ThreadChangesFn = (args: {
  threadId: string;
  sinceSeq: number;
}) => Promise<{
  upserts: MirroredMessage[];
  removals: string[];
  newSeq: number;
  cannotCalculate: boolean;
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
  threadChangesFn?: ThreadChangesFn;
  currentRenderVersion?: () => string;
}) {
  const { localdb, seedFn, changesFn } = deps;
  const seedThreadFn = deps.seedThreadFn;
  const threadChangesFn = deps.threadChangesFn;
  const currentRenderVersion = deps.currentRenderVersion ?? (() => "");

  const fsm = new FiniteStateMachine<SyncState, SyncEvent>("idle", {
    idle: { SEED: "seeding", RESYNC: "resyncing", ERROR: "error" },
    seeding: { DONE: "live", ERROR: "error" },
    live: { SEED: "seeding", RESYNC: "resyncing", ERROR: "error" },
    resyncing: { SEED: "seeding", DONE: "live", ERROR: "error" },
    error: { SEED: "seeding", RESYNC: "resyncing" },
  });

  // ponytail: plain busy-ignore for onRealtime — concurrent pushes while a sync
  // is in-flight are dropped. The next realtime push or ensure() will catch up.
  // A dirty-flag re-check would handle the case where the in-flight op takes
  // so long that no further push arrives, but in practice realtime push rates
  // are high enough that a subsequent event always arrives. Upgrade to a
  // dirty-flag or queue if telemetry shows missed-event gaps.

  function isBusy(): boolean {
    return fsm.current === "seeding" || fsm.current === "resyncing";
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
  // for the SAME thread are deduplicated (same drop-on-busy policy as mailbox).
  const busyThreadIds = new Set<string>();

  function isThreadBusy(threadId: string): boolean {
    return busyThreadIds.has(threadId);
  }

  async function doSeedThread(threadId: string): Promise<void> {
    if (!seedThreadFn) return;
    threadFsm.send("SEED");
    busyThreadIds.add(threadId);
    try {
      const seed = await seedThreadFn(threadId);
      await localdb.seedThreadMessages(threadId, seed.messages, seed.cursor, seed.renderVersion);
      threadFsm.send("DONE");
    } catch (_err) {
      threadFsm.send("ERROR");
    } finally {
      busyThreadIds.delete(threadId);
    }
  }

  async function doResyncThread(threadId: string, sinceSeq: number): Promise<void> {
    if (!threadChangesFn) return;
    threadFsm.send("RESYNC");
    busyThreadIds.add(threadId);
    try {
      const result = await threadChangesFn({ threadId, sinceSeq });
      if (result.cannotCalculate) {
        // Fall back to full reseed — transitions through SEED within RESYNC branch
        if (!seedThreadFn) { threadFsm.send("DONE"); return; }
        threadFsm.send("SEED");
        const seed = await seedThreadFn(threadId);
        await localdb.seedThreadMessages(threadId, seed.messages, seed.cursor, seed.renderVersion);
        threadFsm.send("DONE");
      } else {
        await localdb.applyMessageDeltas(threadId, result.upserts, result.removals, result.newSeq);
        threadFsm.send("DONE");
      }
    } catch (_err) {
      threadFsm.send("ERROR");
    } finally {
      busyThreadIds.delete(threadId);
    }
  }

  return {
    /**
     * Ensure the local mirror is initialised for mailboxId.
     * - No cursor → seed from scratch.
     * - Cursor present → catch-up resync.
     */
    async ensure(mailboxId: string): Promise<void> {
      if (isBusy()) return;
      const cursor = await localdb.getCursor(mailboxId);
      if (cursor === null) {
        await doSeed(mailboxId);
      } else {
        await doResync(mailboxId);
      }
    },

    /**
     * Called when a realtime push arrives — pulls the delta and applies it.
     * Silently ignored if a sync is already in flight (see ponytail comment above).
     */
    async onRealtime(mailboxId: string): Promise<void> {
      if (isBusy()) return;
      await doResync(mailboxId);
    },

    /** Current FSM state — reactive ($state-backed via runed). */
    get state(): SyncState {
      return fsm.current;
    },

    /**
     * Ensure the thread message mirror is initialised for threadId.
     * - No thread_synced row → seed.
     * - renderVersion mismatch → reseed (render cache changed, stale HTML).
     * - cursor present + version matches → delta resync.
     */
    async ensureThread(threadId: string): Promise<void> {
      if (isThreadBusy(threadId)) return;
      const sync = await localdb.getThreadSync(threadId);
      if (sync === null || sync.renderVersion !== currentRenderVersion()) {
        await doSeedThread(threadId);
      } else {
        await doResyncThread(threadId, sync.cursor);
      }
    },

    /**
     * Called when a realtime push arrives for a thread — pulls the delta and
     * applies it. Silently ignored if a sync is already in flight for this thread.
     */
    async onThreadRealtime(threadId: string): Promise<void> {
      if (isThreadBusy(threadId)) return;
      const sync = await localdb.getThreadSync(threadId);
      await doResyncThread(threadId, sync?.cursor ?? 0);
    },

    /** Current thread FSM state — reactive ($state-backed via runed). */
    get threadState(): SyncState {
      return threadFsm.current;
    },
  };
}
