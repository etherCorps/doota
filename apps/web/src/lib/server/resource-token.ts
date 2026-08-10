// SPDX-License-Identifier: Apache-2.0
// Short-lived HMAC token that lets the sandboxed, opaque-origin MailFrame load
// same-origin image URLs. That iframe (sandbox without allow-same-origin) makes
// its subresource requests as `sec-fetch-site: cross-site`, so the SameSite
// session cookie isn't attached and the attachment / img-proxy endpoints 401.
// The authenticated body route (which already checked the user's access to the
// message) mints a token per image URL; the endpoints accept a valid token as an
// alternative to the session. The token authorizes one resource for a bounded
// window; it never grants session access.
//
// Keyed on MAIL_SEARCH_KEY (an existing server HMAC secret); the "resource"
// string is context-prefixed by the caller (e.g. `att:msg:<id>`, `img:<url>`).

const enc = new TextEncoder();
// Generous TTL: a rendered body is browser-cached and re-served via 304 (its
// baked-in token reused), so the token must outlive that cache. It only ever
// unlocks one image, and attachment ids are unguessable UUIDs.
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function b64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, msg: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
	return b64url(new Uint8Array(sig));
}

/** `<exp>.<sig>` where sig = HMAC(secret, `<resource>:<exp>`). `ttlMs`
 * overrides the image-default TTL — mailbox-export capability URLs are
 * minutes, not days. */
export async function signResourceToken(secret: string, resource: string, ttlMs = TTL_MS): Promise<string> {
	const exp = Date.now() + ttlMs;
	return `${exp}.${await hmac(secret, `${resource}:${exp}`)}`;
}

export async function verifyResourceToken(
	secret: string | undefined,
	resource: string,
	token: string | null | undefined,
): Promise<boolean> {
	if (!secret || !token) return false;
	const dot = token.indexOf(".");
	if (dot < 1) return false;
	const exp = Number(token.slice(0, dot));
	if (!Number.isFinite(exp) || exp < Date.now()) return false;
	const expected = await hmac(secret, `${resource}:${exp}`);
	const got = token.slice(dot + 1);
	// Constant-time compare (same length or reject).
	if (got.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
	return diff === 0;
}
