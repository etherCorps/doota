// SPDX-License-Identifier: AGPL-3.0-or-later
// Local-first thread-mirror facade. Wraps the worker bridge with typed async
// methods and a reactive liveThreadList that re-queries whenever a write
// (seed/applyDeltas) bumps that mailbox's version counter.
//
// Reactivity note: liveThreadList.current is a plain mutable field refreshed
// after every seed/applyDeltas for its mailbox. In a .svelte component, bind
// it to a $state variable and call live.destroy() on cleanup.
// ponytail: plain observer pattern; upgrade to $state in .svelte.ts if
//           components need auto-tracking without explicit refresh wiring.

import type { ThreadSummary } from "@doota/mail-core/read";
import { createBridge } from "./rpc";

export type Bridge = { call<T>(method: string, params: unknown): Promise<T> };

/** A live thread list handle returned by liveThreadList. */
export type LiveThreadList = {
  /** The most recently fetched list for (mailboxId, folder). */
  current: ThreadSummary[];
  /** Release the watcher registration — call when the consumer unmounts. */
  destroy(): void;
};

type Watcher = {
  readonly mailboxId: string;
  refresh(): Promise<void>;
};

export function makeLocalDb(bridge: Bridge) {
  // ponytail: plain Set tracks watchers; no pub/sub lib needed.
  const watchers = new Set<Watcher>();

  async function notifyWatchers(mailboxId: string): Promise<void> {
    const matchingWatchers = [...watchers].filter((watcher) => watcher.mailboxId === mailboxId);
    await Promise.all(matchingWatchers.map((watcher) => watcher.refresh()));
  }

  const facade = {
    open(userId: string): Promise<void> {
      return bridge.call<void>("open", { userId });
    },

    async seed(mailboxId: string, rows: ThreadSummary[], cursor: number): Promise<void> {
      await bridge.call<void>("seed", { mailboxId, rows, cursor });
      await notifyWatchers(mailboxId);
    },

    async applyDeltas(
      mailboxId: string,
      upserts: ThreadSummary[],
      removals: string[],
      newCursor: number,
    ): Promise<void> {
      await bridge.call<void>("applyDeltas", { mailboxId, upserts, removals, newCursor });
      await notifyWatchers(mailboxId);
    },

    getCursor(mailboxId: string): Promise<number | null> {
      return bridge.call<number | null>("getCursor", { mailboxId });
    },

    clear(userId: string): Promise<void> {
      return bridge.call<void>("clear", { userId });
    },

    list(mailboxId: string, placement: string): Promise<ThreadSummary[]> {
      return bridge.call<ThreadSummary[]>("list", { mailboxId, placement });
    },

    /**
     * Returns a live handle whose `current` is refreshed after every
     * seed/applyDeltas for the matching mailbox.
     *
     * @param getMailboxId - getter so callers can pass reactive values
     * @param getFolder    - getter for the placement/folder name
     */
    liveThreadList(
      getMailboxId: () => string,
      getFolder: () => string,
    ): LiveThreadList {
      const handle: LiveThreadList = {
        current: [],
        destroy() {
          watchers.delete(watcher);
        },
      };

      const watcher: Watcher = {
        get mailboxId() {
          return getMailboxId();
        },
        async refresh() {
          const freshRows = await facade.list(getMailboxId(), getFolder());
          handle.current = freshRows;
        },
      };

      watchers.add(watcher);
      // Kick off the initial load without blocking the caller.
      void watcher.refresh();

      return handle;
    },
  };

  return facade;
}

export type LocalDb = ReturnType<typeof makeLocalDb>;

// Singleton — lazily initialises the real Worker in browser environments.
// ponytail: lazy IIFE avoids Worker construction during SSR or Node imports.
export const localdb: LocalDb = (() => {
  if (typeof Worker === "undefined") {
    // SSR / Node — no-op bridge so module imports don't crash.
    const noopBridge: Bridge = { call: async () => undefined as any };
    return makeLocalDb(noopBridge);
  }
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const bridge = createBridge(worker);
  return makeLocalDb(bridge);
})();
