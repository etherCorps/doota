// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { parseIcs, icsDateToMs, extractRsvpLinks } from "@doota/mail-core/calendar";

const GOOGLE_REQUEST = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:abc123@google.com",
  "SEQUENCE:2",
  "STATUS:CONFIRMED",
  "DTSTART;TZID=America/New_York:20260801T150000",
  "DTEND;TZID=America/New_York:20260801T160000",
  "SUMMARY:Q3 Planning\\, all hands",
  "LOCATION:https://zoom.us/j/9876543210?pwd=secret",
  "DESCRIPTION:Agenda:\\n1. Recap\\n2. Roadmap",
  "ORGANIZER;CN=The Boss:mailto:boss@corp.com",
  "ATTENDEE;CN=You;PARTSTAT=NEEDS-ACTION:mailto:you@doota.dev",
  "ATTENDEE;PARTSTAT=ACCEPTED:mailto:peer@corp.com",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("parseIcs", () => {
  it("parses a Google REQUEST end to end", () => {
    const inv = parseIcs(GOOGLE_REQUEST)!;
    expect(inv).not.toBeNull();
    expect(inv.uid).toBe("abc123@google.com");
    expect(inv.method).toBe("REQUEST");
    expect(inv.status).toBe("CONFIRMED");
    expect(inv.sequence).toBe(2);
    expect(inv.summary).toBe("Q3 Planning, all hands"); // escaped comma unescaped
    expect(inv.description).toBe("Agenda:\n1. Recap\n2. Roadmap");
    expect(inv.tz).toBe("America/New_York");
    expect(inv.allDay).toBe(false);
    // 15:00 EDT (UTC-4 in August) == 19:00 UTC.
    expect(new Date(inv.startMs).toISOString()).toBe("2026-08-01T19:00:00.000Z");
    expect(new Date(inv.endMs!).toISOString()).toBe("2026-08-01T20:00:00.000Z");
    expect(inv.organizer).toEqual({ email: "boss@corp.com", name: "The Boss" });
    expect(inv.attendees).toEqual([
      { email: "you@doota.dev", name: "You", partstat: "NEEDS-ACTION" },
      { email: "peer@corp.com", name: null, partstat: "ACCEPTED" },
    ]);
    expect(inv.meetingPlatform).toBe("zoom");
    expect(inv.joinUrl).toContain("zoom.us/j/9876543210");
    expect(inv.calOrigin).toBe("google");
  });

  it("resolves a winter TZID date with the correct (standard-time) offset", () => {
    const ics = GOOGLE_REQUEST.replace(/20260801/g, "20260115");
    const inv = parseIcs(ics)!;
    // 15:00 EST (UTC-5 in January) == 20:00 UTC — DST handled by the refine step.
    expect(new Date(inv.startMs).toISOString()).toBe("2026-01-15T20:00:00.000Z");
  });

  it("handles UTC (Z), all-day, and floating dates", () => {
    expect(icsDateToMs("20260801T150000Z", null)).toEqual({
      ms: Date.UTC(2026, 7, 1, 15, 0, 0),
      tz: null,
      allDay: false,
    });
    expect(icsDateToMs("20260801", null)).toEqual({
      ms: Date.UTC(2026, 7, 1),
      tz: null,
      allDay: true,
    });
    // Floating (no zone) falls back to UTC.
    expect(icsDateToMs("20260801T150000", null)?.ms).toBe(Date.UTC(2026, 7, 1, 15, 0, 0));
  });

  it("reads the join URL from a CONFERENCE property over the LOCATION scrape", () => {
    const ics = GOOGLE_REQUEST.replace(
      "LOCATION:https://zoom.us/j/9876543210?pwd=secret",
      "CONFERENCE;VALUE=URI;FEATURE=VIDEO;LABEL=Meet:https://meet.google.com/abc-defg-hij\r\nLOCATION:Room 4",
    );
    const inv = parseIcs(ics)!;
    expect(inv.meetingPlatform).toBe("meet");
    expect(inv.joinUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(inv.location).toBe("Room 4");
  });

  it("detects Teams + Microsoft origin", () => {
    const ics = GOOGLE_REQUEST.replace("PRODID:-//Google Inc//Google Calendar 70.9054//EN", "PRODID:Microsoft Exchange Server 2010")
      .replace("https://zoom.us/j/9876543210?pwd=secret", "https://teams.microsoft.com/l/meetup-join/xyz");
    const inv = parseIcs(ics)!;
    expect(inv.calOrigin).toBe("microsoft");
    expect(inv.meetingPlatform).toBe("teams");
  });

  it("returns null for non-calendar input and events without a UID", () => {
    expect(parseIcs("not a calendar")).toBeNull();
    const noUid = GOOGLE_REQUEST.replace("UID:abc123@google.com\r\n", "");
    expect(parseIcs(noUid)).toBeNull();
  });

  it("unfolds RFC5545 folded lines", () => {
    const folded = GOOGLE_REQUEST.replace(
      "SUMMARY:Q3 Planning\\, all hands",
      "SUMMARY:Q3 Planning\\, a\r\n ll hands",
    );
    expect(parseIcs(folded)!.summary).toBe("Q3 Planning, all hands");
  });
});

describe("extractRsvpLinks", () => {
  it("pulls Google RESPOND links by rst code", () => {
    const html = `
      <a href="https://www.google.com/calendar/event?action=RESPOND&amp;eid=x&amp;rst=1">Yes</a>
      <a href="https://www.google.com/calendar/event?action=RESPOND&amp;eid=x&amp;rst=2">Maybe</a>
      <a href="https://www.google.com/calendar/event?action=RESPOND&amp;eid=x&amp;rst=3">No</a>`;
    const links = extractRsvpLinks(html);
    expect(links.accepted).toContain("rst=1");
    expect(links.tentative).toContain("rst=2");
    expect(links.declined).toContain("rst=3");
  });

  it("returns nulls when no RSVP links present", () => {
    expect(extractRsvpLinks("<a href='https://example.com'>x</a>")).toEqual({
      accepted: null,
      declined: null,
      tentative: null,
    });
    expect(extractRsvpLinks(null)).toEqual({ accepted: null, declined: null, tentative: null });
  });
});
