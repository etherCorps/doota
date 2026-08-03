// SPDX-License-Identifier: Apache-2.0
import { getRequestEvent } from "$app/server";
import { ORIGINS } from "$app/env/public";

/**
 * Origin for absolute links that leave the app (invite/verification emails):
 * the origin the current request was served on, so multi-domain deployments
 * link each recipient to the host they actually use.
 *
 * Trust boundary: the request origin derives from the Host header, and these
 * links land in emails — an unvalidated value is host-header poisoning
 * (attacker-controlled recovery links). Only origins in the ORIGINS allowlist
 * are honored; anything else — and non-request contexts (background work) —
 * falls back to the canonical first entry.
 */
export function requestOrigin(): string {
  try {
    const { url } = getRequestEvent();
    if (ORIGINS.includes(url.origin)) return url.origin;
  } catch {
    // No request context (background/queue work) — canonical fallback below.
  }
  return ORIGINS[0];
}
