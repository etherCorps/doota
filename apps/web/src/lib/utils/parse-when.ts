// SPDX-License-Identifier: Apache-2.0
// Natural-language → Date for the composer's schedule picker. Covers the common
// phrasings (today/tomorrow, tonight, "next friday", "in 2 hours", "fri 5pm",
// "17:30") and falls back to Date.parse for ISO-ish input. Returns null when
// nothing resolves, so the caller leaves the field untouched.
//
// ponytail: deliberately a small heuristic parser, not a grammar. Covers the
// frequent cases; add chrono-node only if users hit its ceiling.

const WD: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/** Date → `YYYY-MM-DDTHH:mm` in local time (the datetime-local shape). */
export function toLocalDatetime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Resolve free text to a Date, relative to `now`. null = unparseable. */
export function parseWhen(input: string, now: Date = new Date()): Date | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;

  // "in N minutes/hours/days/weeks" — fully relative, time is implied.
  const rel = s.match(/\bin (\d+) ?(min|minute|hr|hour|day|week)s?\b/);
  if (rel) {
    const n = +rel[1];
    const u = rel[2];
    const d = new Date(now);
    d.setSeconds(0, 0);
    if (u.startsWith("min")) d.setMinutes(d.getMinutes() + n);
    else if (u.startsWith("h")) d.setHours(d.getHours() + n);
    else if (u === "day") d.setDate(d.getDate() + n);
    else d.setDate(d.getDate() + n * 7);
    return d;
  }

  const d = new Date(now);
  d.setSeconds(0, 0);
  let dayMatched = false;

  // ---- day ----
  const next = /\bnext\b/.test(s);
  const wdKey = Object.keys(WD).find((k) => new RegExp(`\\b${k}\\b`).test(s));
  if (/\btoday\b|\btonight\b/.test(s)) {
    dayMatched = true;
  } else if (/\btomorrow\b|\btmrw?\b/.test(s)) {
    d.setDate(d.getDate() + 1);
    dayMatched = true;
  } else if (wdKey) {
    // Nearest future occurrence (same weekday → next week, never today).
    let ahead = ((WD[wdKey] - d.getDay() + 7) % 7) || 7;
    if (next) ahead += 7; // "next friday" = the week after the coming one
    d.setDate(d.getDate() + ahead);
    dayMatched = true;
  }

  // ---- time ----
  let timeMatched = false;
  const t = s.match(/\b(\d{1,2})(?::(\d{2}))? ?(am|pm)\b/) || s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (t) {
    let h = +t[1];
    const min = t[2] ? +t[2] : 0;
    const ap = t[3];
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h < 24 && min < 60) {
      d.setHours(h, min, 0, 0);
      timeMatched = true;
    }
  } else if (/\bnoon\b/.test(s)) {
    d.setHours(12, 0, 0, 0);
    timeMatched = true;
  } else if (/\bmidnight\b/.test(s)) {
    d.setHours(0, 0, 0, 0);
    timeMatched = true;
  } else if (/\bmorning\b/.test(s)) {
    d.setHours(9, 0, 0, 0);
    timeMatched = true;
  } else if (/\bafternoon\b/.test(s)) {
    d.setHours(14, 0, 0, 0);
    timeMatched = true;
  } else if (/\btonight\b|\bevening\b|\bnight\b/.test(s)) {
    d.setHours(18, 0, 0, 0);
    timeMatched = true;
  } else if (dayMatched) {
    d.setHours(9, 0, 0, 0); // a day with no time → 9am
    timeMatched = true;
  }

  if (dayMatched || timeMatched) {
    // A bare time already past today rolls to tomorrow ("5pm" at 6pm).
    if (!dayMatched && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d;
  }

  // Fallback: let the engine try ISO / locale strings.
  const parsed = new Date(input);
  return isNaN(parsed.getTime()) ? null : parsed;
}
