// SPDX-License-Identifier: Apache-2.0
/**
 * iCalendar (RFC 5545) parse + iTIP (RFC 5546) build, via ical.js — pure JS, no
 * Node APIs, Workers-safe. This is the STORAGE/RSVP-grade path (all VEVENTs,
 * RECURRENCE-ID overrides, METHOD, raw RRULE, sequence) and the REPLY/REQUEST
 * builders that make "create event" a later drop-in. The lighter display-only
 * helpers (join-url, provider RSVP links, tz math) live in `calendar.ts`; we
 * reuse its meeting/origin detection here rather than duplicate it.
 *
 * Everything is defensive: attacker-controlled bytes. parseCalendar NEVER
 * throws — a malformed VCALENDAR returns `{ ok:false }`, never breaks ingest.
 */
import ICAL from "ical.js";
import type { InviteAttendee, MeetingPlatform, CalOrigin } from "./calendar.ts";

/** One VEVENT, storage-shaped. Cleartext-safe metadata + the sensitive free-text
 * kept separate so the caller encrypts only the latter (matches calendar.ts). */
export type ParsedEvent = {
  uid: string;
  /** RECURRENCE-ID (a single-instance override of a recurring series), or null.
   * Part of the composite event identity `(uid, recurrenceId)`. */
  recurrenceId: string | null;
  sequence: number;
  status: string | null; // CONFIRMED | CANCELLED | TENTATIVE
  startMs: number;
  endMs: number | null;
  tz: string | null; // IANA label when the value carried a TZID
  allDay: boolean;
  organizer: { email: string | null; name: string | null };
  attendees: InviteAttendee[];
  /** RAW recurrence rules — stored verbatim, NEVER expanded (out of scope). */
  rrule: string | null;
  rdate: string[] | null;
  exdate: string[] | null;
  meetingPlatform: MeetingPlatform;
  calOrigin: CalOrigin;
  /** Missing UID or DTSTART → we can't dedupe/place it; flagged, not dropped. */
  incomplete: boolean;
  // --- sensitive free-text (encrypt these) ---
  summary: string | null;
  description: string | null;
  location: string | null;
};

export type ParsedCalendar =
  | { ok: true; method: string; events: ParsedEvent[] }
  | { ok: false; reason: "unparseable" | "empty" };

const mailtoAddr = (v: string | null | undefined): string =>
  (v ?? "").replace(/^mailto:/i, "").trim().toLowerCase();

// Reuse calendar.ts detection so both parsers agree. Imported lazily-ish (top
// import) — these are pure string fns, no cost.
import { detectMeetingAndOrigin } from "./calendar.ts";

/** ical.js Time → { ms, tz, allDay }. All-day (isDate) is tz-agnostic: its wall
 * date is pinned as a UTC midnight so the viewer shows the intended day. */
function timeToMs(t: ICAL.Time | null): { ms: number; tz: string | null; allDay: boolean } | null {
  if (!t) return null;
  try {
    if (t.isDate) {
      return { ms: Date.UTC(t.year, t.month - 1, t.day), tz: null, allDay: true };
    }
    // toJSDate() resolves TZID via any embedded VTIMEZONE (ical.js registers them
    // while parsing) or falls back to the zone name; UTC/floating handled too.
    const ms = t.toJSDate().getTime();
    if (!Number.isFinite(ms)) return null;
    const zone = t.zone?.tzid && t.zone.tzid !== "UTC" && t.zone.tzid !== "floating" ? t.zone.tzid : null;
    return { ms, tz: zone, allDay: false };
  } catch {
    return null;
  }
}

const cap = (s: string | null, n = 2000): string | null =>
  s && s.length > n ? s.slice(0, n) + "…" : s;

