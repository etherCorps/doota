import { describe, it, expect, beforeEach } from "vitest";
import { fakeCtx, fakeDb, installEvent, clearEvent } from "./fakes";
import { getUserForRecovery } from "$lib/server/auth/repository.js";

beforeEach(() => clearEvent());

describe("getUserForRecovery", () => {
  it("returns the user's id/email/recoveryEmail when found", async () => {
    const { ctx } = fakeCtx();
    const f = fakeDb();
    installEvent(f.db, ctx);
    f.userFindFirst.mockResolvedValueOnce({
      id: "u1",
      email: "m@acme.com",
      recoveryEmail: "r@ext.com",
    });

    expect(await getUserForRecovery("u1")).toEqual({
      id: "u1",
      email: "m@acme.com",
      recoveryEmail: "r@ext.com",
    });
  });

  it("returns null when the user does not exist", async () => {
    const { ctx } = fakeCtx();
    const f = fakeDb();
    installEvent(f.db, ctx);
    f.userFindFirst.mockResolvedValueOnce(undefined);

    expect(await getUserForRecovery("gone")).toBeNull();
  });
});
