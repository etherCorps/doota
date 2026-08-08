// SPDX-License-Identifier: Apache-2.0
// E2E ingest seam: a real RFC822 invite — parsed by the SAME PostalMime the
// inbound consumer uses — flows through persistInvite into calendar_event rows.
// This is the one path unit fixtures skip: it proves the real parser surfaces
// the text/calendar part where persistInvite looks for it (parsed.attachments),
// and it locks the organizer guard on inbound iTIP replies (a REPLY whose
// organizer isn't one of our mailboxes is dropped — misdirected/spoofed).
//
// It stops at the calendar_event rows on purpose: those rows are exactly what
// the display layer (thread.remote resolveEffectiveEvent) and RSVP gate consume,
// and that remote needs SvelteKit locals, so it isn't unit-reachable here.
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import PostalMime from "postal-mime";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { invalidateDomainCache } from "@doota/db/org-domains";
import { materializeMessage, type ParsedMessage } from "@doota/mail-core/materialize";
import { persistInvite } from "@doota/mail-core/queue-consumer";
import { importKey, decryptContent, type ContentKey } from "@doota/mail-core/crypto";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const ORG = "org1";

async function seed(db: any) {
  await db.insert(schema.organization).values({
    id: ORG, name: "Acme", slug: "acme-com", domain: "acme.com", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.orgMailSettings).values({
    orgId: ORG, subaddressingEnabled: false, routingSubdomains: JSON.stringify([]),
  });
  await db.insert(schema.mailbox).values([
    { id: "mb_alice", orgId: ORG, localPart: "alice", address: "alice@acme.com", isActive: true, isPersonal: true },
  ]);
  invalidateDomainCache();
}

// persistInvite only WRITES the raw ICS to R2 (never reads it back in the same
// call), so a no-op put is a faithful stand-in for the bucket here.
const R2_NOOP = { put: async () => ({}) } as any;

const CRLF = (lines: string[]) => lines.join("\r\n");

// A real multipart/mixed message carrying the ICS as a text/calendar part —
// the shape Google/Apple/Fastmail actually send.
function rawInvite(from: string, ics: string, html: string, msgId: string): string {
  const b = "BOUNDARY_42";
  return CRLF([
    `From: ${from}`,
    `To: alice@acme.com`,
    `Subject: Invitation`,
    `Message-ID: <${msgId}@ext>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${b}"`,
    ``,
    `--${b}`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    html,
    `--${b}`,
    `Content-Type: text/calendar; method=REQUEST; charset=utf-8; name="invite.ics"`,
    `Content-Disposition: attachment; filename="invite.ics"`,
    ``,
    ics,
    `--${b}--`,
    ``,
  ]);
}

let db: any;
let ck: ContentKey;
let seq = 0;

beforeEach(async () => {
  db = await makeDb();
  await seed(db);
  ck = await importKey(KEY_B64);
  seq = 0;
});

// Materialize a real message row, then run the real ingest parse+persist over
// the raw bytes — mirrors the consumer body (PostalMime.parse → persistInvite).
async function ingest(from: string, ics: string, html = "<p>Invite</p>"): Promise<string> {
  const msgId = `inv-${++seq}`;
  const raw = rawInvite(from, ics, html, msgId);
  const parsed = (await PostalMime.parse(raw)) as any;
  const pm: ParsedMessage = {
    messageIdHeader: `<${msgId}@ext>`,
    inReplyTo: null,
    references: null,
    from,
    subject: "Invitation",
    sentAt: Date.now(),
    text: "Invite",
    html,
    r2RawKey: `raw/${ORG}/${msgId}`,
    attachments: [],
  };
  const { messageId } = await materializeMessage(db, ORG, pm, { ck, searchKeyB64: KEY_B64 });
  await persistInvite(db, { MAIL_RAW: R2_NOOP }, ck, ORG, messageId, parsed);
  return messageId;
}

const rows = (messageId: string) =>
  db.select().from(schema.calendarEvent).where(eq(schema.calendarEvent.messageId, messageId));

const REQUEST = (uid: string, organizer: string, attendee: string) =>
  CRLF([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Google Inc//Google Calendar//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "SEQUENCE:0",
    "SUMMARY:Quarterly review",
    "DTSTART:20260901T150000Z",
    "DTEND:20260901T160000Z",
    `ORGANIZER;CN=Org:mailto:${organizer}`,
    `ATTENDEE;CN=Att;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendee}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ]);

const REPLY = (uid: string, organizer: string) =>
  CRLF([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Corp//EN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "SEQUENCE:0",
    "SUMMARY:Quarterly review",
    "DTSTART:20260901T150000Z",
    `ORGANIZER:mailto:${organizer}`,
    "ATTENDEE;PARTSTAT=ACCEPTED:mailto:peer@corp.com",
    "END:VEVENT",
    "END:VCALENDAR",
  ]);

describe("invite ingest — real MIME through PostalMime + persistInvite", () => {
  it("a REQUEST invite lands one calendar_event row with decryptable details", async () => {
    const messageId = await ingest("boss@corp.com", REQUEST("evt-req@corp.com", "boss@corp.com", "alice@acme.com"));
    const got = await rows(messageId);
    expect(got.length).toBe(1);
    expect(got[0].uid).toBe("evt-req@corp.com");
    expect(got[0].method).toBe("REQUEST");
    expect(got[0].isCancelled).toBe(false);
    expect(got[0].organizerEmail).toBe("boss@corp.com");
    expect(got[0].rawIcsR2Key).toMatch(/^calendar\/org1\//);
    const details = JSON.parse((await decryptContent(ck, got[0].detailsEnc))!);
    expect(details.summary).toBe("Quarterly review");
  });

  it("keeps a REPLY whose organizer IS one of our mailboxes", async () => {
    const messageId = await ingest("peer@corp.com", REPLY("evt-mine@acme.com", "alice@acme.com"));
    expect((await rows(messageId)).length).toBe(1);
  });

  it("DROPS a REPLY whose organizer is NOT in our DB (misdirected/spoofed)", async () => {
    const messageId = await ingest("peer@corp.com", REPLY("evt-req@corp.com", "boss@corp.com"));
    expect((await rows(messageId)).length).toBe(0);
  });

  it("flags a CANCEL as cancelled (not a reply-class method, so still stored)", async () => {
    const ics = CRLF([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar//EN",
      "METHOD:CANCEL",
      "BEGIN:VEVENT",
      "UID:evt-req@corp.com",
      "SEQUENCE:1",
      "STATUS:CANCELLED",
      "DTSTART:20260901T150000Z",
      "ORGANIZER:mailto:boss@corp.com",
      "ATTENDEE:mailto:alice@acme.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
    const messageId = await ingest("boss@corp.com", ics);
    const got = await rows(messageId);
    expect(got.length).toBe(1);
    expect(got[0].isCancelled).toBe(true);
  });

  it("stores one row per VEVENT in a multi-event calendar", async () => {
    const ics = CRLF([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//x//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:multi-a@corp.com",
      "DTSTART:20260901T150000Z",
      "ORGANIZER:mailto:boss@corp.com",
      "ATTENDEE:mailto:alice@acme.com",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:multi-b@corp.com",
      "DTSTART;VALUE=DATE:20260902",
      "ORGANIZER:mailto:boss@corp.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
    const messageId = await ingest("boss@corp.com", ics);
    expect((await rows(messageId)).length).toBe(2);
  });
});
