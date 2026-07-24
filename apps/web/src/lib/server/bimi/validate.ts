// SPDX-License-Identifier: Apache-2.0
/**
 * Cheap Tiny-PS + safety validation for uploaded BIMI logos, string checks only
 * (no SVG parser). This is a security boundary: the SVG is served from our own
 * origin, so no scripts, no event handlers, no external references. Returns an
 * error message or null when acceptable. The xmlns namespace URLs are the only
 * legitimate `http` occurrences, so bans target attribute/url positions rather
 * than the substring "http".
 */
export function svgProblem(text: string): string | null {
  const t = text.trim();
  if (!(t.startsWith("<?xml") || t.startsWith("<svg"))) return "Not an SVG document.";
  const lower = t.toLowerCase();
  if (!/baseprofile\s*=\s*["']tiny-ps["']/.test(lower))
    return 'BIMI requires SVG Tiny-PS: the root element needs baseProfile="tiny-ps".';
  if (!lower.includes("<title>")) return "SVG Tiny-PS requires a <title> element (your brand name).";
  if (lower.includes("<script")) return "Scripts are not allowed in a BIMI logo.";
  if (lower.includes("<foreignobject")) return "foreignObject is not allowed in SVG Tiny-PS.";
  if (lower.includes("<image")) return "Embedded images are not allowed in SVG Tiny-PS.";
  if (/\son[a-z]+\s*=/.test(lower)) return "Event handler attributes are not allowed.";
  if (lower.includes("javascript:")) return "javascript: URLs are not allowed.";
  if (/href\s*=\s*["']\s*(https?:|\/\/)/.test(lower) || /url\(\s*["']?\s*(https?:|\/\/)/.test(lower))
    return "External references are not allowed in SVG Tiny-PS (fonts, images, links).";
  if (lower.includes("@import")) return "@import is not allowed.";
  return null;
}
