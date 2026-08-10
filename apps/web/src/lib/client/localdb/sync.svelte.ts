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

import { FiniteStateMachine } from "runed";
import type { ThreadSummary } from "@doota/mail-core/read";

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
};

export type SeedFn = (mailboxId: string) => Promise<{ rows: ThreadSummary[]; cursor: number }>;

export type ChangesFn = (args: {
  mailboxId: string;
  sinceSeq: number;
}) => Promise<{ upserts: ThreadSummary[]; removals: string[]; newSeq: number; cannotCalculate: boolean }>;

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
}) {
  const { localdb, seedFn, changesFn } = deps;

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
  };
}
