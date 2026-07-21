import { describe, it, expect } from "vitest";
import { extractInlineImages } from "../lib/server/mail/inline-images";

// 1x1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("extractInlineImages", () => {
  it("converts a data: image to an inline CID attachment and rewrites the src", () => {
    const html = `<p>hi</p><img src="data:image/png;base64,${PNG}" alt="x">`;
    const { html: out, images } = extractInlineImages(html);
    expect(images).toHaveLength(1);
    expect(images[0].contentType).toBe("image/png");
    expect(images[0].filename).toMatch(/\.png$/);
    expect(images[0].content.byteLength).toBeGreaterThan(0);
    // src now points at the generated cid, not the data URI.
    expect(out).toContain(`src="cid:${images[0].contentId}"`);
    expect(out).not.toContain("data:image/png");
  });

  it("leaves html without data images untouched", () => {
    const html = `<p>plain <img src="https://x.com/a.png"></p>`;
    const { html: out, images } = extractInlineImages(html);
    expect(images).toHaveLength(0);
    expect(out).toBe(html);
  });

  it("handles null/undefined", () => {
    expect(extractInlineImages(null)).toEqual({ html: null, images: [] });
    expect(extractInlineImages(undefined)).toEqual({ html: undefined, images: [] });
  });
});
