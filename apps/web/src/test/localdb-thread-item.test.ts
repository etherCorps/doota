// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import {
  DDL,
  upsertThreadItemSql,
  deleteThreadItemSql,
  listThreadItemsSql,
  clearThreadItemsSql,
  getThreadSyncSql,
  setThreadSyncSql,
  itemToRow,
  rowToItem,
} from "$lib/client/localdb/schema";

let db: any;
beforeEach(async () => {
  const sqlite3 = await sqlite3InitModule();
  db = new sqlite3.oo1.DB(":memory:", "c");
  db.exec(DDL);
});

describe("localdb thread_item schema", () => {
  it("upserts 3 items and lists them ordered by seq", () => {
    const msgItem = { type: "external_message", id: "m1", bodyStripped: "hi" };
    const noteItem = { type: "internal_note", id: "n1", text: "note" };
    const sysItem = { type: "system_event", id: "e1", kind: "assigned" };

    db.exec({ sql: upsertThreadItemSql().sql, bind: itemToRow("t1", 0, msgItem, "<!doctype html>...") });
    db.exec({ sql: upsertThreadItemSql().sql, bind: itemToRow("t1", 1, noteItem, null) });
    db.exec({ sql: upsertThreadItemSql().sql, bind: itemToRow("t1", 2, sysItem, null) });

    const out: any[] = [];
    db.exec({ sql: listThreadItemsSql().sql, bind: { $thread_id: "t1" }, rowMode: "object", resultRows: out });
    expect(out.length).toBe(3);
    expect(out[0].item_id).toBe("m1");
    expect(out[1].item_id).toBe("n1");
    expect(out[2].item_id).toBe("e1");
  });

  it("rowToItem round-trips type, id, payload field, and framedHtml for message; no framedHtml for note/system", () => {
    const msgItem = { type: "external_message", id: "m1", bodyStripped: "hi" };
    const noteItem = { type: "internal_note", id: "n1", text: "note" };
    const sysItem = { type: "system_event", id: "e1", kind: "assigned" };

    db.exec({ sql: upsertThreadItemSql().sql, bind: itemToRow("t1", 0, msgItem, "<!doctype html>...") });
    db.exec({ sql: upsertThreadItemSql().sql, bind: itemToRow("t1", 1, noteItem, null) });
    db.exec({ sql: upsertThreadItemSql().sql, bind: itemToRow("t1", 2, sysItem, null) });

    const rows: any[] = [];
    db.exec({ sql: listThreadItemsSql().sql, bind: { $thread_id: "t1" }, rowMode: "object", resultRows: rows });

    const msg = rowToItem(rows[0]);
    expect(msg.type).toBe("external_message");
    expect(msg.id).toBe("m1");
    expect(msg.bodyStripped).toBe("hi");
    expect(msg.framedHtml).toBe("<!doctype html>...");

    const note = rowToItem(rows[1]);
    expect(note.type).toBe("internal_note");
    expect(note.id).toBe("n1");
    expect(note.text).toBe("note");
    expect(note.framedHtml).toBeUndefined();

    const sys = rowToItem(rows[2]);
    expect(sys.type).toBe("system_event");
    expect(sys.id).toBe("e1");
    expect(sys.kind).toBe("assigned");
    expect(sys.framedHtml).toBeUndefined();
  });

  it("upsert-replace updates in place (same thread_id, item_id)", () => {
    const item = { type: "external_message", id: "m1", bodyStripped: "original" };
    db.exec({ sql: upsertThreadItemSql().sql, bind: itemToRow("t1", 0, item, null) });
    db.exec({ sql: upsertThreadItemSql().sql, bind: itemToRow("t1", 0, { ...item, bodyStripped: "updated" }, "<html>v2</html>") });

    const out: any[] = [];
    db.exec({ sql: listThreadItemsSql().sql, bind: { $thread_id: "t1" }, rowMode: "object", resultRows: out });
    expect(out.length).toBe(1);
    const rebuilt = rowToItem(out[0]);
    expect(rebuilt.bodyStripped).toBe("updated");
    expect(rebuilt.framedHtml).toBe("<html>v2</html>");
  });

  it("deleteThreadItemSql removes one item", () => {
    db.exec({ sql: upsertThreadItemSql().sql, bind: itemToRow("t1", 0, { type: "external_message", id: "m1" }, null) });
    db.exec({ sql: upsertThreadItemSql().sql, bind: itemToRow("t1", 1, { type: "internal_note", id: "n1" }, null) });
    db.exec({ sql: deleteThreadItemSql().sql, bind: { $thread_id: "t1", $item_id: "m1" } });

    const out: any[] = [];
    db.exec({ sql: listThreadItemsSql().sql, bind: { $thread_id: "t1" }, rowMode: "object", resultRows: out });
    expect(out.length).toBe(1);
    expect(out[0].item_id).toBe("n1");
  });

  it("clearThreadItemsSql empties the thread", () => {
    db.exec({ sql: upsertThreadItemSql().sql, bind: itemToRow("t1", 0, { type: "external_message", id: "m1" }, null) });
    db.exec({ sql: upsertThreadItemSql().sql, bind: itemToRow("t1", 1, { type: "internal_note", id: "n1" }, null) });
    db.exec({ sql: clearThreadItemsSql().sql, bind: { $thread_id: "t1" } });

    const out: any[] = [];
    db.exec({ sql: listThreadItemsSql().sql, bind: { $thread_id: "t1" }, rowMode: "object", resultRows: out });
    expect(out.length).toBe(0);
  });

  it("getThreadSyncSql / setThreadSyncSql round-trip cursor and renderVersion", () => {
    db.exec({ sql: setThreadSyncSql().sql, bind: { $thread_id: "t1", $cursor: 42, $render_version: "v1" } });

    const rows: any[] = [];
    db.exec({ sql: getThreadSyncSql().sql, bind: { $thread_id: "t1" }, rowMode: "object", resultRows: rows });
    expect(rows.length).toBe(1);
    expect(rows[0].cursor).toBe(42);
    expect(rows[0].render_version).toBe("v1");
  });

  it("setThreadSyncSql upserts (replaces cursor + renderVersion)", () => {
    db.exec({ sql: setThreadSyncSql().sql, bind: { $thread_id: "t1", $cursor: 10, $render_version: "v1" } });
    db.exec({ sql: setThreadSyncSql().sql, bind: { $thread_id: "t1", $cursor: 20, $render_version: "v2" } });

    const rows: any[] = [];
    db.exec({ sql: getThreadSyncSql().sql, bind: { $thread_id: "t1" }, rowMode: "object", resultRows: rows });
    expect(rows.length).toBe(1);
    expect(rows[0].cursor).toBe(20);
    expect(rows[0].render_version).toBe("v2");
  });
});
