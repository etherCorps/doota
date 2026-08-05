// SPDX-License-Identifier: Apache-2.0
import { isHttpError } from "@sveltejs/kit";

/**
 * Pull a human message out of a caught value for a toast.
 *
 * Remote functions (query/command) reject with SvelteKit's `HttpError`, which
 * is NOT an `instanceof Error` — its message lives at `err.body.message`. So
 * the common `err instanceof Error ? err.message : fallback` silently drops
 * every server `error(status, "message")` and shows the generic fallback. This
 * covers HttpError, real Errors, and plain `{ message }` objects (e.g. some
 * client SDKs), falling back only when there's nothing usable.
 */
export function errorMessage(err: unknown, fallback: string): string {
  if (isHttpError(err)) {
    const message = err.body?.message;
    return typeof message === "string" && message ? message : fallback;
  }
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}
