// SPDX-License-Identifier: Apache-2.0
// ical.js-backed parse (RFC 5545) + iTIP build (RFC 5546). Focus is the GUARDS:
// malformed never throws, multi-VEVENT, all-day vs timed vs TZID, RECURRENCE-ID,
// raw RRULE (never expanded), and REPLY carrying ONLY the replying attendee.
import { describe, it, expect } from "vitest";
import { parseCalendar, buildReply, buildInvite, resolveEffectiveEvent } from "@doota/mail-core/ical";

const CRLF = (lines: string[]) => lines.join("\r\n");

const REQUEST = CRLF([
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Google Inc//Google Calendar//EN",
  "METHOD:REQUEST",
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "DTSTART:20070311T020000",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:evt-1@x",
  "SEQUENCE:3",
  "SUMMARY:Weekly sync",
  "DTSTART;TZID=America/New_York:20260810T090000",
  "DTEND;TZID=America/New_York:20260810T093000",
  "ORGANIZER;CN=The Boss:mailto:boss@acme.com",
  "ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:me@doota.dev",
  "ATTENDEE;CN=Peer;PARTSTAT=ACCEPTED:mailto:peer@acme.com",
  "LOCATION:https://zoom.us/j/123",
  "RRULE:FREQ=WEEKLY;BYDAY=MO",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:evt-2@x",
  "DTSTART;VALUE=DATE:20260812",
  "SUMMARY:Company holiday",
  "END:VEVENT",
  "END:VCALENDAR",
]);

