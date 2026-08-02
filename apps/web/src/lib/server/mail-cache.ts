// SPDX-License-Identifier: Apache-2.0
// KV read-caches for the hot, rarely-changing mail lookups (same philosophy as
// $lib/server/authz.ts): KV in front of D1, short TTL, explicit delete at every
// mutation site so a change shows up immediately (same-PoP) instead of riding
// out the TTL. Cross-PoP the ceiling is the TTL — all three datasets tolerate
// that (render preference, composer identity list, signatures).
//
//  - remote-content policy  rcp:v1:{orgId}   — read on EVERY message render
//    (a 20-message thread = 20 body fetches); changes via one admin toggle.
//  - send identities        ids:v1:{userId}  — 5 D1 queries per composer open.
//  - mailbox signatures     sig:v1:{userId}  — read per compose/reply open.
//
// Deliberately TTL-covered (no explicit invalidation): org-wide flips whose
// fan-out would touch every org user — the subaddressing toggle and org
// lifecycle (suspend/activate). Both only affect identity *availability* flags;
// the send path re-validates via resolveSender server-side, so ≤5min of
// stale display can't authorize anything.
import { getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import * as mail from "@doota/db/mail.schema";
import { orgRemoteContentPolicy, type RemoteContentPolicy } from "@doota/mail-core/sender-trust";
import { listSendIdentities, type SendIdentity } from "@doota/mail-core/identities";

const TTL_S = 300;

/** KV-or-load: request-event-scoped access to AUTH_KV; absent KV (dev) = plain load. */
export async function kvCached<T>(key: string, load: () => Promise<T>, valid: (v: unknown) => v is T): Promise<T> {
  const { platform } = getRequestEvent();
  const kv = platform?.env?.AUTH_KV;
  if (kv) {
    try {
      const hit = await kv.get(key, "json");
      if (valid(hit)) return hit;
    } catch {
      /* KV failure → D1 */
    }
  }
  const v = await load();
  if (kv) {
    // waitUntil (invoked on ctx, per the CF pattern): the response never blocks
    // on the cache write; absent ctx (dev) the put still runs fire-and-forget.
    const put = kv.put(key, JSON.stringify(v), { expirationTtl: TTL_S }).catch(() => {});
    platform?.ctx?.waitUntil(put);
  }
  return v;
}

async function kvDelete(...keys: string[]): Promise<void> {
  const kv = getRequestEvent().platform?.env?.AUTH_KV;
  if (!kv) return;
  await Promise.all(keys.map((key) => kv.delete(key).catch(() => {})));
}

// ---- Org remote-content policy ---------------------------------------------

export function cachedRemoteContentPolicy(orgId: string): Promise<RemoteContentPolicy> {
  const { locals } = getRequestEvent();
  return kvCached(
    `rcp:v1:${orgId}`,
    () => orgRemoteContentPolicy(locals.db, orgId),
    (v): v is RemoteContentPolicy => !!v && typeof (v as RemoteContentPolicy).mode === "string",
  );
}

/** Call after setOrgRemoteContent saves. */
export function invalidateRemoteContentPolicy(orgId: string): Promise<void> {
  return kvDelete(`rcp:v1:${orgId}`);
}

// ---- Send identities (current user) ----------------------------------------

export function cachedSendIdentities(): Promise<SendIdentity[]> {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  const userId = locals.user.id;
  return kvCached(`ids:v1:${userId}`, () => listSendIdentities(locals.db, userId), Array.isArray);
}

// ---- Per-user invalidation ---------------------------------------------------

/** Drop a user's cached identities + signatures — call when their grant set,
 * their mailboxes' aliases, or their signatures change. */
export function invalidateUserMailCache(userId: string): Promise<void> {
  return kvDelete(`ids:v1:${userId}`, `sig:v1:${userId}`);
}

/** Alias/mailbox-level change: every grant holder's identity list is stale.
 * Personal mailboxes (the only alias carriers) have 1–2 holders, so the
 * fan-out is tiny. */
export async function invalidateMailboxHolders(mailboxId: string): Promise<void> {
  const { locals } = getRequestEvent();
  const holders = await locals.db
    .select({ userId: mail.mailboxAccess.userId })
    .from(mail.mailboxAccess)
    .where(eq(mail.mailboxAccess.mailboxId, mailboxId));
  await Promise.all(holders.map((holder) => invalidateUserMailCache(holder.userId)));
}
