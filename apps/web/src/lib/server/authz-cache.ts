// SPDX-License-Identifier: Apache-2.0
// 30s per-isolate memo over the two authz lookups the per-message binary routes
// hammer: opening a 20-message thread fires 20 body/attachment fetches, each
// re-reading the same accessibleMailboxIds + org-admin rows from D1 before the
// browser cache warms. Staleness ceiling on a REVOKED grant is 30s in a warm
// isolate — accepted for these read-only endpoints; mutating paths and the
// thread/list reads keep querying fresh.

import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "@doota/db/schema";
import { accessibleMailboxIds } from "@doota/mail-core/mailbox";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import { TtlCache } from "$lib/server/ttl-cache.js";

type Db = DrizzleD1Database<typeof schema>;

const boxes = new TtlCache<string[]>(30_000);
const admin = new TtlCache<string[]>(30_000);

export async function cachedAccessibleMailboxIds(db: Db, userId: string): Promise<string[]> {
	const hit = boxes.get(userId);
	if (hit) return hit;
	const v = await accessibleMailboxIds(db, userId);
	boxes.set(userId, v);
	return v;
}

export async function cachedActorOrgAdminOf(db: Db, userId: string): Promise<string[]> {
	const hit = admin.get(userId);
	if (hit) return hit;
	const v = await actorOrgAdminOf(db, userId);
	admin.set(userId, v);
	return v;
}
