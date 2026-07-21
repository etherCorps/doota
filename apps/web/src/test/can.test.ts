import { describe, it, expect, vi, beforeEach } from "vitest";
import { can, type Actor, type Target } from "@doota/db/can";

// can() logs denials; silence it so test output stays clean.
beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));

const member: Actor = { id: "u-mem", role: "member", orgAdminOf: [] };
const superadmin: Actor = { id: "u-super", role: "superadmin" };
const orgAdmin: Actor = { id: "u-adm", role: "admin", orgAdminOf: ["org-1"] };

const mailboxIn = (owner: string, org?: string): Target => ({
  type: "mailbox",
  ownerId: owner,
  organizationId: org,
});

describe("can() — send", () => {
  it("owner may send as themselves", () => {
    expect(can(member, "send", mailboxIn("u-mem"))).toBe(true);
  });
  it("explicitly granted sender may send", () => {
    expect(
      can(member, "send", { ...mailboxIn("someone"), grantedSenderIds: ["u-mem"] }),
    ).toBe(true);
  });
  it("superadmin may NOT send as someone else (sending is a mailbox capability, not a role)", () => {
    expect(can(superadmin, "send", mailboxIn("someone"))).toBe(false);
  });
  it("unrelated user may not send", () => {
    expect(can(member, "send", mailboxIn("someone"))).toBe(false);
  });
});

describe("can() — read/manage", () => {
  it("superadmin manages anything", () => {
    expect(can(superadmin, "manage", mailboxIn("someone", "org-x"))).toBe(true);
    expect(can(superadmin, "read", mailboxIn("someone"))).toBe(true);
  });
  it("org admin manages targets within an org they administer", () => {
    expect(can(orgAdmin, "manage", mailboxIn("someone", "org-1"))).toBe(true);
  });
  it("org admin may NOT manage targets in an org they don't administer", () => {
    expect(can(orgAdmin, "manage", mailboxIn("someone", "org-2"))).toBe(false);
  });
  it("owner may read/manage their own target", () => {
    expect(can(member, "manage", mailboxIn("u-mem"))).toBe(true);
  });
  it("non-owner non-admin is denied", () => {
    expect(can(member, "read", mailboxIn("someone", "org-1"))).toBe(false);
  });
});
