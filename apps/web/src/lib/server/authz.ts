// SPDX-License-Identifier: Apache-2.0
// The caller's authz snapshot — the two lookups nearly every RPC/route pays
// (accessible mailbox ids + org-admin orgs) — served through three layers:
//
//   1. request memo (locals): one request never runs the same lookup twice,
//      and concurrent callers within the request share one promise.
//   2. KV (AUTH_KV, `authz:v1:{userId}`, 60s TTL): cross-request cache.
//      Explicitly deleted on grant/membership changes (invalidateAuthz), so the
//      staleness ceiling after a revocation is KV's cross-PoP propagation
//      (≤60s worst case; same-PoP sees the delete immediately). Accepted —
//      matches the old 30s per-isolate memo philosophy, but global and with
//      real invalidation.
//   3. D1 (authoritative).
//
// Mutating paths that must NOT tolerate staleness (rare) can keep calling the
// D1 helpers directly — this is the default read path, not a mandate.
import { error } from "@sveltejs/kit";
import { getRequestEvent } from "$app/server";
import { accessibleMailboxIds } from "@doota/mail-core/mailbox";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";

export type Authz = {
  /** Mailboxes the user holds a grant on (mailboxAccess rows). */
  mailboxIds: string[];
  /** Orgs where the user is an owner/admin member (feeds can()). */
  orgAdminOf: string[];
};

const KV_TTL_S = 60; // KV's minimum expirationTtl — also the revocation ceiling.
const kvKey = (userId: string) => `authz:v1:${userId}`;

function isAuthz(v: unknown): v is Authz {
  const a = v as Authz | null;
  return !!a && Array.isArray(a.mailboxIds) && Array.isArray(a.orgAdminOf);
}

/** The current user's authz snapshot (memoized per request, KV-cached 60s). */
export function getAuthz(): Promise<Authz> {
  const { locals, platform } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  if (locals.authz) return locals.authz;
  const userId = locals.user.id;
  const kv = platform?.env?.AUTH_KV;
  const waitUntil = platform?.ctx?.waitUntil?.bind(platform.ctx);
  locals.authz = (async (): Promise<Authz> => {
    if (kv) {
      try {
        const hit = await kv.get(kvKey(userId), "json");
        if (isAuthz(hit)) return hit;
      } catch {
        /* KV read failure → fall through to D1 */
      }
    }
    const [mailboxIds, orgAdminOf] = await Promise.all([
      accessibleMailboxIds(locals.db, userId),
      actorOrgAdminOf(locals.db, userId),
    ]);
    const snapshot: Authz = { mailboxIds, orgAdminOf };
    if (kv) {
      const put = kv.put(kvKey(userId), JSON.stringify(snapshot), { expirationTtl: KV_TTL_S }).catch(() => {});
      if (waitUntil) waitUntil(put);
    }
    return snapshot;
  })();
  return locals.authz;
}

/** Drop a user's cached snapshot — call after ANY grant/membership change for
 * that user (mailbox grant/revoke, org member add/remove/role change). Also
 * clears the current request's memo in case it targets the caller themself. */
export async function invalidateAuthz(userId: string): Promise<void> {
  const { locals, platform } = getRequestEvent();
  if (locals.user?.id === userId) locals.authz = undefined;
  await platform?.env?.AUTH_KV?.delete(kvKey(userId)).catch(() => {});
}
