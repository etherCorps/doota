// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { newMailPushText } from "@doota/mail-core/notify";

// The push text is resolved from cleartext fields (sender + mailbox); the subject
// is encrypted at rest and deliberately never shown.
describe("newMailPushText", () => {
  it("name on top, address + mailbox below", () => {
    expect(newMailPushText("Alice Smith", "alice@ext.com", "Support")).toEqual({
      title: "Alice Smith",
      body: "alice@ext.com · to Support",
    });
  });
  it("no name → address is the title, mailbox below", () => {
    expect(newMailPushText(null, "alice@ext.com", "Support")).toEqual({
      title: "alice@ext.com",
      body: "to Support",
    });
  });
  it("name but no mailbox → address alone below", () => {
    expect(newMailPushText("Alice Smith", "alice@ext.com", null)).toEqual({
      title: "Alice Smith",
      body: "alice@ext.com",
    });
  });
  it("nothing known → safe fallbacks", () => {
    expect(newMailPushText(null, null, null)).toEqual({ title: "New message", body: "You have new mail" });
  });
  it("only a mailbox → generic title, mailbox below", () => {
    expect(newMailPushText(null, null, "Support")).toEqual({ title: "New message", body: "to Support" });
  });
});
