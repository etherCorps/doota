// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { unsubscribeUrlFor } from "@doota/mail-core/unsubscribe";

const ORIGIN = "https://mail.acme.test";

describe("unsubscribeUrlFor", () => {
  it("returns empty without an origin", () => {
    expect(unsubscribeUrlFor("", "a@b.com")).toBe("");
  });

  it("defaults to /unsubscribe on the request origin, appending email", () => {
    expect(unsubscribeUrlFor(ORIGIN, "a+b@c.com")).toBe(
      "https://mail.acme.test/unsubscribe?email=a%2Bb%40c.com",
    );
  });

  it("resolves a relative path override against the origin", () => {
    expect(unsubscribeUrlFor(ORIGIN, "a@b.com", "/unsub?e={email}")).toBe(
      "https://mail.acme.test/unsub?e=a%40b.com",
    );
  });

  it("appends email to a configured path that has a query but no {email}", () => {
    expect(unsubscribeUrlFor(ORIGIN, "a@b.com", "/unsub?src=mail")).toBe(
      "https://mail.acme.test/unsub?src=mail&email=a%40b.com",
    );
  });

  it("uses an absolute configured URL verbatim (external system)", () => {
    expect(unsubscribeUrlFor(ORIGIN, "a@b.com", "https://lists.x.com/u?e={email}")).toBe(
      "https://lists.x.com/u?e=a%40b.com",
    );
  });
});
