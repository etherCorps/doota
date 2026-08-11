/// <reference lib="webworker" />
// SPDX-License-Identifier: Apache-2.0
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import {
  DDL,
  upsertThreadSql,
  deleteThreadSql,
  listThreadsSql,
  getCursorSql,
  setCursorSql,
  clearMailboxSql,
  threadSummaryToRow,
  rowToThreadSummary,
  upsertThreadItemSql,
  clearThreadItemsSql,
  listThreadItemsSql,
  itemToRow,
  rowToItem,
  getThreadSyncSql,
  setThreadSyncSql,
} from "./schema";
// ponytail: inline to avoid importing the server-only thread-localdb module
type MirroredItem = { itemId: string; seq: number; itemType: string; payload: unknown; framedHtml: string | null };
import { pickBackend } from "./persistence";
import type { Req, Res } from "./rpc";

let db: any = null;
let backend: Awaited<ReturnType<typeof pickBackend>> | null = null;

// ponytail: no multi-tab Web Lock — SAH-pool serializes handle access so
// concurrent tabs are unlikely to corrupt; add a Web Lock leader if two-tab
// writes ever conflict.
async function open(userId: string): Promise<void> {
  const sqlite3 = await sqlite3InitModule();
  backend = await pickBackend(sqlite3);
  db = await backend.openDb(`u_${userId}`);
  db.exec(DDL);
}

// Methods that skip the persist step: reads, open (snapshot just loaded), clear (db nulled).
const NO_PERSIST_METHODS = new Set(["list", "getCursor", "open", "listThreadItems", "getThreadSync"]);

const handlers: Record<string, (params: any) => unknown | Promise<unknown>> = {
  open: async ({ userId }: { userId: string }) => {
    await open(userId);
    return true;
  },

  seed: ({ mailboxId, rows, cursor }: { mailboxId: string; rows: any[]; cursor: number }) => {
    db.transaction(() => {
      db.exec({ sql: clearMailboxSql().sql, bind: { $mailbox_id: mailboxId } });
      for (const summary of rows) {
        db.exec({ sql: upsertThreadSql().sql, bind: threadSummaryToRow(mailboxId, summary) });
      }
      db.exec({ sql: setCursorSql().sql, bind: { $mailbox_id: mailboxId, $cursor: cursor } });
    });
    return true;
  },

  applyDeltas: ({
    mailboxId,
    upserts,
    removals,
    newCursor,
  }: {
    mailboxId: string;
    upserts: any[];
    removals: string[];
    newCursor: number;
  }) => {
    db.transaction(() => {
      for (const summary of upserts) {
        db.exec({ sql: upsertThreadSql().sql, bind: threadSummaryToRow(mailboxId, summary) });
      }
      for (const threadId of removals) {
        db.exec({ sql: deleteThreadSql().sql, bind: { $mailbox_id: mailboxId, $thread_id: threadId } });
      }
      db.exec({ sql: setCursorSql().sql, bind: { $mailbox_id: mailboxId, $cursor: newCursor } });
    });
    return true;
  },

  list: ({ mailboxId, placement }: { mailboxId: string; placement: string }) => {
    const resultRows: any[] = [];
    db.exec({ sql: listThreadsSql().sql, bind: { $mailbox_id: mailboxId, $placement: placement }, rowMode: "object", resultRows });
    return resultRows.map(rowToThreadSummary);
  },

  getCursor: ({ mailboxId }: { mailboxId: string }) => {
    const resultRows: any[] = [];
    db.exec({ sql: getCursorSql().sql, bind: { $mailbox_id: mailboxId }, rowMode: "object", resultRows });
    return resultRows[0]?.cursor ?? null;
  },

  seedThreadItems: ({
    threadId,
    items,
    cursor,
    renderVersion,
  }: {
    threadId: string;
    items: MirroredItem[];
    cursor: number;
    renderVersion: string;
  }) => {
    db.transaction(() => {
      db.exec({ sql: clearThreadItemsSql().sql, bind: { $thread_id: threadId } });
      for (const item of items) {
        db.exec({ sql: upsertThreadItemSql().sql, bind: itemToRow(threadId, item.seq, { id: item.itemId, type: item.itemType, ...(item.payload as object) }, item.framedHtml) });
      }
      db.exec({ sql: setThreadSyncSql().sql, bind: { $thread_id: threadId, $cursor: cursor, $render_version: renderVersion } });
    });
    return true;
  },

  listThreadItems: ({ threadId }: { threadId: string }) => {
    const resultRows: any[] = [];
    db.exec({ sql: listThreadItemsSql().sql, bind: { $thread_id: threadId }, rowMode: "object", resultRows });
    return resultRows.map(rowToItem);
  },

  getThreadSync: ({ threadId }: { threadId: string }) => {
    const resultRows: any[] = [];
    db.exec({ sql: getThreadSyncSql().sql, bind: { $thread_id: threadId }, rowMode: "object", resultRows });
    const row = resultRows[0];
    if (!row) return null;
    return { cursor: row.cursor as number, renderVersion: row.render_version as string };
  },

  clear: async ({ userId }: { userId: string }) => {
    db?.close?.();
    db = null;
    // Purge persisted data so no plaintext mirror survives the session.
    if (backend) {
      try { await backend.destroy(`u_${userId}`); } catch { /* non-fatal */ }
      backend = null;
    }
    return true;
  },
};

self.onmessage = async (ev: MessageEvent<Req>) => {
  const { id, method, params } = ev.data;
  try {
    const result = await handlers[method](params);
    if (backend?.kind === "idb" && !NO_PERSIST_METHODS.has(method) && method !== "clear") {
      await backend.persist(db);
    }
    (self as unknown as Worker).postMessage({ id, ok: true, result } satisfies Res);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: (err as Error).message } satisfies Res);
  }
};
