// SPDX-License-Identifier: Apache-2.0
import PostalMime from "postal-mime";

/**
 * Derive the HTML body from an R2 raw object. The HTML body is NOT stored in D1
 * (golden-standard: raw is canonical, large bodies aren't duplicated into the
 * hot DB) — the render route reads the raw from R2 and parses it here on demand.
 *
 * Two raw shapes, distinguished by key prefix:
 *   - inbound:  RFC822 MIME bytes (postal-mime parses it, same as at ingest).
 *   - outbound: our own sent mail, stored as JSON `{ text, html }` under
 *     `outbound/…` (outbound.ts writes it; outbound-consumer reads the twin).
 */
export async function rawObjectToHtml(key: string, bytes: ArrayBuffer): Promise<string | null> {
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
