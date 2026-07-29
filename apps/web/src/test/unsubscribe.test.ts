// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { unsubscribeUrlFor } from "@doota/mail-core/unsubscribe";

describe("unsubscribeUrlFor", () => {
  it("returns empty when unconfigured", () => {
    expect(unsubscribeUrlFor(undefined, "a@b.com")).toBe("");
    expect(unsubscribeUrlFor("", "a@b.com")).toBe("");
    expect(unsubscribeUrlFor(null, "a@b.com")).toBe("");
  });

  it("substitutes {email} (URL-encoded), all occurrences", () => {
    expect(unsubscribeUrlFor("https://x/u?e={email}&r={email}", "a+b@c.com")).toBe(
      "https://x/u?e=a%2Bb%40c.com&r=a%2Bb%40c.com",
    );
  });

  it("uses the base as-is when there's no placeholder", () => {
    expect(unsubscribeUrlFor("https://x/unsub", "a@b.com")).toBe("https://x/unsub");
  });
});
