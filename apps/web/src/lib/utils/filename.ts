// SPDX-License-Identifier: Apache-2.0

// Bidi overrides + zero-width direction marks (U+202A-202E, U+2066-2069, U+200E/F,
// U+061C). Used to make "evil<RLO>gpj.exe" render as "evilexe.jpg". Built via
// RegExp(string) so the source stays ASCII.
const BIDI = new RegExp("[\\u202A-\\u202E\\u2066-\\u2069\\u200E\\u200F\\u061C]", "g");
// C0/C1 control characters (incl. CR/LF that would split a header).
const CONTROLS = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F]", "g");

/**
 * Neutralize a hostile attachment filename for both display and the download
 * header: strip bidi overrides + control chars, collapse to a bare basename
 * (no path separators / traversal), and fall back to "attachment".
 */
export function sanitizeFilename(name: string | null | undefined): string {
  if (!name) return "attachment";
  const stripped = name.replace(BIDI, "").replace(CONTROLS, "");
  // Basename before quoting separators, so a\b\c → c (not a_b_c).
  const base = stripped.split(/[/\\]/).pop() ?? "";
  const clean = base.replace(/^\.+/, "").replace(/["\\]/g, "_").trim();
  return clean || "attachment";
}

/**
 * Split a (sanitized) filename for display so truncation can eat the middle
 * and keep the extension visible. The extension is the trust signal
 * (`Quarterly-report…xlsx`, never `Quarterly-report-fin…`). Extensions longer
 * than 8 chars are treated as part of the base (not a real extension).
 */
export function splitExt(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || name.length - dot > 9) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}
