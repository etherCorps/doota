// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import {
  logSendEvent,
  listSendEvents,
  readSendEventData,
  purgeExpiredSendData,
} from "@doota/mail-core/send-log";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef"); // 32 bytes
const ORG = "org1";
const MB = "mb_svc";
const KEY = "key1";

async function seed(db: any) {
  await db.insert(schema.organization).values({
    id: ORG, name: "Acme", slug: "acme-com", domain: "acme.com", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.mailbox).values({
    id: MB, orgId: ORG, localPart: "notify", address: "notify@acme.com", isActive: true, isService: true,
  });
  await db.insert(schema.apiKey).values({
    id: KEY, orgId: ORG, mailboxId: MB, isService: true, name: "CI", keyHash: "h", prefix: "dk_abc", createdAt: new Date(),
  });
}

let db: any;
beforeEach(async () => {
  db = await makeDb();
  await seed(db);
});

describe("send log", () => {
  it("logs metadata + encrypts the payload, redacting sensitive keys", async () => {
    await logSendEvent(db, {
      orgId: ORG, mailboxId: MB, apiKeyId: KEY,
      to: ["a@x.com"], cc: ["b@x.com"], subject: "Welcome",
      data: { name: "Ana", password: "hunter2" },
      sensitiveKeys: ["password"],
      dek: KEY_B64,
    });

    const events = await listSendEvents(db, MB);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.subject).toBe("Welcome");
    expect(e.toAddresses).toEqual(["a@x.com", "b@x.com"]);
    expect(e.apiKeyId).toBe(KEY);
    expect(e.dataAvailable).toBe(true);
    expect(e.redactedKeys).toEqual(["password"]);

    // Decrypted payload keeps non-sensitive vars, drops the redacted one.
    const data = await readSendEventData(db, e.id, KEY_B64);
    expect(data).toEqual({ name: "Ana" });
    expect(data).not.toHaveProperty("password");
  });

  it("stores no cipher for a raw (data-less) send", async () => {
    await logSendEvent(db, { orgId: ORG, mailboxId: MB, apiKeyId: KEY, to: ["a@x.com"], subject: "Raw", dek: KEY_B64 });
    const [e] = await listSendEvents(db, MB);
    expect(e.dataAvailable).toBe(false);
    expect(await readSendEventData(db, e.id, KEY_B64)).toBeNull();
  });

  it("purge nulls the payload past TTL but keeps the metadata row", async () => {
    // Negative TTL → dataExpiresAt already in the past.
    await logSendEvent(db, {
      orgId: ORG, mailboxId: MB, apiKeyId: KEY, to: ["a@x.com"], subject: "Old",
      data: { name: "Ana" }, dek: KEY_B64, dataTtlMs: -1000,
    });
    expect((await listSendEvents(db, MB))[0].dataAvailable).toBe(true);

    const purged = await purgeExpiredSendData(db);
    expect(purged).toBe(1);

    const events = await listSendEvents(db, MB);
    expect(events).toHaveLength(1); // metadata survives
    expect(events[0].dataAvailable).toBe(false); // payload gone
    expect(await readSendEventData(db, events[0].id, KEY_B64)).toBeNull();
  });

  it("does not purge payloads whose TTL is still in the future", async () => {
    await logSendEvent(db, {
      orgId: ORG, mailboxId: MB, apiKeyId: KEY, to: ["a@x.com"], data: { x: 1 }, dek: KEY_B64,
    });
    expect(await purgeExpiredSendData(db)).toBe(0);
    expect((await listSendEvents(db, MB))[0].dataAvailable).toBe(true);
  });
});
