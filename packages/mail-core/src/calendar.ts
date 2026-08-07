// SPDX-License-Identifier: Apache-2.0
/**
 * Dependency-free iCalendar (RFC 5545) parsing for inbound invites. Workers have
 * no Node; a small hand-rolled parser (like the sanitizer + bounce parser) beats
 * pulling ical.js/node-ical and its edge cases into the isolate. Scope is
 * DISPLAY + local RSVP, not a full calendar engine: we pull the first VEVENT out
 * of a VCALENDAR, its METHOD, times (resolved to real UTC instants via an Intl
 * offset probe so DST is correct), organizer/attendees, and the meeting join
 * URL. VTIMEZONE blocks are ignored — Intl already knows every IANA zone.
 *
 * iMIP REPLY (sending an RSVP back) is NOT here: the outbound provider can't emit
 * a `text/calendar; method=REPLY` part today (see provider.ts). RSVP is local
 * status + the provider's own embedded Yes/Maybe/No links (extractRsvpLinks).
 */

export type InviteAttendee = { email: string; name: string | null; partstat: string | null };
export type MeetingPlatform = "zoom" | "teams" | "meet" | "webex" | null;
export type CalOrigin = "google" | "microsoft" | "apple" | "other" | null;

/** The structural (cleartext-safe) half of a parsed invite — routing-ish metadata. */
export type ParsedInviteCore = {
  uid: string;
  method: string; // REQUEST | REPLY | CANCEL | PUBLISH
  status: string | null; // CONFIRMED | CANCELLED | TENTATIVE
  sequence: number;
  startMs: number;
  endMs: number | null;
  tz: string | null; // event timezone label (IANA) when the value carried a TZID
  allDay: boolean;
  organizer: { email: string | null; name: string | null };
  attendees: InviteAttendee[];
  meetingPlatform: MeetingPlatform;
  calOrigin: CalOrigin;
};

/** The sensitive free-text half — stored encrypted (like the message subject/body). */
export type InviteDetails = {
  summary: string | null;
  description: string | null;
  location: string | null;
  joinUrl: string | null;
};

export type ParsedInvite = ParsedInviteCore & InviteDetails;

type Prop = { name: string; params: Record<string, string>; value: string };

/** RFC 5545 §3.1 line unfolding: a CRLF followed by a space/tab continues the
 * previous line. Normalise CRLF/CR to LF first. */
function unfold(raw: string): string[] {
  const norm = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const out: string[] = [];
  for (const line of norm.split("\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** `NAME;PARAM=v;P2="q,v":VALUE` → parts. Params before the first unquoted colon. */
function parseLine(line: string): Prop | null {
  // Find the value colon — the first colon not inside a quoted param value.
  let i = 0;
  let inQuote = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const segs = head.split(";");
  const name = segs[0].toUpperCase();
  const params: Record<string, string> = {};
  for (const seg of segs.slice(1)) {
    const eq = seg.indexOf("=");
    if (eq === -1) continue;
    params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

/** Unescape iCalendar TEXT values (RFC 5545 §3.3.11). */
function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** Offset (ms) of an IANA zone at a UTC instant, via an Intl formatToParts probe. */
function zoneOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  // 24:00 (midnight) comes back as hour 24 in some engines — normalise.
  const hour = p.hour === 24 ? 0 : p.hour;
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, hour, p.minute, p.second);
  return asUTC - utcMs;
}

/** Wall-clock in an IANA zone → the true UTC instant (DST-correct via one refine). */
function wallClockToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  tz: string,
): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = zoneOffsetMs(guess, tz);
  // Refine once so a DST boundary (the offset changes across the guess) settles.
  const off2 = zoneOffsetMs(guess - off1, tz);
  return guess - off2;
}

/**
 * ICS date/date-time → { ms, tz, allDay }. Handles DATE (all-day, `20260801`),
 * UTC (`...Z`), TZID (`TZID=America/New_York`), and floating (no zone → treated
 * as UTC; the ceiling of a hand-rolled parser, and rare for real invites).
 */
export function icsDateToMs(value: string, tz: string | null): { ms: number; tz: string | null; allDay: boolean } | null {
  const v = value.trim();
  // All-day: YYYYMMDD, no time component.
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return { ms: Date.UTC(Number(y), Number(mo) - 1, Number(d)), tz: null, allDay: true };
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!dt) return null;
  const [, ys, mos, ds, hs, mis, ss, z] = dt;
  const y = Number(ys), mo = Number(mos), d = Number(ds), h = Number(hs), mi = Number(mis), s = Number(ss);
  if (z) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), tz: null, allDay: false };
  if (tz && isValidTz(tz)) return { ms: wallClockToUtc(y, mo, d, h, mi, s, tz), tz, allDay: false };
  // Floating (no Z, no/unknown TZID): best-effort as UTC.
  return { ms: Date.UTC(y, mo - 1, d, h, mi, s), tz: null, allDay: false };
}

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function mailtoAddr(v: string): string {
  return v.replace(/^mailto:/i, "").trim().toLowerCase();
}

