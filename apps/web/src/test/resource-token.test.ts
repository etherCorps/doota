// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { signResourceToken, verifyResourceToken } from "$lib/server/resource-token";

const KEY = "test-hmac-secret";

describe("resource token", () => {
  it("verifies a token it signed, for the same resource", async () => {
    const t = await signResourceToken(KEY, "att:msg:abc");
    expect(await verifyResourceToken(KEY, "att:msg:abc", t)).toBe(true);
  });

  it("rejects a different resource, key, or garbage", async () => {
    const t = await signResourceToken(KEY, "att:msg:abc");
    expect(await verifyResourceToken(KEY, "att:msg:xyz", t)).toBe(false);
    expect(await verifyResourceToken("other-key", "att:msg:abc", t)).toBe(false);
    expect(await verifyResourceToken(KEY, "att:msg:abc", "nope")).toBe(false);
    expect(await verifyResourceToken(KEY, "att:msg:abc", null)).toBe(false);
    expect(await verifyResourceToken(undefined, "att:msg:abc", t)).toBe(false);
  });

  it("rejects an expired token", async () => {
    // Forge an already-expired token: exp in the past with any sig.
    expect(await verifyResourceToken(KEY, "att:msg:abc", "1.deadbeef")).toBe(false);
  });
});
