// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { linkifySegments } from "$lib/utils/linkify";

describe("linkifySegments", () => {
  it("splits URLs out of prose and trims trailing punctuation", () => {
    const segs = linkifySegments("see https://example.com/x. done");
    expect(segs).toEqual([
      { type: "text", value: "see " },
      { type: "link", value: "https://example.com/x", href: "https://example.com/x" },
      { type: "text", value: ". done" },
    ]);
  });

  it("prefixes bare www. with https://", () => {
    const segs = linkifySegments("www.example.com");
    expect(segs).toEqual([{ type: "link", value: "www.example.com", href: "https://www.example.com" }]);
  });

  it("keeps balanced parens, trims unbalanced", () => {
    expect(linkifySegments("https://en.wikipedia.org/wiki/A_(b)")[0]).toMatchObject({
      value: "https://en.wikipedia.org/wiki/A_(b)",
    });
    expect(linkifySegments("(see https://example.com)")[1]).toMatchObject({ value: "https://example.com" });
  });

  it("recognizes emails as mailto segments", () => {
    const segs = linkifySegments("mail bob@x.com now");
    expect(segs[1]).toEqual({ type: "email", value: "bob@x.com", address: "bob@x.com" });
  });

  it("plain text passes through untouched", () => {
    expect(linkifySegments("no links here")).toEqual([{ type: "text", value: "no links here" }]);
  });
});
