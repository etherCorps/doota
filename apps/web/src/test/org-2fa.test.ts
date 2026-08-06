// SPDX-License-Identifier: Apache-2.0
// Phase C stop gate: an unenrolled member of a require_2fa org is BLOCKED past
// the grace deadline (prompted before it), enforced server-side; enrolling TOTP
// clears it; the mandate is 2FA-only for a member (no passkey required).
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { orgTwoFactorGate, getOnboardingStatus } from "$lib/server/onboarding";

let db: Awaited<ReturnType<typeof makeDb>>;
const NOW = Date.now();
const memberUser = { id: "u1", role: "member" as const, onboardedAt: NOW, twoFactorEnabled: false };

async function seed(require2fa: boolean, fromMs: number | null) {
  await db.insert(schema.organization).values({
    id: "o1", name: "Acme", slug: "acme", domain: "acme.com", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.user).values({
    id: "u1", name: "M", email: "m@acme.com", emailVerified: true,
    // A real onboarded member already has a verified recovery email — so the
    // ONLY step the org-2FA mandate can reopen is secure-account.
    recoveryEmail: "m@ext.com", recoveryEmailVerified: true,
    createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(schema.mailbox).values({
    id: "mb1", orgId: "o1", localPart: "m", address: "m@acme.com", isActive: true, isPersonal: true,
  });
  await db.insert(schema.mailboxAccess).values({ id: "acc1", userId: "u1", mailboxId: "mb1", canSend: true });
  await db.insert(schema.orgMailSettings).values({
    orgId: "o1", require2fa, require2faFrom: fromMs == null ? null : new Date(fromMs), updatedAt: new Date(),
  });
}

beforeEach(async () => {
  db = await makeDb();
});

describe("orgTwoFactorGate", () => {
  it("blocks an unenrolled member past the grace deadline", async () => {
    await seed(true, NOW - 1000); // deadline passed
    const gate = await orgTwoFactorGate(db, memberUser);
    expect(gate.kind).toBe("block");
  });

  it("only prompts (grace) before the deadline", async () => {
    await seed(true, NOW + 60_000); // deadline in the future
    const gate = await orgTwoFactorGate(db, memberUser);
    expect(gate.kind).toBe("grace");
    expect(gate.kind === "grace" && gate.deadline).toBe(NOW + 60_000);
  });

  it("is a no-op when the org does not require 2FA", async () => {
    await seed(false, null);
    expect((await orgTwoFactorGate(db, memberUser)).kind).toBe("none");
  });

  it("is a no-op once the member has enrolled TOTP (exempts the enrolled)", async () => {
    await seed(true, NOW - 1000);
    const enrolled = { ...memberUser, twoFactorEnabled: true };
    expect((await orgTwoFactorGate(db, enrolled)).kind).toBe("none");
  });

  it("resolves the org from the session's active org when given", async () => {
    await seed(true, NOW - 1000);
    // Pass the active org explicitly (multiSession per-active-org path).
    expect((await orgTwoFactorGate(db, memberUser, "o1")).kind).toBe("block");
  });
});

describe("getOnboardingStatus under an org-2FA block", () => {
  it("reopens secure-account for an onboarded member, requiring 2FA only (no passkey)", async () => {
    await seed(true, NOW - 1000);
    const blocked = await getOnboardingStatus(db, memberUser, true);
    expect(blocked.complete).toBe(false);
    const secure = blocked.steps.find((s) => s.id === "secure-account");
    expect(secure).toBeDefined();
    expect(secure?.done).toBe(false);

    // With TOTP enrolled, the member is complete WITHOUT a passkey.
    await db.update(schema.user).set({ twoFactorEnabled: true }).where(eq(schema.user.id, "u1"));
    const cleared = await getOnboardingStatus(db, { ...memberUser, twoFactorEnabled: true }, true);
    expect(cleared.complete).toBe(true);
  });
});
