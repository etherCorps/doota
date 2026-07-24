// SPDX-License-Identifier: Apache-2.0
/**
 * Inline `data:` image handling for outbound HTML. The composer embeds pasted /
 * inserted images as base64 `data:` URIs (see tiptap-editor). Cloudflare Email
 * Sending strips `data:` srcs, so the image never reaches the recipient — we
 * convert each to an INLINE CID attachment and rewrite the src to `cid:<id>`.
 */

export type InlineImage = {
  filename: string;
  contentType: string;
  content: ArrayBuffer;
  contentId: string;
};

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

// src="data:<mime>;base64,<payload>" or src='...' — capture mime + payload.
const DATA_IMG = /src\s*=\s*(["'])data:([^;"']+);base64,([^"']*)\1/gi;

function toArrayBuffer(base64: string): ArrayBuffer {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Extract base64 `data:` images from html into inline attachments and rewrite
 * their src to `cid:<id>`. Returns the rewritten html and the attachments to add
 * to the outbound email. No data images → html unchanged, empty list.
 */
export function extractInlineImages(html: string | null | undefined): {
  html: string | null | undefined;
  images: InlineImage[];
} {
  if (!html) return { html, images: [] };
  const images: InlineImage[] = [];
  let n = 0;
  const out = html.replace(DATA_IMG, (_m, quote: string, mime: string, payload: string) => {
    const contentType = mime.trim().toLowerCase();
    let content: ArrayBuffer;
    try {
      content = toArrayBuffer(payload);
    } catch {
      return _m; // not decodable — leave as-is rather than drop the img
    }
    const contentId = `img${++n}-${crypto.randomUUID()}`;
    images.push({
      contentId,
      contentType,
      content,
      filename: `image-${n}.${EXT[contentType] ?? "bin"}`,
    });
    return `src=${quote}cid:${contentId}${quote}`;
  });
  return { html: out, images };
}
