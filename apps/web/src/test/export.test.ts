// SPDX-License-Identifier: Apache-2.0
// Phase 6 stop gates (client-gaps build guide): resumable batched export,
// mbox structure a mail tool can parse (From_ separators, escaped bodies),
// X-Doota-* headers + sidecar JSON carrying labels/assignment/snooze in full.
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { importKey, putEncryptedBlob, getDecryptedBlob } from "@doota/mail-core/crypto";
import { materializeMessage, materializeDelivery, type ParsedMessage } from "@doota/mail-core/materialize";
import { kickExport, handleExportJob, exportPartKey, exportSidecarKey } from "@doota/mail-core/export";
import { createLabel, applyLabel } from "@doota/mail-core/labels";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const ORG = "org1";

let db: any;
let ck: Awaited<ReturnType<typeof importKey>>;
let deps: { ck: Awaited<ReturnType<typeof importKey>>; searchKeyB64: string };
let r2: any;
let queue: any;

function fakeR2() {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    async put(key: string, val: any) {
      store.set(key, typeof val === "string" ? new TextEncoder().encode(val).buffer : val);
    },
    async get(key: string) {
      const v = store.get(key);
      return v ? { arrayBuffer: async () => v } : null;
    },
  };
}
function fakeQueue() {
  const sent: any[] = [];
  return { sent, async send(body: any) { sent.push(body); } };
}

beforeEach(async () => {
  db = await makeDb();
  await db.insert(schema.organization).values({
    id: ORG, name: "Acme", slug: "acme-com", domain: "acme.com", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.user).values({
    id: "u1", name: "u1", email: "u1@x.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(schema.mailbox).values({
    id: "mb1", orgId: ORG, localPart: "alice", address: "alice@acme.com", isActive: true, isPersonal: true,
  });
  ck = await importKey(KEY_B64);
  deps = { ck, searchKeyB64: KEY_B64 };
  r2 = fakeR2();
  queue = fakeQueue();
});

function env() {
  return { MAIL_DEK: KEY_B64, MAIL_SEARCH_KEY: KEY_B64, MAIL_RAW: r2 as never, MAIL_QUEUE: queue as never } as any;
}

async function deliver(i: number, withRaw = false) {
  const raw = `Message-ID: <e${i}@ext>\r\nFrom: sender${i}@ext.com\r\nTo: alice@acme.com\r\nSubject: msg ${i}\r\nContent-Type: text/plain\r\n\r\nbody ${i}\r\nFrom the field\r\n`;
  let r2RawKey: string | null = null;
  if (withRaw) {
    r2RawKey = `raw/${ORG}/e${i}`;
    await putEncryptedBlob(r2, r2RawKey, ck, raw);
  }
  const pm: ParsedMessage = {
    messageIdHeader: `<e${i}@ext>`, inReplyTo: null, references: null,
    from: `sender${i}@ext.com`, subject: `msg ${i}`, sentAt: Date.now() - i,
    text: `body ${i}\nFrom the field`, html: null, r2RawKey, attachments: [],
  };
  const ids = await materializeMessage(db, ORG, pm, deps);
  await materializeDelivery(db, {
    orgId: ORG, ...ids, mailboxId: "mb1", role: "to", viaAliasId: null, subaddressTag: null, sentAt: pm.sentAt,
  });
  return ids;
}

async function decodeAllParts(exportId: string): Promise<string> {
  const row = await db.query.mailExport.findFirst({ where: eq(schema.mailExport.id, exportId) });
  let out = "";
  for (let seq = 1; seq <= row.partCount; seq++) {
    const buf = await getDecryptedBlob(r2, exportPartKey(ORG, exportId, seq), ck);
    out += new TextDecoder().decode(buf!);
  }
  return out;
}

describe("mailbox export", () => {
  it("batches with a D1 cursor, resumes, finishes, carries X-Doota state + sidecar", async () => {
    const first = await deliver(0, true);
    for (let i = 1; i < 60; i++) await deliver(i);
    const label = await createLabel(db, { orgId: ORG, name: "Invoices" });
    await applyLabel(db, { orgId: ORG, threadId: first.threadId, mailboxId: "mb1", labelId: label.id });
    await db.update(schema.threadState)
      .set({ assigneeUserId: "u1", snoozedUntil: new Date("2027-01-01T00:00:00Z") })
      .where(eq(schema.threadState.threadId, first.threadId));

    const exportId = await kickExport(db, queue as any, { orgId: ORG, mailboxId: "mb1", requestedByUserId: "u1" });
    expect(queue.sent).toHaveLength(1);

    // Batch 1 (50 of 60): cursor advances in D1 (survives eviction), re-enqueued.
    await handleExportJob(db, env(), queue.sent[0]);
    let row = await db.query.mailExport.findFirst({ where: eq(schema.mailExport.id, exportId) });
    expect(row.status).toBe("running");
    expect(row.messageCount).toBe(50);
    expect(row.partCount).toBe(1);
    expect(queue.sent).toHaveLength(2);

    // Batch 2 finishes + writes the sidecar.
    await handleExportJob(db, env(), queue.sent[1]);
    row = await db.query.mailExport.findFirst({ where: eq(schema.mailExport.id, exportId) });
    expect(row.status).toBe("done");
    expect(row.messageCount).toBe(60);
    expect(row.completedAt).not.toBeNull();

    const mbox = await decodeAllParts(exportId);
    // mbox structure: one From_ separator per message, bodies escaped.
    expect(mbox.match(/^From /gm)?.length).toBe(60);
    expect(mbox).toContain(">From the field"); // RFC 4155 escaping
    // Raw-backed message exported at full fidelity.
    expect(mbox).toContain("Message-ID: <e0@ext>");
    // Doota state as headers.
    expect(mbox).toContain(`X-Doota-Thread-Id: ${first.threadId}`);
    expect(mbox).toContain("X-Doota-Labels: Invoices");
    expect(mbox).toContain("X-Doota-Assigned-To: u1");
    expect(mbox).toContain("X-Doota-Snooze-Until: 2027-01-01T00:00:00.000Z");
    // Synthesized (no-raw) messages still export as parseable RFC822.
    expect(mbox).toContain("Subject: msg 5");

    const sidecarBuf = await getDecryptedBlob(r2, exportSidecarKey(ORG, exportId), ck);
    const sidecar = JSON.parse(new TextDecoder().decode(sidecarBuf!));
    expect(sidecar.version).toBe(1);
    const exportedThread = sidecar.threads.find((t: any) => t.threadId === first.threadId);
    expect(exportedThread).toMatchObject({
      labels: ["Invoices"],
      assignedTo: "u1",
      snoozeUntil: "2027-01-01T00:00:00.000Z",
      muted: false,
    });
  });

  it("a re-run of a finished export is a no-op (status gate)", async () => {
    await deliver(0);
    const exportId = await kickExport(db, queue as any, { orgId: ORG, mailboxId: "mb1", requestedByUserId: "u1" });
    await handleExportJob(db, env(), queue.sent[0]);
    const row1 = await db.query.mailExport.findFirst({ where: eq(schema.mailExport.id, exportId) });
    expect(row1.status).toBe("done");
    await handleExportJob(db, env(), queue.sent[0]); // redelivery
    const row2 = await db.query.mailExport.findFirst({ where: eq(schema.mailExport.id, exportId) });
    expect(row2.messageCount).toBe(row1.messageCount);
    expect(row2.partCount).toBe(row1.partCount);
  });
});
