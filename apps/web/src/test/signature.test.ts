// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { withSignature, swapSignature } from "$lib/mail/signature";

describe("withSignature", () => {
  const sig = "<p>Alice — Acme</p>";
  it("appends to a non-empty body with a spacer", () => {
    expect(withSignature("<p>Hi there</p>", sig)).toBe(`<p>Hi there</p><p></p>${sig}`);
  });
  it("puts a blank line above the signature for an empty body (caret sits on top)", () => {
    expect(withSignature("", sig)).toBe(`<p></p>${sig}`);
    expect(withSignature("   ", sig)).toBe(`<p></p>${sig}`);
  });
  it("no signature → body unchanged", () => {
    expect(withSignature("<p>Hi</p>", "")).toBe("<p>Hi</p>");
    expect(withSignature("<p>Hi</p>", "   ")).toBe("<p>Hi</p>");
  });
});

describe("swapSignature", () => {
  const a = "<p>Alice — Acme</p>";
  const b = "<p>Bob — Beta</p>";

  it("swaps the trailing signature, keeping the user's text", () => {
    expect(swapSignature(`<p>Hi</p><p></p>${a}`, a, b)).toBe(`<p>Hi</p><p></p>${b}`);
  });
  it("swaps on an empty-body compose (blank line + signature)", () => {
    expect(swapSignature(`<p></p>${a}`, a, b)).toBe(`<p></p>${b}`);
  });
  it("switching to a mailbox with no signature removes it", () => {
    expect(swapSignature(`<p>Hi</p><p></p>${a}`, a, "")).toBe("<p>Hi</p>");
  });
  it("switching from no-signature appends the new one", () => {
    expect(swapSignature("<p>Hi</p>", "", b)).toBe(`<p>Hi</p><p></p>${b}`);
  });
  it("identical signature is a no-op (alias change on the same mailbox)", () => {
    expect(swapSignature(`<p>Hi</p><p></p>${a}`, a, a)).toBe(`<p>Hi</p><p></p>${a}`);
  });
  it("returns null when the applied signature was edited away (don't corrupt)", () => {
    expect(swapSignature("<p>Hi</p><p></p><p>edited sig</p>", a, b)).toBeNull();
  });
});
