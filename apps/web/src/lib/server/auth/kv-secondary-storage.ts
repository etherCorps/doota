// SPDX-License-Identifier: Apache-2.0
/**
 * Cloudflare KV as Better Auth secondary storage — a fast, edge-local read cache
 * in front of the durable D1 store.
 *
 * D1 stays the source of truth: `session.storeSessionInDatabase` and
 * `verification.storeInDatabase` make Better Auth write sessions and verification
 * values to BOTH stores. Reads hit KV first and fall back to D1 on a miss, so
 * this is a cache, never the authority — revocation and single-use consumption
 * are enforced on D1 (consume deletes the KV copy), and KV's eventual consistency
 * (≤60s global propagation) only affects cache warmth, not correctness.
 *
 * Only get/set/delete are implemented. KV has no atomic increment or
 * get-and-delete, so the optional counter/consume ops are deliberately left off:
 * rate limiting stays on D1 (`rateLimit.storage: "database"`) where increments are
 * atomic, and the storeInDatabase consume path reads/deletes from D1 directly.
 */

const KV_MIN_TTL_SECONDS = 60; // Cloudflare KV rejects a shorter expirationTtl.

export function kvSecondaryStorage(kv: KVNamespace) {
  return {
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string, ttl?: number) => {
      await kv.put(
        key,
        value,
        // ttl is in seconds. Absent/zero → no expiry; otherwise floor at KV's 60s
        // minimum so a short throttle window doesn't get rejected by the API.
        ttl && ttl > 0
          ? { expirationTtl: Math.max(ttl, KV_MIN_TTL_SECONDS) }
          : undefined,
      );
    },
    delete: (key: string) => kv.delete(key),
  };
}