describe("parseCalendar", () => {
  it("NEVER throws on garbage — returns ok:false", () => {
    for (const bad of [
      "",
      "not a calendar at all",
      "BEGIN:VCALENDAR\r\ngarbage\x00\x01",
      "BEGIN:VCALENDAR\r\nEND:VCALENDAR", // no events
      new Uint8Array([0xff, 0xfe, 0x00, 0x01]).buffer,
    ]) {
      const r = parseCalendar(bad as string | ArrayBuffer);
      expect(r.ok).toBe(false);
    }
  });

  it("reads METHOD + every VEVENT", () => {
    const r = parseCalendar(REQUEST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe("REQUEST");
    expect(r.events.length).toBe(2);
  });

  it("resolves a TZID datetime to the correct UTC instant (DST-aware)", () => {
    const r = parseCalendar(REQUEST);
    if (!r.ok) return;
    const e = r.events[0];
    // 2026-08-10 09:00 America/New_York (EDT, UTC-4) === 13:00 UTC.
    expect(new Date(e.startMs).toISOString()).toBe("2026-08-10T13:00:00.000Z");
    expect(e.tz).toBe("America/New_York");
    expect(e.allDay).toBe(false);
  });

  it("handles all-day (VALUE=DATE) as tz-agnostic", () => {
    const r = parseCalendar(REQUEST);
    if (!r.ok) return;
    const e = r.events[1];
    expect(e.allDay).toBe(true);
    expect(new Date(e.startMs).toISOString()).toBe("2026-08-12T00:00:00.000Z");
  });

  it("stores RRULE raw and does NOT expand it", () => {
    const r = parseCalendar(REQUEST);
    if (!r.ok) return;
    expect(r.events[0].rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
  });

  it("extracts organizer, attendees (partstat), meeting platform, origin", () => {
    const r = parseCalendar(REQUEST);
    if (!r.ok) return;
    const e = r.events[0];
    expect(e.organizer).toEqual({ email: "boss@acme.com", name: "The Boss" });
    expect(e.attendees).toEqual([
      { email: "me@doota.dev", name: "Me", partstat: "NEEDS-ACTION" },
      { email: "peer@acme.com", name: "Peer", partstat: "ACCEPTED" },
    ]);
    expect(e.meetingPlatform).toBe("zoom");
    expect(e.calOrigin).toBe("google");
  });

  it("keys a RECURRENCE-ID override on its own identity", () => {
    const ics = CRLF([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//x//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:series@x",
      "RECURRENCE-ID:20260817T090000Z",
      "SEQUENCE:1",
      "SUMMARY:Just this week, moved",
      "DTSTART:20260817T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
    const r = parseCalendar(ics);
    if (!r.ok) return;
    expect(r.events[0].recurrenceId).toBe("2026-08-17T09:00:00Z");
    expect(r.events[0].uid).toBe("series@x");
  });

  it("flags an event missing UID/DTSTART as incomplete, does not crash", () => {
    const ics = CRLF([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//x//EN",
      "BEGIN:VEVENT",
      "SUMMARY:No uid no start",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
    const r = parseCalendar(ics);
    if (!r.ok) return;
    expect(r.events[0].incomplete).toBe(true);
  });
});

describe("resolveEffectiveEvent (SEQUENCE supersede + CANCEL)", () => {
  const row = (sequence: number, isCancelled: boolean, createdAtMs: number) => ({
    id: `${sequence}-${createdAtMs}`,
    sequence,
    isCancelled,
    createdAtMs,
  });

  it("higher SEQUENCE wins; a lower one arriving LATER is ignored", () => {
    const { winner } = resolveEffectiveEvent([
      row(3, false, 100), // the update
      row(1, false, 200), // stale re-delivery, arrives later — must NOT win
    ]);
    expect(winner.sequence).toBe(3);
  });

  it("ties break to the newest", () => {
    const { winner } = resolveEffectiveEvent([row(2, false, 100), row(2, false, 300)]);
    expect(winner.createdAtMs).toBe(300);
  });

  it("a CANCEL at ≥ the winning sequence cancels the event", () => {
    expect(resolveEffectiveEvent([row(1, false, 100), row(2, true, 200)]).cancelled).toBe(true);
  });

  it("a stale CANCEL (lower sequence than the winner) does NOT cancel", () => {
    // A newer REQUEST (seq 3) supersedes an older CANCEL (seq 1) — event lives.
    const res = resolveEffectiveEvent([row(1, true, 100), row(3, false, 200)]);
    expect(res.winner.sequence).toBe(3);
    expect(res.cancelled).toBe(false);
  });
});

describe("buildReply (iTIP REPLY)", () => {
  it("carries ONLY the replying attendee — never the full guest list", () => {
    const ics = buildReply({
      uid: "evt-1@x",
      sequence: 3,
      organizerEmail: "boss@acme.com",
      organizerName: "The Boss",
      attendeeEmail: "me@doota.dev",
      attendeeName: "Me",
      partstat: "ACCEPTED",
      summary: "Weekly sync",
      dtstampMs: Date.UTC(2026, 7, 1, 12, 0, 0),
    });
    expect(ics).toMatch(/METHOD:REPLY/);
    expect(ics).toMatch(/UID:evt-1@x/);
    expect(ics).toMatch(/SEQUENCE:3/);
    expect(ics).toMatch(/PARTSTAT=ACCEPTED/);
    expect(ics).toMatch(/mailto:me@doota\.dev/);
    // The other attendee (peer@acme.com) MUST NOT appear — privacy leak.
    expect(ics).not.toMatch(/peer@acme\.com/);
    // Exactly one ATTENDEE line.
    expect(ics.match(/^ATTENDEE/gim)?.length ?? 0).toBe(1);
    // Round-trips: re-parse the reply.
    const back = parseCalendar(ics);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.events[0].attendees[0].partstat).toBe("ACCEPTED");
  });

  it("escapes a hostile summary (no header/field injection)", () => {
    const ics = buildReply({
      uid: "x@x",
      sequence: 0,
      organizerEmail: "o@x.com",
      attendeeEmail: "a@x.com",
      partstat: "DECLINED",
      summary: "evil\r\nUID:injected@x\r\nSUMMARY:pwned",
    });
    // The injected UID line must not appear as a real property.
    expect(ics).not.toMatch(/^UID:injected@x/m);
    const back = parseCalendar(ics);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.events[0].uid).toBe("x@x");
  });
});

describe("buildInvite (iTIP REQUEST — for later)", () => {
  it("builds a REQUEST with SEQUENCE:0 and NEEDS-ACTION attendees", () => {
    const ics = buildInvite({
      uid: "new-uuid@doota.dev",
      organizerEmail: "me@doota.dev",
      attendees: [{ email: "guest@ext.com", name: "Guest" }],
      summary: "Kickoff",
      startMs: Date.UTC(2026, 8, 1, 15, 0, 0),
      endMs: Date.UTC(2026, 8, 1, 16, 0, 0),
      dtstampMs: Date.UTC(2026, 7, 1, 12, 0, 0),
    });
    expect(ics).toMatch(/METHOD:REQUEST/);
    expect(ics).toMatch(/SEQUENCE:0/);
    expect(ics).toMatch(/PARTSTAT=NEEDS-ACTION/);
    expect(ics).toMatch(/RSVP=TRUE/);
    const back = parseCalendar(ics);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.events[0].organizer.email).toBe("me@doota.dev");
  });

  it("rejects a REQUEST with no attendees", () => {
    expect(() =>
      buildInvite({ uid: "x", organizerEmail: "o@x.com", attendees: [], summary: "x", startMs: 0 }),
    ).toThrow();
  });
});
