// SPDX-License-Identifier: Apache-2.0
/**
 * Signature detection + contact-field extraction (build guide, Phase 3).
 * Locating the block is a DIFF, not NLP: the longest common line-suffix
 * across 3+ messages from one sender — repeated verbatim trailing lines ARE
 * the signature. Extraction is limited to high-precision structural fields
 * (phone / url / email / handles); title and company are deliberately
 * skipped. Everything here is pure and side-effect free: callers surface
 * results as SUGGESTIONS only — nothing is written without an explicit tap.
 */

const TAIL_LINES = 15;
export const MIN_SIGNATURE_SAMPLES = 3;

const normalize = (line: string) => line.replace(/\s+/g, " ").trim();

/**
 * Longest common suffix of lines across the given message texts, looking at
 * each message's last ~15 lines. Needs >= 3 samples; returns null when there
 * is no repeated non-empty trailing block.
 */
export function signatureSuffix(texts: string[], minSamples = MIN_SIGNATURE_SAMPLES): string[] | null {
  const samples = texts
    .map((t) => t.split(/\r?\n/).slice(-TAIL_LINES).map(normalize))
    .filter((lines) => lines.some((l) => l.length > 0));
  if (samples.length < minSamples) return null;

  const shortest = Math.min(...samples.map((s) => s.length));
  const suffix: string[] = [];
  for (let back = 1; back <= shortest; back++) {
    const line = samples[0][samples[0].length - back];
    if (samples.every((s) => s[s.length - back] === line)) suffix.unshift(line);
    else break;
  }
  while (suffix.length && suffix[0] === "") suffix.shift();
  return suffix.some((l) => l.length > 0) ? suffix : null;
}

/** Split plain text at the standard `-- ` delimiter line (RFC 3676 usage).
 * Returns null when no delimiter — callers fall back to signatureSuffix. */
export function splitAtSigDelimiter(text: string): { body: string; signature: string } | null {
  const match = text.match(/\r?\n-- ?\r?\n/);
  if (!match || match.index === undefined) return null;
  return {
    body: text.slice(0, match.index),
    signature: text.slice(match.index + match[0].length),
  };
}

export type ExtractedContactFields = {
  phones: string[];
  urls: string[];
  emails: string[];
  handles: string[]; // @name social handles
};

const PHONE_RE = /(?:(?<=^)|(?<=[\s:|(]))\+?[\d(][\d\s().-]{6,18}\d/g;
const URL_RE = /https?:\/\/[^\s<>"')]+|(?:www\.)[^\s<>"')]+/gi;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const HANDLE_RE = /(?:(?<=^)|(?<=\s))@[a-z0-9_]{2,30}\b/gi;

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()))].filter(Boolean).slice(0, 5);
}

/** High-precision fields only. A phone match must be mostly digits (kills
 * dates and ids); handles exclude email local parts (consumed by EMAIL_RE
 * first is not possible in one pass, so emails are stripped before handles). */
export function extractContactFields(lines: string[]): ExtractedContactFields {
  const text = lines.join("\n");
  const emails = dedupe((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()));
  let scrubbed = text;
  for (const email of emails) scrubbed = scrubbed.split(email).join(" ");
  const phones = dedupe(
    (text.match(PHONE_RE) ?? []).filter(
      (p) =>
        (p.match(/\d/g)?.length ?? 0) >= 7 &&
        // Not an ISO date / date-like run — the classic false positive.
        !/^\d{4}-\d{2}-\d{2}$/.test(p.trim()) &&
        !/^\d{2}[./-]\d{2}[./-]\d{4}$/.test(p.trim()),
    ),
  );
  const urls = dedupe((scrubbed.match(URL_RE) ?? []).map((u) => u.replace(/[.,;]$/, "")));
  const handles = dedupe(scrubbed.match(HANDLE_RE) ?? []);
  return { phones, urls, emails, handles };
}