function readEvent(ve: ICAL.Component): ParsedEvent | null {
  const val = (name: string): string | null => {
    try {
      const v = ve.getFirstPropertyValue(name);
      return v == null ? null : typeof v === "string" ? v : String(v);
    } catch {
      return null;
    }
  };

  const uid = val("uid")?.trim() ?? "";
  const dt = timeToMs(ve.getFirstPropertyValue("dtstart") as ICAL.Time | null);
  const incomplete = !uid || !dt;
  // Even incomplete events are kept (flagged) so raw survives; but a start we
  // can't read means no card placement — use 0 and let the caller decide.
  const start = dt ?? { ms: 0, tz: null, allDay: false };
  const end = timeToMs(ve.getFirstPropertyValue("dtend") as ICAL.Time | null);

  // RECURRENCE-ID: the override key. Store its ISO-ish string form verbatim.
  const recProp = ve.getFirstProperty("recurrence-id");
  const recurrenceId = recProp ? String(recProp.getFirstValue()) : null;

  const orgProp = ve.getFirstProperty("organizer");
  const organizer = {
    email: orgProp ? mailtoAddr(String(orgProp.getFirstValue())) || null : null,
    name: (orgProp?.getParameter("cn") as string | undefined) ?? null,
  };

  const attendees: InviteAttendee[] = ve.getAllProperties("attendee").map((p) => ({
    email: mailtoAddr(String(p.getFirstValue())),
    name: (p.getParameter("cn") as string | undefined) ?? null,
    partstat: ((p.getParameter("partstat") as string | undefined) ?? null)?.toUpperCase() ?? null,
  })).filter((a) => a.email);

  const rrule = ve.getFirstProperty("rrule");
  const rdate = ve.getAllProperties("rdate");
  const exdate = ve.getAllProperties("exdate");

  const summary = val("summary");
  const location = val("location");
  const description = cap(val("description"));
  const prodId = ""; // PRODID is calendar-level; detection also checks organizer domain
  const { meetingPlatform, calOrigin } = detectMeetingAndOrigin(
    prodId,
    organizer.email,
    [location ?? "", description ?? ""].join("\n"),
  );

  const seqRaw = val("sequence");
  return {
    uid,
    recurrenceId,
    sequence: seqRaw ? Number(seqRaw) || 0 : 0,
    status: val("status")?.trim().toUpperCase() ?? null,
    startMs: start.ms,
    endMs: end?.ms ?? null,
    tz: start.tz,
    allDay: start.allDay,
    organizer,
    attendees,
    rrule: rrule ? String(rrule.getFirstValue()) : null,
    rdate: rdate.length ? rdate.map((p) => String(p.getFirstValue())) : null,
    exdate: exdate.length ? exdate.map((p) => String(p.getFirstValue())) : null,
    meetingPlatform,
    calOrigin,
    incomplete,
    summary,
    description,
    location,
  };
}

/**
 * Parse a VCALENDAR into its METHOD + every VEVENT. NEVER throws — malformed
 * input returns `{ ok:false }` so ingest keeps the email and stores raw ICS.
 */
