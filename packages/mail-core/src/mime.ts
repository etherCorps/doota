// SPDX-License-Identifier: Apache-2.0
import PostalMime from "postal-mime";
import { getDecryptedBlob, packBlob, unpackBlob, type ContentKey, type R2Like } from "./crypto";

/**
 * Bump on ANY change to how a message body is parsed/derived, or (in the web
 * render-cache) sanitized, framed, or served. Baked into the shared body-html
 * edge-cache key here AND the render ETag (render-cache.ts re-exports this), so
 * one bump invalidates every cached copy globally on its next use.
 */
export const RENDER_CACHE_VERSION = "14";

export type CacheLike = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

const bodyHtmlCacheKey = (msgId: string) => new Request(`https://body-cache.internal/${RENDER_CACHE_VERSION}/${msgId}`);

/**
 * Parsed HTML (+ text fallback) for a message's R2 raw — shared by the render
 * route and the forward composer so both read the same cached parse. A shared
 * edge cache (caches.default) holds the parsed HTML as ciphertext keyed by
 * (version, message), so the R2 GET + postal-mime parse runs once per message
 * globally, not again per view or per forward. `cache` is optional (absent in
 * dev / where the Cache API isn't bound) → falls back to a direct R2 read.
 */
export async function messageRawHtml(
  bucket: R2Like,
  ck: ContentKey,
  msg: { id: string; r2RawKey: string | null },
  cache?: CacheLike | null,
): Promise<{ html: string | null; text: string | null }> {
  if (!msg.r2RawKey) return { html: null, text: null };
  const cacheKey = cache ? bodyHtmlCacheKey(msg.id) : null;
  if (cache && cacheKey) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      try {
        const html = new TextDecoder().decode(await unpackBlob(ck, new Uint8Array(await hit.arrayBuffer()))) || null;
        if (html) return { html, text: null };
      } catch {
        /* corrupt / legacy entry → re-derive below */
      }
    }
  }
  const bytes = await getDecryptedBlob(bucket, msg.r2RawKey, ck);
  if (!bytes) return { html: null, text: null };
  const html = await rawObjectToHtml(msg.r2RawKey, bytes);
  const text = html === null ? await rawObjectToText(msg.r2RawKey, bytes) : null;
  if (cache && cacheKey && html !== null) {
    const enc = await packBlob(ck, new TextEncoder().encode(html));
    await cache.put(cacheKey, new Response(enc as BodyInit, { headers: { "Cache-Control": "private, max-age=86400" } }));
  }
  return { html, text };
}

/**
 * Derive the HTML body from an R2 raw object. The HTML body isn't stored in D1
 * (raw is canonical; large bodies aren't duplicated into the hot DB) — the render
 * route reads the raw from R2 and parses it here on demand.
 *
 * Two raw shapes, distinguished by key prefix:
 *   - inbound:  RFC822 MIME bytes (postal-mime parses it, same as at ingest).
 *   - outbound: our own sent mail, stored as JSON `{ text, html }` under
 *     `outbound/…` (outbound.ts writes it; outbound-consumer reads the twin).
 */
export async function rawObjectToHtml(key: string, bytes: ArrayBuffer | Uint8Array): Promise<string | null> {
  if (key.startsWith("outbound/")) {
    try {
      const j = JSON.parse(new TextDecoder().decode(bytes)) as { html?: string | null };
      return j.html ?? null;
    } catch {
      return null;
    }
  }
  const parsed = await PostalMime.parse(bytes);
  return parsed.html ?? null;
}

/**
 * Derive the plain-text body from an R2 raw object — the text twin for a
 * text-only message (no HTML part). Same reasoning as `rawObjectToHtml`: the D1
 * `body_*_enc` columns are bounded hot-path previews (see materialize.ts), so
 * full-fidelity text for a very long message comes from R2, not the (capped) DB
 * column. Two raw shapes, same as rawObjectToHtml.
 */
export async function rawObjectToText(key: string, bytes: ArrayBuffer | Uint8Array): Promise<string | null> {
  if (key.startsWith("outbound/")) {
    try {
      const j = JSON.parse(new TextDecoder().decode(bytes)) as { text?: string | null };
      return j.text ?? null;
    } catch {
      return null;
    }
  }
  const parsed = await PostalMime.parse(bytes);
  return parsed.text ?? null;
}
