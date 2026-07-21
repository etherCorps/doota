import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/server/auth/escape-hatches.js", () => ({
  tokenStore: { issue: vi.fn(), consume: vi.fn() },
  setUserAuthFlags: vi.fn(),
}));
vi.mock("$lib/server/auth/repository.js", () => ({ getUserForRecovery: vi.fn() }));
vi.mock("$lib/server/mailer.js", () => ({ sendMail: vi.fn() }));
vi.mock("$lib/server/email.js", () => ({
  renderEmail: vi.fn(() => ({ subject: "s", text: "t", html: "h" })),
}));

import { sendRecoveryEmailVerification, verifyRecoveryEmailToken } from "$lib/server/recovery-email.js";
import { tokenStore, setUserAuthFlags } from "$lib/server/auth/escape-hatches.js";
import { getUserForRecovery } from "$lib/server/auth/repository.js";
import { sendMail } from "$lib/server/mailer.js";

beforeEach(() => vi.clearAllMocks());

describe("sendRecoveryEmailVerification", () => {
  it("issues a namespaced token and mails the recovery address", async () => {
    await sendRecoveryEmailVerification("u1", "r@ext.com", { name: "n", email: "e@x" });
    const [identifier, value] = vi.mocked(tokenStore.issue).mock.calls[0];
    expect(identifier).toMatch(/^recovery-email:/);
    expect(JSON.parse(value)).toEqual({ userId: "u1", email: "r@ext.com" });
    expect(sendMail).toHaveBeenCalledOnce();
    expect(vi.mocked(sendMail).mock.calls[0][0].to).toBe("r@ext.com");
  });
});

describe("verifyRecoveryEmailToken", () => {
  it("false for an unknown/expired token", async () => {
    vi.mocked(tokenStore.consume).mockResolvedValueOnce(null);
    expect(await verifyRecoveryEmailToken("bad")).toBe(false);
    expect(setUserAuthFlags).not.toHaveBeenCalled();
  });

  it("verifies and flips the flag when the address still matches", async () => {
    vi.mocked(tokenStore.consume).mockResolvedValueOnce({
      value: JSON.stringify({ userId: "u1", email: "r@ext.com" }),
    });
    vi.mocked(getUserForRecovery).mockResolvedValueOnce({
      id: "u1",
      email: "m@acme.com",
      recoveryEmail: "r@ext.com",
    });
    expect(await verifyRecoveryEmailToken("tok")).toBe(true);
    expect(setUserAuthFlags).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ recoveryEmailVerified: true }),
    );
  });

  it("false (stale token) when the recovery address changed after the link was sent", async () => {
    vi.mocked(tokenStore.consume).mockResolvedValueOnce({
      value: JSON.stringify({ userId: "u1", email: "OLD@ext.com" }),
    });
    vi.mocked(getUserForRecovery).mockResolvedValueOnce({
      id: "u1",
      email: "m@acme.com",
      recoveryEmail: "NEW@ext.com",
    });
    expect(await verifyRecoveryEmailToken("tok")).toBe(false);
    expect(setUserAuthFlags).not.toHaveBeenCalled();
  });

  it("false when the user no longer exists", async () => {
    vi.mocked(tokenStore.consume).mockResolvedValueOnce({
      value: JSON.stringify({ userId: "gone", email: "r@ext.com" }),
    });
    vi.mocked(getUserForRecovery).mockResolvedValueOnce(null);
    expect(await verifyRecoveryEmailToken("tok")).toBe(false);
  });
});