export function parseCalendar(input: string | ArrayBuffer | Uint8Array): ParsedCalendar {
  let text: string;
  try {
    text =
      typeof input === "string"
        ? input
        : new TextDecoder().decode(input instanceof Uint8Array ? input : new Uint8Array(input));
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (!/BEGIN:VCALENDAR/i.test(text)) return { ok: false, reason: "unparseable" };
  try {
    const comp = new ICAL.Component(ICAL.parse(text));
    const method = String(comp.getFirstPropertyValue("method") ?? "REQUEST").toUpperCase();
    const prodId = String(comp.getFirstPropertyValue("prodid") ?? "");
    const vevents = comp.getAllSubcomponents("vevent");
    const events: ParsedEvent[] = [];
    for (const ve of vevents) {
      const parsed = readEvent(ve);
      if (parsed) {
        // Fold calendar-level PRODID into origin detection now that we have it.
        if (parsed.calOrigin === null || parsed.calOrigin === "other") {
          const { calOrigin } = detectMeetingAndOrigin(prodId, parsed.organizer.email, "");
          if (calOrigin) parsed.calOrigin = calOrigin;
        }
        events.push(parsed);
      }
    }
    if (!events.length) return { ok: false, reason: "empty" };
    return { ok: true, method, events };
  } catch {
    return { ok: false, reason: "unparseable" };
  }
}

// ---- effective-state resolution ------------------------------------------------

/**
 * Across the rows that share one event `(uid, recurrence_id)` — a re-invite
 * (higher SEQUENCE) or a CANCEL arriving as separate messages — resolve the
 * CURRENT state: the highest SEQUENCE wins (tie → newest), a lower/equal
 * sequence arriving later is IGNORED, and a CANCEL at ≥ the winning sequence
 * marks the event cancelled. Pure so read.ts and its tests share one rule.
 */
export function resolveEffectiveEvent<
  T extends { sequence: number; isCancelled: boolean; createdAtMs: number },
>(rows: T[]): { winner: T; cancelled: boolean } {
  const winner = rows.reduce((best, r) =>
    r.sequence > best.sequence ||
    (r.sequence === best.sequence && r.createdAtMs > best.createdAtMs)
      ? r
      : best,
  );
  const cancelled = rows.some((r) => r.isCancelled && r.sequence >= winner.sequence);
  return { winner, cancelled };
}

// ---- iTIP builders (RFC 5546) --------------------------------------------------

export type ReplyPartstat = "ACCEPTED" | "DECLINED" | "TENTATIVE";

export type BuildReplyInput = {
  uid: string;
  /** SEQUENCE being responded to (echo the invite's). */
  sequence: number;
  recurrenceId?: string | null;
  /** ORGANIZER address to reply to (validated by the caller). */
  organizerEmail: string;
  organizerName?: string | null;
  /** EXACTLY the replying attendee — never the full list (privacy). */
  attendeeEmail: string;
  attendeeName?: string | null;
  partstat: ReplyPartstat;
  summary?: string | null;
  /** DTSTAMP override for deterministic tests; defaults to now. */
  dtstampMs?: number;
  prodId?: string;
};

function icalUtcStamp(ms: number): ICAL.Time {
  return ICAL.Time.fromJSDate(new Date(ms), true); // useUTC
}

/**
 * Build a VCALENDAR `METHOD:REPLY` carrying ONLY the replying attendee's
 * PARTSTAT (RFC 5546 §3.2.3). Never echoes other attendees — that would leak
 * the guest list. To be sent to the ORGANIZER only.
 */
export function buildReply(input: BuildReplyInput): string {
  const vc = new ICAL.Component(["vcalendar", [], []]);
  vc.addPropertyWithValue("version", "2.0");
  vc.addPropertyWithValue("prodid", input.prodId ?? "-//Doota//Calendar//EN");
  vc.addPropertyWithValue("method", "REPLY");

  const ve = new ICAL.Component("vevent");
  vc.addSubcomponent(ve);
  ve.addPropertyWithValue("uid", input.uid);
  ve.addPropertyWithValue("sequence", input.sequence);
  ve.addPropertyWithValue("dtstamp", icalUtcStamp(input.dtstampMs ?? Date.now()));
  if (input.recurrenceId) ve.addPropertyWithValue("recurrence-id", input.recurrenceId);
  if (input.summary) ve.addPropertyWithValue("summary", input.summary);

  const org = ve.addPropertyWithValue("organizer", `mailto:${input.organizerEmail}`);
  if (input.organizerName) org.setParameter("cn", input.organizerName);

  const att = ve.addPropertyWithValue("attendee", `mailto:${input.attendeeEmail}`);
  if (input.attendeeName) att.setParameter("cn", input.attendeeName);
  att.setParameter("partstat", input.partstat);

  return vc.toString();
}

export type BuildInviteAttendee = { email: string; name?: string | null; rsvp?: boolean };
export type BuildInviteInput = {
  /** Fresh `uuid@domain` (caller mints); SEQUENCE starts at 0. */
  uid: string;
  organizerEmail: string;
  organizerName?: string | null;
  attendees: BuildInviteAttendee[];
  summary: string;
  startMs: number;
  endMs?: number | null;
  allDay?: boolean;
  location?: string | null;
  description?: string | null;
  dtstampMs?: number;
  prodId?: string;
};

/**
 * Build a VCALENDAR `METHOD:REQUEST` (a new invite). Used by "create event"
 * later — validated + unit-tested now, no UI. SEQUENCE:0, the creator is the
 * ORGANIZER, every attendee is NEEDS-ACTION + RSVP=TRUE.
 */
export function buildInvite(input: BuildInviteInput): string {
  if (!input.attendees.length) throw new Error("buildInvite: at least one attendee required");
  const vc = new ICAL.Component(["vcalendar", [], []]);
  vc.addPropertyWithValue("version", "2.0");
  vc.addPropertyWithValue("prodid", input.prodId ?? "-//Doota//Calendar//EN");
  vc.addPropertyWithValue("method", "REQUEST");

  const ve = new ICAL.Component("vevent");
  vc.addSubcomponent(ve);
  ve.addPropertyWithValue("uid", input.uid);
  ve.addPropertyWithValue("sequence", 0);
  ve.addPropertyWithValue("dtstamp", icalUtcStamp(input.dtstampMs ?? Date.now()));
  ve.addPropertyWithValue("summary", input.summary);

  const dtstart = input.allDay
    ? ICAL.Time.fromDateString(new Date(input.startMs).toISOString().slice(0, 10))
    : icalUtcStamp(input.startMs);
  ve.addProperty(new ICAL.Property("dtstart")).setValue(dtstart);
  if (input.endMs != null) {
    const dtend = input.allDay
      ? ICAL.Time.fromDateString(new Date(input.endMs).toISOString().slice(0, 10))
      : icalUtcStamp(input.endMs);
    ve.addProperty(new ICAL.Property("dtend")).setValue(dtend);
  }
  if (input.location) ve.addPropertyWithValue("location", input.location);
  if (input.description) ve.addPropertyWithValue("description", input.description);

  const org = ve.addPropertyWithValue("organizer", `mailto:${input.organizerEmail}`);
  if (input.organizerName) org.setParameter("cn", input.organizerName);
  for (const a of input.attendees) {
    const att = ve.addPropertyWithValue("attendee", `mailto:${a.email}`);
    if (a.name) att.setParameter("cn", a.name);
    att.setParameter("partstat", "NEEDS-ACTION");
    att.setParameter("role", "REQ-PARTICIPANT");
    if (a.rsvp !== false) att.setParameter("rsvp", "TRUE");
  }
  return vc.toString();
}
