import { vi } from "vitest";
import { setRequestEvent } from "./stubs/app-server";

/** Fake Better Auth internal adapter + password hasher, all spied. */
export function fakeCtx() {
  const internalAdapter = {
    createUser: vi.fn(),
    linkAccount: vi.fn(),
    deleteUser: vi.fn(),
    createVerificationValue: vi.fn(),
    consumeVerificationValue: vi.fn(),
    updateUser: vi.fn(),
  };
  const ctx = {
    internalAdapter,
    password: { hash: vi.fn(async (p: string) => `hashed:${p}`) },
  };
  return { ctx, internalAdapter };
}

/**
 * Chainable Drizzle double that records calls. Exposes the inner spies so tests
 * can assert which table was hit and with what payload.
 */
export function fakeDb() {
  const setWhere = vi.fn(async () => undefined);
  const set = vi.fn(() => ({ where: setWhere }));
  const update = vi.fn(() => ({ set }));

  const deleteWhere = vi.fn(async () => undefined);
  const del = vi.fn(() => ({ where: deleteWhere }));

  const values = vi.fn(async () => undefined);
  const insert = vi.fn(() => ({ values }));

  const findFirst = vi.fn(); // verification
  const userFindFirst = vi.fn();

  const db = {
    query: {
      verification: { findFirst },
      user: { findFirst: userFindFirst },
    },
    update,
    delete: del,
    insert,
  };
  return { db, update, set, setWhere, del, deleteWhere, insert, values, findFirst, userFindFirst };
}

/** Install a fake request event so boundary reqCtx() sees the given db + ctx.
 * better-auth's `auth.$context` is a promise property (awaited), not a function. */
export function installEvent(db: unknown, ctx: unknown) {
  setRequestEvent({ locals: { db, auth: { $context: Promise.resolve(ctx) } } });
}

export function clearEvent() {
  setRequestEvent(undefined);
}
