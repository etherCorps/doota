// SPDX-License-Identifier: Apache-2.0
// Cache-validation for the sandboxed binary routes (message body, attachment
// bytes). These use `Cache-Control: private, no-cache` + an ETag: the browser
// stores the (expensive-to-produce) bytes but MUST revalidate before every use,
// so the server stays in control on every view — nothing is ever served from
// cache without our auth + freshness check running first.
//
// Why not max-age/immutable: those let the browser skip the server entirely,
// so a pushed security patch (a sanitizer fix, a CSP tightening, a revoked
// grant) can't reach an already-cached view until the TTL lapses. With
// no-cache, revalidation runs auth (a revoked user gets 403 on the next view)
// and compares the ETag — and bumping RENDER_CACHE_VERSION below changes every
// ETag at once, forcing every browser to refetch fresh bytes on its next view.
// No client redeploy, no waiting.

/**
 * Bump on ANY change to how message bodies or attachments are sanitized,
 * framed, or served — a sanitizer/security fix, a CSP change, a content-type
 * rule. Baked into every render ETag, so a bump invalidates all cached copies
 * globally on their next revalidation.
 */
export const RENDER_CACHE_VERSION = "3";

/** Weak ETag over the version + a per-resource key. Weak (`W/`) because a
 * re-render isn't guaranteed byte-identical (sanitizer output can vary), only
 * semantically current — which is all revalidation needs. */
export function renderETag(...parts: (string | number | boolean)[]): string {
	return `W/"${RENDER_CACHE_VERSION}:${parts.join(":")}"`;
}

/** True when the client's cached copy is still current (echoes our exact ETag).
 * Caller has already run auth, so a 304 never leaks access to a revoked user. */
export function isNotModified(request: Request, etag: string): boolean {
	return request.headers.get("If-None-Match") === etag;
}

/** Shared header set for these routes: cache privately, but always revalidate. */
export function revalidateHeaders(etag: string): Record<string, string> {
	return { "Cache-Control": "private, no-cache", ETag: etag };
}
