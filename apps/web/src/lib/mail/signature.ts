// SPDX-License-Identifier: Apache-2.0
// Composer-side signature injection. Kept pure + framework-free so it's unit
// testable; the composers call it when building the INITIAL editor HTML for a
// fresh compose/reply/forward (never on a draft restore — that body already
// carries whatever the user last saved, signature included).

/** Append a signature to composer body HTML. Empty signature → body unchanged.
 * A blank paragraph always sits above the signature so the caret lands on an
 * empty line and the signature reads as a footer — even on a new message, where
 * the body is empty (otherwise the signature would render at the very top with
 * nowhere to type above it). */
export function withSignature(body: string, sigHtml: string): string {
  const sig = sigHtml.trim();
  if (!sig) return body;
  return body.trim() ? `${body}<p></p>${sig}` : `<p></p>${sig}`;
}

/**
 * Swap the currently-applied signature for the new sender's, keeping the user's
 * text — for when the From mailbox changes mid-compose (every mail client does
 * this). `applied` is the exact signature HTML last injected; we strip it from
 * the tail (with or without the spacer) and re-append the next one.
 *
 * Returns the rebuilt body, `body` unchanged when the signature is identical, or
 * `null` when the applied signature can't be found — the user edited inside it,
 * so the caller skips the swap rather than corrupt their content. (Match is
 * exact-string: it holds while the editor round-trips the signature unchanged,
 * which covers the common "switch sender before touching the signature" flow.)
 */
export function swapSignature(body: string, applied: string, nextSigHtml: string): string | null {
  const next = nextSigHtml.trim();
  const prev = applied.trim();
  if (next === prev) return body;
  let base = body;
  if (prev) {
    const withSpacer = `<p></p>${prev}`;
    if (body.endsWith(withSpacer)) base = body.slice(0, -withSpacer.length);
    else if (body.endsWith(prev)) base = body.slice(0, -prev.length);
    else return null;
  }
  return withSignature(base, next);
}
