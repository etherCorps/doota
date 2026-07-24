// SPDX-License-Identifier: Apache-2.0
import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Outbound rate limiting (Part G) over the DB-backed windowed-counter pattern.
 * A compromised account or a reply loop must not be able to torch the domain's
 * reputation, so caps apply per-mailbox AND per-instance before any provider
 * call. Counts EXTERNAL recipients (the reputation-bearing volume), not messages.
 *
 * ponytail: bump-then-check. The upsert increment is atomic per row; the
 * read-back can let two concurrent sends overshoot the cap by a little. That errs
 * toward blocking (never under-counting), which is the safe direction for abuse
 * control — swap for a reserved-token scheme only if exactness ever matters.
 */

const WINDOW_MS = 60 * 60 * 1000; // 1 hour rolling bucket
// ponytail: static caps. Lift to per-org config / env if a tenant needs headroom.
const PER_MAILBOX_CAP = 500;
const PER_INSTANCE_CAP = 5000;

function windowStart(now: number): Date {
  return new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS);
}

async function bumpAndRead(
  db: Db,
  scope: string,
  scopeKey: string,
  n: number,
  ws: Date,
): Promise<number> {
  await db
    .insert(mail.sendCounter)
    .values({ scope, scopeKey, windowStart: ws, count: n })
    .onConflictDoUpdate({
      target: [mail.sendCounter.scope, mail.sendCounter.scopeKey, mail.sendCounter.windowStart],
      set: { count: sql`${mail.sendCounter.count} + ${n}` },
    });
  const row = await db.query.sendCounter.findFirst({
    where: and(
      eq(schema.sendCounter.scope, scope),
      eq(schema.sendCounter.scopeKey, scopeKey),
      eq(schema.sendCounter.windowStart, ws),
    ),
    columns: { count: true },
  });
  return row?.count ?? n;
}

export type RateLimitResult = { ok: true } | { ok: false; scope: "mailbox" | "instance" };

/**
 * Charge `count` external recipients against the mailbox + instance windows.
 * Returns not-ok (with which cap tripped) when either is exceeded.
 */
export async function chargeSend(
  db: Db,
  mailboxId: string,
  count: number,
): Promise<RateLimitResult> {
  if (count <= 0) return { ok: true };
  const ws = windowStart(Date.now());
  const mailboxCount = await bumpAndRead(db, "mailbox", mailboxId, count, ws);
  if (mailboxCount > PER_MAILBOX_CAP) return { ok: false, scope: "mailbox" };
  const instanceCount = await bumpAndRead(db, "instance", "instance", count, ws);
  if (instanceCount > PER_INSTANCE_CAP) return { ok: false, scope: "instance" };
  return { ok: true };
}
