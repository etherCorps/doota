import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { error } from "@sveltejs/kit";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { grantedUserIds } from "./mailbox";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Assignment + system events (Task 5). System events are persisted ONLY for
 * genuinely shared mailboxes (>1 access grant); a personal mailbox emits none,
 * so the solo experience gains no timeline noise.
 */

export type SystemEventDTO = {
  id: string;
  actorUserId: string | null;
  eventType: string;
  data: Record<string, unknown>;
  createdAt: number;
};

/** A mailbox is "shared" when more than one user holds access to it. */
export async function isSharedMailbox(db: Db, mailboxId: string): Promise<boolean> {
  const ids = await grantedUserIds(db, mailboxId);
  return ids.length > 1;
}

async function emitEvent(
  db: Db,
  input: {
    orgId: string;
    threadId: string;
    mailboxId: string;
    actorUserId: string;
    eventType: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(mail.systemEvent).values({
    orgId: input.orgId,
    threadId: input.threadId,
    mailboxId: input.mailboxId,
    actorUserId: input.actorUserId,
    eventType: input.eventType,
    data: JSON.stringify(input.data ?? {}),
  });
}

/**
 * Assign / reassign / unassign a thread within a mailbox (per mailbox — the same
 * thread in two mailboxes can have different assignees). Assignee must hold
 * mailbox_access. Emits a system event on shared mailboxes only.
 */
export async function assignThread(
  db: Db,
  input: {
    orgId: string;
    threadId: string;
    mailboxId: string;
    assigneeUserId: string | null;
    actorUserId: string;
  },
): Promise<void> {
  if (input.assigneeUserId) {
    const grants = await grantedUserIds(db, input.mailboxId);
    if (!grants.includes(input.assigneeUserId)) {
      error(400, "The assignee must have access to this mailbox.");
    }
  }
  const updated = await db
    .update(mail.threadState)
    .set({ assigneeUserId: input.assigneeUserId })
    .where(
      and(
        eq(mail.threadState.threadId, input.threadId),
        eq(mail.threadState.mailboxId, input.mailboxId),
      ),
    )
    .returning({ id: mail.threadState.id });
  if (!updated[0]) error(404, "Thread is not in this mailbox.");

  if (await isSharedMailbox(db, input.mailboxId)) {
    await emitEvent(db, {
      orgId: input.orgId,
      threadId: input.threadId,
      mailboxId: input.mailboxId,
      actorUserId: input.actorUserId,
      eventType: input.assigneeUserId ? "assigned" : "unassigned",
      data: { assigneeUserId: input.assigneeUserId },
    });
  }
}

/**
 * Emit a placement-change event (archived/unarchived by a user). Shared mailboxes
 * only. Called by the triage move path AFTER the placement has changed.
 */
export async function emitPlacementEvent(
  db: Db,
  input: {
    orgId: string;
    threadId: string;
    mailboxId: string;
    actorUserId: string;
    fromPlacement: string;
    toPlacement: string;
  },
): Promise<void> {
  if (input.fromPlacement === input.toPlacement) return;
  if (!(await isSharedMailbox(db, input.mailboxId))) return;
  const eventType =
    input.toPlacement === "archived"
      ? "archived"
      : input.fromPlacement === "archived"
        ? "unarchived"
        : "placement_changed";
  await emitEvent(db, {
    orgId: input.orgId,
    threadId: input.threadId,
    mailboxId: input.mailboxId,
    actorUserId: input.actorUserId,
    eventType,
    data: { fromPlacement: input.fromPlacement, toPlacement: input.toPlacement },
  });
}

function safeObj(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** System events for a thread within a mailbox, oldest first. */
export async function listSystemEvents(
  db: Db,
  threadId: string,
  mailboxId: string,
): Promise<SystemEventDTO[]> {
  const rows = await db.query.systemEvent.findMany({
    where: and(
      eq(schema.systemEvent.threadId, threadId),
      eq(schema.systemEvent.mailboxId, mailboxId),
    ),
    orderBy: schema.systemEvent.createdAt,
  });
  return rows.map((r) => ({
    id: r.id,
    actorUserId: r.actorUserId,
    eventType: r.eventType,
    data: safeObj(r.data),
    createdAt: r.createdAt.getTime(),
  }));
}
