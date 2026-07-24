// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as schema from "@doota/db/schema";
import { fakeCtx, fakeDb, installEvent, clearEvent } from "./fakes";

// invalidateDomainCache is a module-cache clear with real deps we don't want to
// load; mock it so setOrgLifecycle's call is observable (guards finding F1).
vi.mock("@doota/db/org-domains", () => ({ invalidateDomainCache: vi.fn() }));

import { invalidateDomainCache } from "@doota/db/org-domains";
import {
  tokenStore,
  throttleAllows,
  setUserAuthFlags,
  stampOnboarded,
  setOrgLifecycle,
  purgeUserMemberships,
  createGenesisSuperadmin,
} from "$lib/server/auth/escape-hatches.js";

beforeEach(() => {
  vi.clearAllMocks();
  clearEvent();
});

describe("tokenStore", () => {
  it("issue() writes a namespaced verification value with a future expiry", async () => {
    const { ctx, internalAdapter } = fakeCtx();
    installEvent(fakeDb().db, ctx);
    const before = Date.now();
    await tokenStore.issue("recovery-email:tok", "payload", 60_000);

    expect(internalAdapter.createVerificationValue).toHaveBeenCalledTimes(1);
    const arg = internalAdapter.createVerificationValue.mock.calls[0][0];
    expect(arg.identifier).toBe("recovery-email:tok");
    expect(arg.value).toBe("payload");
    expect(arg.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
  });

  it("consume() returns {value} when present, null when absent", async () => {
    const { ctx, internalAdapter } = fakeCtx();
    installEvent(fakeDb().db, ctx);

    internalAdapter.consumeVerificationValue.mockResolvedValueOnce({ value: "v1" });
    expect(await tokenStore.consume("id")).toEqual({ value: "v1" });

    internalAdapter.consumeVerificationValue.mockResolvedValueOnce(null);
    expect(await tokenStore.consume("id")).toBeNull();
  });

  it("peek() returns unexpired row shape or null", async () => {
    const { ctx } = fakeCtx();
    const f = fakeDb();
    installEvent(f.db, ctx);

    f.findFirst.mockResolvedValueOnce({ id: "r1", value: "c", extra: 1 });
    expect(await tokenStore.peek("id")).toEqual({ id: "r1", value: "c" });

    f.findFirst.mockResolvedValueOnce(undefined);
    expect(await tokenStore.peek("id")).toBeNull();
  });

  it("dropById / dropByIdentifier delete from the verification table", async () => {
    const { ctx } = fakeCtx();
    const f = fakeDb();
    installEvent(f.db, ctx);

    await tokenStore.dropById("r1");
    await tokenStore.dropByIdentifier("id");
    expect(f.del).toHaveBeenCalledTimes(2);
    expect(f.del).toHaveBeenCalledWith(schema.verification);
  });
});

describe("throttleAllows", () => {
  it("returns false and issues nothing when a live marker exists", async () => {
    const { ctx, internalAdapter } = fakeCtx();
    const f = fakeDb();
    installEvent(f.db, ctx);
    f.findFirst.mockResolvedValueOnce({ id: "r", value: "1" });

    expect(await throttleAllows("k", 60_000)).toBe(false);
    expect(internalAdapter.createVerificationValue).not.toHaveBeenCalled();
  });

  it("returns true and sets a marker when none exists", async () => {
    const { ctx, internalAdapter } = fakeCtx();
    const f = fakeDb();
    installEvent(f.db, ctx);
    f.findFirst.mockResolvedValueOnce(undefined);

    expect(await throttleAllows("k", 60_000)).toBe(true);
    expect(internalAdapter.createVerificationValue).toHaveBeenCalledOnce();
  });
});

describe("setUserAuthFlags", () => {
  it("updates the user via the internal adapter with exactly the given flags", async () => {
    const { ctx, internalAdapter } = fakeCtx();
    installEvent(fakeDb().db, ctx);

    await setUserAuthFlags("u1", { mustChangePassword: false });
    expect(internalAdapter.updateUser).toHaveBeenCalledWith("u1", {
      mustChangePassword: false,
    });
  });
});

describe("stampOnboarded", () => {
  it("sets onboardedAt via the internal adapter (keeps cached sessions coherent)", async () => {
    const { ctx, internalAdapter } = fakeCtx();
    await stampOnboarded({ $context: Promise.resolve(ctx) } as never, "u1");
    expect(internalAdapter.updateUser).toHaveBeenCalledWith("u1", {
      onboardedAt: expect.any(Number),
    });
  });
});

describe("setOrgLifecycle", () => {
  it("writes status only, then invalidates the domain cache (F1)", async () => {
    const { ctx } = fakeCtx();
    const f = fakeDb();
    installEvent(f.db, ctx);

    await setOrgLifecycle("org1", "pending_nameservers");
    expect(f.update).toHaveBeenCalledWith(schema.organization);
    expect(f.set).toHaveBeenCalledWith({ status: "pending_nameservers" });
    expect(invalidateDomainCache).toHaveBeenCalledOnce();
  });

  it("writes status + zoneId when a zone is provided", async () => {
    const { ctx } = fakeCtx();
    const f = fakeDb();
    installEvent(f.db, ctx);

    await setOrgLifecycle("org1", "active", "zone9");
    expect(f.set).toHaveBeenCalledWith({ status: "active", zoneId: "zone9" });
    expect(invalidateDomainCache).toHaveBeenCalledOnce();
  });
});

describe("purgeUserMemberships", () => {
  it("deletes from the member table", async () => {
    const { ctx } = fakeCtx();
    const f = fakeDb();
    installEvent(f.db, ctx);

    await purgeUserMemberships("u1");
    expect(f.del).toHaveBeenCalledWith(schema.member);
  });
});

describe("createGenesisSuperadmin", () => {
  it("creates the user + credential account and returns the id", async () => {
    const { ctx, internalAdapter } = fakeCtx();
    installEvent(fakeDb().db, ctx);
    internalAdapter.createUser.mockResolvedValueOnce({ id: "u1" });
    internalAdapter.linkAccount.mockResolvedValueOnce(undefined);

    const res = await createGenesisSuperadmin({
      name: "A",
      email: "a@ext.com",
      password: "pw",
    });
    expect(res).toEqual({ id: "u1" });
    expect(internalAdapter.linkAccount).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", password: "hashed:pw", providerId: "credential" }),
    );
    expect(internalAdapter.deleteUser).not.toHaveBeenCalled();
  });

  it("throws (no rollback) when createUser returns no user", async () => {
    const { ctx, internalAdapter } = fakeCtx();
    installEvent(fakeDb().db, ctx);
    internalAdapter.createUser.mockResolvedValueOnce(undefined);

    await expect(
      createGenesisSuperadmin({ name: "A", email: "a@ext.com", password: "pw" }),
    ).rejects.toThrow(/no user/i);
    expect(internalAdapter.linkAccount).not.toHaveBeenCalled();
    expect(internalAdapter.deleteUser).not.toHaveBeenCalled();
  });

  it("rolls back the user and rethrows when the password link fails", async () => {
    const { ctx, internalAdapter } = fakeCtx();
    installEvent(fakeDb().db, ctx);
    internalAdapter.createUser.mockResolvedValueOnce({ id: "u1" });
    internalAdapter.linkAccount.mockRejectedValueOnce(new Error("link failed"));

    await expect(
      createGenesisSuperadmin({ name: "A", email: "a@ext.com", password: "pw" }),
    ).rejects.toThrow("link failed");
    expect(internalAdapter.deleteUser).toHaveBeenCalledWith("u1");
  });
});
