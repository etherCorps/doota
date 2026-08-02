// SPDX-License-Identifier: Apache-2.0

/**
 * Decide what to do with a link clicked inside a message frame (Part D). Pure so
 * the phishing checks are unit-testable; the frame component turns a `warn` into a
 * confirm() and does the actual window.open / composer hand-off.
 */
export type LinkDecision =
  | { action: "mailto"; address: string }
  | { action: "open"; url: string; warn: string | null }
  | { action: "drop" };

/** The host a link's DISPLAY TEXT claims to point at, when the text is a bare
 * URL/domain (the phishing shape). Null when the text isn't a lone domain. */
export function textHostOf(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  const m = t.match(/^(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/i);
  return m ? m[1].toLowerCase() : null;
}

export function classifyMailLink(href: string, text = ""): LinkDecision {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { action: "drop" }; // unparseable / relative
  }
  const scheme = u.protocol.toLowerCase();
  if (scheme === "mailto:") return { action: "mailto", address: decodeURIComponent(u.pathname) };
  if (scheme !== "http:" && scheme !== "https:") return { action: "drop" }; // javascript:, data:, file:, …

  const host = u.hostname.toLowerCase(); // URL already IDNA-encodes to punycode
  const isIdn = host.split(".").some((label) => label.startsWith("xn--"));
  const claimed = textHostOf(text);
  const mismatch = !!claimed && claimed !== host && !host.endsWith(`.${claimed}`) && !claimed.endsWith(`.${host}`);
  const warn = mismatch
    ? `The link text says "${claimed}" but it actually goes to ${host}.`
    : isIdn
      ? `${host} uses internationalized (non-ASCII) characters that can imitate a real domain.`
      : null;
  return { action: "open", url: u.href, warn };
}
