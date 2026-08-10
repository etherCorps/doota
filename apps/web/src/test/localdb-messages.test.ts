// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import {
  DDL,
  upsertMessageSql,
  deleteMessageSql,
  listMessagesSql,
  clearThreadMessagesSql,
  getThreadSyncSql,
  setThreadSyncSql,
  messageDtoToRow,
  rowToMessageDto,
} from "$lib/client/localdb/schema";
import type { MessageDTO } from "@doota/mail-core/mail-thread-contract";

const richMsg = (over: Partial<MessageDTO> = {}): MessageDTO => ({
  type: "external_message",
  id: "msg1",
  threadId: "t1",
  messageIdHeader: "<msg1@example.com>",
  from: "alice@example.com",
  fromName: "Alice",
  to: ["bob@example.com"],
  cc: [],
  replyTo: null,
  sentAt: 1_700_000_000_000,
  contentKind: "card",
  subject: "Hello",
  bodyStripped: "Hello",
  bodyFull: "Hello there",
  htmlKind: "rich",
  hasRemoteImages: true,
  senderTrusted: false,
  senderVerified: true,
  keywords: ["inbox"],
  isRead: false,
  outbound: false,
  viaAlias: null,
  viaAliasId: null,
  attachments: [{ id: "a1", partId: "1.1", filename: "doc.pdf", contentType: "application/pdf", size: 1024, inline: false }],
  ...over,
});

const plainMsg = (): MessageDTO => ({
  type: "external_message",
  id: "msg2",
  threadId: "t1",
  messageIdHeader: "<msg2@example.com>",
  from: "bob@example.com",
  fromName: "Bob",
  to: ["alice@example.com"],
  cc: ["carol@example.com"],
  replyTo: null,
  sentAt: 1_700_000_001_000,
  contentKind: "bubble",
  subject: "Re: Hello",
  bodyStripped: "Sure!",
  bodyFull: null,
  htmlKind: "plain",
  hasRemoteImages: false,
  keywords: [],
  isRead: true,
  outbound: false,
  viaAlias: null,
  viaAliasId: null,
  attachments: [],
});

let db: any;
beforeEach(async () => {
  const sqlite3 = await sqlite3InitModule();
  db = new sqlite3.oo1.DB(":memory:", "c");
  db.exec(DDL);
});

describe("localdb message schema", () => {
  it("upserts two messages and lists them ordered by seq", () => {
    const row1 = messageDtoToRow("t1", 0, richMsg(), "<html>rich</html>", "v1");
    const row2 = messageDtoToRow("t1", 1, plainMsg(), null, "v1");
    db.exec({ sql: upsertMessageSql().sql, bind: row1 });
    db.exec({ sql: upsertMessageSql().sql, bind: row2 });

    const out: any[] = [];
    db.exec({ sql: listMessagesSql().sql, bind: { $thread_id: "t1" }, rowMode: "object", resultRows: out });
    expect(out.length).toBe(2);
    expect(out[0].message_id).toBe("msg1");
    expect(out[1].message_id).toBe("msg2");
  });

  it("rowToMessageDto round-trips htmlKind, bodyText, framedHtml, and meta_json fields", () => {
    const dto = richMsg();
    const row = messageDtoToRow("t1", 0, dto, "<html>rich</html>", "v1");
    db.exec({ sql: upsertMessageSql().sql, bind: row });

    const rows: any[] = [];
    db.exec({ sql: listMessagesSql().sql, bind: { $thread_id: "t1" }, rowMode: "object", resultRows: rows });
    const rebuilt = rowToMessageDto(rows[0]);

    expect(rebuilt.htmlKind).toBe("rich");
    expect(rebuilt.bodyFull).toBe("Hello there");
    expect(rows[0].framed_html).toBe("<html>rich</html>");
    expect(rebuilt.attachments).toHaveLength(1);
    expect(rebuilt.attachments[0].filename).toBe("doc.pdf");
    expect(rebuilt.keywords).toEqual(["inbox"]);
    expect(rebuilt.senderVerified).toBe(true);
    expect(rebuilt.type).toBe("external_message");
  });

  it("rowToMessageDto round-trips plain message (framed_html null, bodyStripped set)", () => {
    const row = messageDtoToRow("t1", 1, plainMsg(), null, "v1");
    db.exec({ sql: upsertMessageSql().sql, bind: row });

    const rows: any[] = [];
    db.exec({ sql: listMessagesSql().sql, bind: { $thread_id: "t1" }, rowMode: "object", resultRows: rows });
    const rebuilt = rowToMessageDto(rows[0]);

    expect(rebuilt.htmlKind).toBe("plain");
    expect(rows[0].framed_html).toBeNull();
    expect(rebuilt.bodyStripped).toBe("Sure!");
    expect(rebuilt.cc).toEqual(["carol@example.com"]);
  });

  it("upsert-replace updates in place (same thread_id, message_id)", () => {
    db.exec({ sql: upsertMessageSql().sql, bind: messageDtoToRow("t1", 0, richMsg({ isRead: false }), null, "v1") });
    db.exec({ sql: upsertMessageSql().sql, bind: messageDtoToRow("t1", 0, richMsg({ isRead: true }), null, "v1") });

    const out: any[] = [];
    db.exec({ sql: listMessagesSql().sql, bind: { $thread_id: "t1" }, rowMode: "object", resultRows: out });
    expect(out.length).toBe(1);
    expect(out[0].is_read).toBe(1);
  });

  it("deleteMessageSql removes a single row", () => {
    db.exec({ sql: upsertMessageSql().sql, bind: messageDtoToRow("t1", 0, richMsg(), null, "v1") });
    db.exec({ sql: upsertMessageSql().sql, bind: messageDtoToRow("t1", 1, plainMsg(), null, "v1") });
    db.exec({ sql: deleteMessageSql().sql, bind: { $thread_id: "t1", $message_id: "msg1" } });

    const out: any[] = [];
    db.exec({ sql: listMessagesSql().sql, bind: { $thread_id: "t1" }, rowMode: "object", resultRows: out });
    expect(out.length).toBe(1);
    expect(out[0].message_id).toBe("msg2");
  });

  it("clearThreadMessagesSql empties the thread", () => {
    db.exec({ sql: upsertMessageSql().sql, bind: messageDtoToRow("t1", 0, richMsg(), null, "v1") });
    db.exec({ sql: upsertMessageSql().sql, bind: messageDtoToRow("t1", 1, plainMsg(), null, "v1") });
    db.exec({ sql: clearThreadMessagesSql().sql, bind: { $thread_id: "t1" } });

    const out: any[] = [];
    db.exec({ sql: listMessagesSql().sql, bind: { $thread_id: "t1" }, rowMode: "object", resultRows: out });
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
