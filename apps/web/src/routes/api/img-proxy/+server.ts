// SPDX-License-Identifier: Apache-2.0
import { error, type RequestHandler } from "@sveltejs/kit";
import { isBlockedHost } from "$lib/server/ssrf";
import { verifyResourceToken } from "$lib/server/resource-token.js";

/**
 * Privacy proxy for remote email images. Fetching a tracking pixel directly from
 * the browser hands the sender the reader's IP, UA, and read timestamp — the whole
 * point of a pixel. When the user opts in to images, the sanitized body route
 * rewrites remote <img src> to this same-origin endpoint, so the fetch happens
 * server-side and the sender only ever sees Cloudflare.
 *
 * Because it fetches an attacker-controlled URL, it is a classic SSRF surface —
 * hence the private/link-local blocklist (re-checked after every redirect), the
 * scheme + content-type allowlist, and the size/redirect/time caps.
 */

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 8000;

function validate(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    error(400, "Bad image URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") error(400, "Unsupported scheme");
  if (isBlockedHost(u.hostname)) error(400, "Blocked host");
  return u;
}

export const GET: RequestHandler = async ({ url, locals, platform }) => {
  const target = url.searchParams.get("url");
  if (!target) error(400, "Missing url");
  // Never an open proxy: a session, OR a signed token the body route minted for
  // THIS exact url (the sandboxed MailFrame sends no session cookie cross-site).
  const okToken = await verifyResourceToken(platform?.env?.MAIL_SEARCH_KEY, `img:${target}`, url.searchParams.get("t"));
  if (!okToken && !locals.user) error(401, "Not authenticated");

  // Shared edge cache keyed on the TARGET url only: the bytes are identical for
  // every reader (the per-user gate is the auth check above, which always runs
  // first). One upstream fetch then serves all opens/users — and the sender
  // stops seeing repeat opens, the Gmail/Apple caching behaviour.
  // From the platform context (App.Platform.caches), not the bare `caches` global
  // — the global is absent under `vite dev` and a bare reference throws.
  const cache = platform?.caches?.default;
  const cacheKey = new Request(`https://img-proxy.internal/${encodeURIComponent(target)}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let current = validate(target);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetch(current.href, {
        method: "GET",
        redirect: "manual", // follow by hand so each hop is re-validated
        signal: controller.signal,
        // No cookies (Workers don't attach any) and no Referer leaks the reader.
        headers: { Accept: "image/*,font/*;q=0.9,application/font-woff;q=0.8,*/*;q=0.1", "Accept-Encoding": "identity" },
        referrerPolicy: "no-referrer",
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) error(502, "Bad redirect");
        current = validate(new URL(loc, current.href).href); // re-check the hop
        continue;
      }
      break;
    }
    if (!res || !res.ok) error(502, "Image fetch failed");

    // Trust the RESPONSE type, not the request — must be an image OR a web font
    // (custom @font-face). Nothing else: the sandboxed frame renders these as
    // inert pixels/glyphs, never executes them. Fonts served as octet-stream are
    // rejected (fail closed → text falls back to system fonts).
    const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const OK_CT = /^(?:image\/|font\/|application\/(?:font-woff|x-font-(?:woff2?|ttf|otf|opentype|truetype)|vnd\.ms-fontobject))/;
    if (!OK_CT.test(ct)) error(415, "Unsupported content type");
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_BYTES) error(413, "Image too large");

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) error(413, "Image too large");

    const out = new Response(buf, {
      headers: {
        "Content-Type": ct,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Referrer-Policy": "no-referrer",
        // Public in the SHARED cache (keyed on url, gated by auth before lookup);
        // the browser copy stays private so a token URL isn't reused cross-user.
        "Cache-Control": "private, max-age=3600",
      },
    });
    if (cache) {
      // Store a copy the shared cache can serve for a day. Clone (the body is a
      // one-shot stream) and write the store with a longer TTL than the browser.
      const stored = new Response(buf, {
        headers: { "Content-Type": ct, "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=86400" },
      });
      const put = cache.put(cacheKey, stored);
      if (platform?.ctx?.waitUntil) platform.ctx.waitUntil(put);
      else await put;
    }
    return out;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") error(504, "Image fetch timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
};