const JOIN_HOSTS: { re: RegExp; platform: Exclude<MeetingPlatform, null> }[] = [
  { re: /zoom\.us\/[jw]\//i, platform: "zoom" },
  { re: /teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/meet/i, platform: "teams" },
  { re: /meet\.google\.com\//i, platform: "meet" },
  { re: /\.webex\.com\//i, platform: "webex" },
];

/** First recognised meeting join URL in a blob (LOCATION / DESCRIPTION / X-props). */
function findJoinUrl(blob: string): { url: string; platform: MeetingPlatform } | null {
  const urls = blob.match(/https?:\/\/[^\s<>"]+/gi) ?? [];
  for (const raw of urls) {
    const url = raw.replace(/[),.]+$/, "");
    for (const { re, platform } of JOIN_HOSTS) if (re.test(url)) return { url, platform };
  }
  return null;
}

function detectOrigin(prodId: string, organizerEmail: string | null): CalOrigin {
  const p = prodId.toLowerCase();
  if (p.includes("google")) return "google";
  if (p.includes("microsoft") || p.includes("exchange") || p.includes("outlook")) return "microsoft";
  if (p.includes("apple") || p.includes("mac os") || p.includes("icloud")) return "apple";
  // Match a DOMAIN COMPONENT, not a bare substring — "acme.com" must not read as
  // Apple via the "me.com" substring. Anchor each to a start/dot boundary + end.
  const dom = organizerEmail?.split("@")[1]?.toLowerCase() ?? "";
  if (/(^|\.)(google\.com|gmail\.com|googlemail\.com)$/.test(dom)) return "google";
  if (/(^|\.)(outlook\.com|hotmail\.com|live\.com|microsoft\.com|office365\.com)$/.test(dom))
    return "microsoft";
  if (/(^|\.)(icloud\.com|me\.com|mac\.com)$/.test(dom)) return "apple";
  return prodId ? "other" : null;
}

/**
 * Meeting platform + calendar origin from a PRODID, organizer address, and a
 * text blob (LOCATION/DESCRIPTION) to scan for a join URL. Shared by the ical.js
 * parser so both parsers agree on detection without duplicating the regexes.
 */
export function detectMeetingAndOrigin(
  prodId: string,
  organizerEmail: string | null,
  blob: string,
): { meetingPlatform: MeetingPlatform; calOrigin: CalOrigin } {
  return {
    meetingPlatform: findJoinUrl(blob)?.platform ?? null,
    calOrigin: detectOrigin(prodId, organizerEmail),
  };
}

/**
 * Parse the first VEVENT out of a VCALENDAR. Returns null when there's no event
 * (or no UID — an event we can't dedupe/RSVP is not worth surfacing).
 */
export function parseIcs(raw: string): ParsedInvite | null {
  if (!raw || !/BEGIN:VCALENDAR/i.test(raw)) return null;
  const lines = unfold(raw);
  let method = "REQUEST";
  let prodId = "";
  let inEvent = false;
  const ev: Prop[] = [];
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "METHOD" && !inEvent) method = p.value.trim().toUpperCase();
    else if (p.name === "PRODID" && !inEvent) prodId = p.value;
    else if (p.name === "BEGIN" && p.value.toUpperCase() === "VEVENT") inEvent = true;
    else if (p.name === "END" && p.value.toUpperCase() === "VEVENT") break; // first event only
    else if (inEvent) ev.push(p);
  }
  if (!ev.length) return null;

  const first = (name: string) => ev.find((p) => p.name === name);
  const uid = first("UID")?.value.trim();
  if (!uid) return null;

  const dtStart = first("DTSTART");
  const start = dtStart ? icsDateToMs(dtStart.value, dtStart.params.TZID ?? null) : null;
  if (!start) return null;
  const dtEnd = first("DTEND");
  const end = dtEnd ? icsDateToMs(dtEnd.value, dtEnd.params.TZID ?? null) : null;

  const org = first("ORGANIZER");
  const organizerEmail = org ? mailtoAddr(org.value) || null : null;
  const organizerName = org?.params.CN ?? null;

  const attendees: InviteAttendee[] = ev
    .filter((p) => p.name === "ATTENDEE")
    .map((p) => ({
      email: mailtoAddr(p.value),
      name: p.params.CN ?? null,
      partstat: p.params.PARTSTAT ?? null,
    }))
    .filter((a) => a.email);

  const summary = first("SUMMARY")?.value ? unescapeText(first("SUMMARY")!.value) : null;
  const location = first("LOCATION")?.value ? unescapeText(first("LOCATION")!.value) : null;
  const rawDesc = first("DESCRIPTION")?.value ? unescapeText(first("DESCRIPTION")!.value) : null;
  // Cap the description — some invites inline a full HTML agenda; we only need a preview.
  const description = rawDesc && rawDesc.length > 2000 ? rawDesc.slice(0, 2000) + "…" : rawDesc;

  // Join URL: dedicated conference props first (RFC 7986 CONFERENCE +
  // X-GOOGLE-CONFERENCE / X-MICROSOFT-*), only then scrape LOCATION/DESCRIPTION.
  const xUrls = ev
    .filter((p) => /^X-.*URL$|^URL$|^CONFERENCE$|^X-GOOGLE-CONFERENCE$|^X-MICROSOFT-SKYPETEAMSMEETINGURL$/i.test(p.name))
    .map((p) => p.value)
    .join(" ");
  const join = findJoinUrl([xUrls, location ?? "", rawDesc ?? ""].join("\n"));

  const seqRaw = first("SEQUENCE")?.value;
  const status = first("STATUS")?.value?.trim().toUpperCase() ?? null;

  return {
    uid,
    method,
    status,
    sequence: seqRaw ? Number(seqRaw) || 0 : 0,
    startMs: start.ms,
    endMs: end?.ms ?? null,
    tz: start.tz,
    allDay: start.allDay,
    organizer: { email: organizerEmail, name: organizerName },
    attendees,
    meetingPlatform: join?.platform ?? null,
    calOrigin: detectOrigin(prodId, organizerEmail),
    summary,
    description,
    location,
    joinUrl: join?.url ?? null,
  };
}

/**
 * Pull the raw ICS text out of a parsed message's parts. postal-mime surfaces a
 * `text/calendar` alternative AND an `invite.ics` file attachment both in
 * `attachments`; either is a valid source. Returns the decoded string of the
 * first calendar part, or null.
 */
export function findCalendarPart(
  parts: { mimeType?: string; filename?: string | null; content?: ArrayBuffer | string }[] | undefined,
): string | null {
  for (const p of parts ?? []) {
    const mime = (p.mimeType ?? "").toLowerCase();
    const isCal = mime === "text/calendar" || mime === "application/ics" || /\.ics$/i.test(p.filename ?? "");
    if (!isCal || p.content == null) continue;
    return typeof p.content === "string" ? p.content : new TextDecoder().decode(p.content);
  }
  return null;
}

export type RsvpLinks = { accepted: string | null; declined: string | null; tentative: string | null };

/**
 * The provider's OWN Yes/Maybe/No links, extracted from the invite HTML — lets a
 * user RSVP through Google/Microsoft's flow (which updates the organizer's
 * calendar) without us sending an iMIP reply. Google mail invites carry
 * `action=RESPOND&...&rst=N` anchors (rst 1=Yes 2=Maybe 3=No). Best-effort:
 * returns nulls when the pattern isn't found (Apple/Fastmail invites have none,
 * and there local status is the only option).
 */
export function extractRsvpLinks(html: string | null | undefined): RsvpLinks {
  const out: RsvpLinks = { accepted: null, declined: null, tentative: null };
  if (!html) return out;
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  for (const raw of hrefs) {
    const href = raw.replace(/&amp;/g, "&");
    const m = /[?&]action=RESPOND\b/i.test(href) && /[?&]rst=(\d)/i.exec(href);
    if (!m) continue;
    if (m[1] === "1" && !out.accepted) out.accepted = href;
    else if (m[1] === "2" && !out.tentative) out.tentative = href;
    else if (m[1] === "3" && !out.declined) out.declined = href;
  }
  return out;
}
