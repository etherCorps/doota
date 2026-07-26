// SPDX-License-Identifier: Apache-2.0
import { error, type RequestHandler } from "@sveltejs/kit";
import { isBlockedHost } from "$lib/server/ssrf";

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

export const GET: RequestHandler = async ({ url, locals }) => {
  // Authenticated only — never an open proxy.
  if (!locals.user) error(401, "Not authenticated");
  const target = url.searchParams.get("url");
  if (!target) error(400, "Missing url");

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
        headers: { Accept: "image/*", "Accept-Encoding": "identity" },
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

    // Trust the RESPONSE type, not the request — must actually be an image.
    const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!ct.startsWith("image/")) error(415, "Not an image");
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_BYTES) error(413, "Image too large");

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) error(413, "Image too large");

    return new Response(buf, {
      headers: {
        "Content-Type": ct,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") error(504, "Image fetch timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
};
