// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { withSignature } from "$lib/mail/signature";

describe("withSignature", () => {
  const sig = "<p>Alice — Acme</p>";
  it("appends to a non-empty body with a spacer", () => {
    expect(withSignature("<p>Hi there</p>", sig)).toBe(`<p>Hi there</p><p></p>${sig}`);
  });
  it("returns the signature alone for an empty body (new message)", () => {
    expect(withSignature("", sig)).toBe(sig);
    expect(withSignature("   ", sig)).toBe(sig);
  });
  it("no signature → body unchanged", () => {
    expect(withSignature("<p>Hi</p>", "")).toBe("<p>Hi</p>");
    expect(withSignature("<p>Hi</p>", "   ")).toBe("<p>Hi</p>");
  });
});
