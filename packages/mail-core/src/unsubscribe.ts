// SPDX-License-Identifier: Apache-2.0
// Unsubscribe URL for outbound mail. The operator configures a deployment-level
// UNSUBSCRIBE_URL (their own unsubscribe/suppression system — Doota does not host
// one). It's exposed to templates as the {{ unsubscribe_url }} builtin and set as
// the List-Unsubscribe header. A `{email}` placeholder is replaced with the
// (URL-encoded) recipient so the target can identify who is unsubscribing.

/** Resolve the configured unsubscribe URL for a recipient. "" when unconfigured. */
export function unsubscribeUrlFor(base: string | undefined | null, email: string): string {
  if (!base) return "";
  return base.includes("{email}") ? base.replaceAll("{email}", encodeURIComponent(email)) : base;
}
