// SPDX-License-Identifier: Apache-2.0
// Composer-side signature injection. Kept pure + framework-free so it's unit
// testable; the composers call it when building the INITIAL editor HTML for a
// fresh compose/reply/forward (never on a draft restore — that body already
// carries whatever the user last saved, signature included).

/** Append a signature to composer body HTML. Empty signature → body unchanged;
 * empty body (new message) → signature alone. A blank paragraph separates the
 * user's text from the signature so the cursor sits above it. */
export function withSignature(body: string, sigHtml: string): string {
  const sig = sigHtml.trim();
  if (!sig) return body;
  return body.trim() ? `${body}<p></p>${sig}` : sig;
}
