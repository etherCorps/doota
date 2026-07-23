import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { getOnboardingStatus, hasSecurityDebt } from "$lib/server/onboarding";

/**
 * The 2FA + passkey mandate for elevated roles. The incident this guards:
 * an admin enrolled a passkey but no TOTP — password sign-in never consults
 * passkeys, so bare credentials logged them in with no second factor.
 */

let db: Awaited<ReturnType<typeof makeDb>>;

async function seedAdmin(over: Partial<typeof schema.user.$inferInsert> = {}) {
  await db.insert(schema.user).values({
    id: "a1",
    name: "Admin",
    email: "admin@acme.com",
    emailVerified: true,
    role: "admin",
    recoveryEmail: "rescue@ext.com",
    recoveryEmailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
}

function addPasskey(userId: string) {
  return db.insert(schema.passkey).values({
    id: crypto.randomUUID(),
    publicKey: "pk",
    userId,
    credentialID: crypto.randomUUID(),
    counter: 0,
    deviceType: "multiDevice",
    backedUp: true,
  });
}

beforeEach(async () => {
  db = await makeDb();
});

describe("secure-account step — both factors mandatory for elevated roles", () => {
  it("passkey WITHOUT TOTP does not satisfy the step (the incident)", async () => {
    await seedAdmin({ twoFactorEnabled: false });
    await addPasskey("a1");
    const status = await getOnboardingStatus(db, { id: "a1", role: "admin" });
    expect(status.steps.find((s) => s.id === "secure-account")?.done).toBe(false);
    expect(status.complete).toBe(false);
  });

  it("TOTP WITHOUT a passkey does not satisfy the step either", async () => {
    await seedAdmin({ twoFactorEnabled: true });
    const status = await getOnboardingStatus(db, { id: "a1", role: "admin" });
    expect(status.steps.find((s) => s.id === "secure-account")?.done).toBe(false);
  });

  it("TOTP + passkey completes the step", async () => {
    await seedAdmin({ twoFactorEnabled: true });
    await addPasskey("a1");
    const status = await getOnboardingStatus(db, { id: "a1", role: "admin" });
    expect(status.steps.find((s) => s.id === "secure-account")?.done).toBe(true);
    expect(status.complete).toBe(true);
  });

  it("an already-onboarded admin with 2FA off is pulled back in (no fast path)", async () => {
    await seedAdmin({ twoFactorEnabled: false, onboardedAt: Date.now() });
    const user = { id: "a1", role: "admin", onboardedAt: Date.now(), twoFactorEnabled: false };
    expect(hasSecurityDebt(user)).toBe(true);
    const status = await getOnboardingStatus(db, user);
    expect(status.complete).toBe(false);
    expect(status.nextStep).toBe("secure-account");
  });

  it("members carry no security debt and no secure-account step", async () => {
    expect(hasSecurityDebt({ id: "m1", role: "member", twoFactorEnabled: false })).toBe(false);
    await seedAdmin({ id: "m1", email: "m@acme.com", role: "member" } as never);
    const status = await getOnboardingStatus(db, { id: "m1", role: "member" });
    expect(status.steps.some((s) => s.id === "secure-account")).toBe(false);
  });
});
