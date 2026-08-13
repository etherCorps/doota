// SPDX-License-Identifier: AGPL-3.0-or-later
// Local-first thread-mirror facade. Wraps the worker bridge with typed async
// methods and a reactive liveThreadList / liveThread that re-queries whenever
// a write (seed/applyDeltas / seedThreadItems) bumps that mailbox's or thread's
// version counter.
//
// .svelte.ts so $state runes compile — current fields are $state-backed,
// meaning Svelte templates that read them will auto-re-render on seed writes.

import type { ThreadSummary } from "@doota/mail-core/read";
import type { TimelineItem } from "./schema";
import type { SeedThreadItem } from "./sync.svelte";
import { watch } from "runed";
import { createBridge } from "./rpc";

export type Bridge = { call<T>(method: string, params: unknown): Promise<T> };

// Re-export so callers don't need to import schema separately.
export type { TimelineItem };

/** A live thread list handle returned by liveThreadList. */
export type LiveThreadList = {
  /** The most recently fetched list for (mailboxId, folder). $state-backed. */
  readonly current: ThreadSummary[];
  /** Release the watcher registration — call when the consumer unmounts. */
  destroy(): void;
};

/** A live timeline handle returned by liveThread (slice 3: full ordered timeline). */
export type LiveThreadItem = TimelineItem;

export type LiveThread = {
  /** The most recently fetched full timeline for a thread. $state-backed. */
  readonly current: LiveThreadItem[];
  /** Release the watcher registration — call when the consumer unmounts. */
  destroy(): void;
};

type Watcher = {
  readonly mailboxId: string;
  refresh(): Promise<void>;
};

type ThreadWatcher = {
  readonly threadId: string;
  refresh(): Promise<void>;
};

export function makeLocalDb(bridge: Bridge) {
  // ponytail: plain Set tracks watchers; no pub/sub lib needed.
  const watchers = new Set<Watcher>();
  const threadWatchers = new Set<ThreadWatcher>();

  async function notifyWatchers(mailboxId: string): Promise<void> {
    const matchingWatchers = [...watchers].filter((watcher) => watcher.mailboxId === mailboxId);
    await Promise.all(matchingWatchers.map((watcher) => watcher.refresh()));
  }

  async function notifyThreadWatchers(threadId: string): Promise<void> {
    const matchingWatchers = [...threadWatchers].filter((watcher) => watcher.threadId === threadId);
    await Promise.all(matchingWatchers.map((watcher) => watcher.refresh()));
  }

  // Re-read every live handle from the store. Each handle's construction-time
  // refresh runs before open() resolves (empty DB → empty result), and offline
  // no network seed fires to trigger a re-read — so without this a cold offline
  // boot shows nothing. open() calls this once the DB is readable.
  async function refreshAllWatchers(): Promise<void> {
    await Promise.all([
      ...[...watchers].map((watcher) => watcher.refresh().catch(() => {})),
      ...[...threadWatchers].map((watcher) => watcher.refresh().catch(() => {})),
    ]);
  }

  const facade = {
    async open(userId: string): Promise<void> {
      await bridge.call<void>("open", { userId });
      // DB is readable now — do the initial read for every live handle so a cold
      // offline boot renders straight from the mirror (no network seed needed).
      await refreshAllWatchers();
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

    /** Optimistic quick-action patch: upsert/remove rows without moving the
     * sync cursor (the next real delta reconciles server truth), then refresh
     * the list watchers so the mirror-driven render reacts instantly. */
    async patchThreads(mailboxId: string, rows: ThreadSummary[], removals: string[] = []): Promise<void> {
      await bridge.call<void>("patchThreads", { mailboxId, rows, removals });
      await notifyWatchers(mailboxId);
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
      // ponytail: $state in .svelte.ts so Svelte templates auto-track reads.
      let current = $state<ThreadSummary[]>([]);

      const watcher: Watcher = {
        get mailboxId() {
          return getMailboxId();
        },
        async refresh() {
          const freshRows = await facade.list(getMailboxId(), getFolder());
          current = freshRows; // $state write — triggers component re-render
        },
      };

      const handle: LiveThreadList = {
        get current() { return current; },
        destroy() {
          watchers.delete(watcher);
        },
      };

      watchers.add(watcher);
      // Re-read on every mailbox/folder change — and once immediately for the
      // initial load (watch is eager). Blank `current` first so the switch shows
      // a skeleton, not the previous folder's rows (which linger — with pinned
      // threads prominently on top — until the re-read lands). This watch fires
      // ONLY on a mailbox/folder switch, where the caller also clears the remote
      // `items`, so emptying here can't flip the visible source to stale remote
      // content; realtime refreshes go through notifyWatchers (no blank), so
      // in-place updates never flash. The DB may not be open yet (open() is
      // async) — swallow that rejection; open() re-reads once it is.
      watch([getMailboxId, getFolder], () => {
        current = [];
        void watcher.refresh().catch(() => {});
      });

      return handle;
    },

    // ---- Thread timeline mirror methods (slice 3) --------------------------------

    /**
     * Replace all thread_item rows + set thread_synced.
     * Notifies all liveThread watchers for threadId.
     */
    seedThreadItems(
      threadId: string,
      items: SeedThreadItem[],
      cursor: number,
      renderVersion: string,
    ): Promise<void> {
      return bridge
        .call<void>("seedThreadItems", { threadId, items, cursor, renderVersion })
        .then(() => notifyThreadWatchers(threadId));
    },

    getThreadSync(threadId: string): Promise<{ cursor: number; renderVersion: string } | null> {
      return bridge.call<{ cursor: number; renderVersion: string } | null>("getThreadSync", {
        threadId,
      });
    },

    listThreadItems(threadId: string): Promise<LiveThreadItem[]> {
      return bridge.call<LiveThreadItem[]>("listThreadItems", { threadId });
    },

    /**
     * Returns a live handle whose `current` is the full ordered timeline for
     * the thread (message items carry framedHtml). Refreshed after every
     * seedThreadItems for the matching thread.
     *
     * @param getThreadId - getter so callers can pass reactive values
     */
    liveThread(getThreadId: () => string): LiveThread {
      // ponytail: $state in .svelte.ts so Svelte templates auto-track reads.
      let current = $state<LiveThreadItem[]>([]);

      const watcher: ThreadWatcher = {
        get threadId() {
          return getThreadId();
        },
        async refresh() {
          const freshItems = await facade.listThreadItems(getThreadId());
          current = freshItems; // $state write — triggers component re-render
        },
      };

      const handle: LiveThread = {
        get current() { return current; },
        destroy() {
          threadWatchers.delete(watcher);
        },
      };

      threadWatchers.add(watcher);
      // Re-read on every threadId change (a thread switch) — and once immediately
      // for the initial load (watch is eager by default). Without this `current`
      // lingers on the previous thread's items until the next seed notification
      // lands (a network round-trip later), so the pane shows the OLD mail for
      // seconds after switching. Drop the stale items first (empty → skeleton,
      // not wrong mail), then read the new thread from the store (instant if
      // already mirrored).
      watch(getThreadId, () => {
        current = [];
        void watcher.refresh().catch(() => {});
      });

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
