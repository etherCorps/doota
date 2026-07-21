import { and, count, desc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { importKey, decryptContent } from "./crypto.js";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Shared load for the mailbox management surface (admin detail page + the
 * manager-facing app route). Returns null for a missing or personal mailbox;
 * callers apply their own authorization on the returned `orgId`.
 */
export async function loadMailboxDetail(db: Db, mailboxId: string, dek: string | undefined) {
  const box = await db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, mailboxId),
    columns: {
      id: true,
      orgId: true,
      address: true,
      displayName: true,
      isActive: true,
      isPersonal: true,
      isService: true,
      createdAt: true,
    },
  });
  if (!box || box.isPersonal) return null;

  const members = await db
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(eq(schema.member.organizationId, box.orgId));

  const grants = await db
    .select({
      userId: schema.mailboxAccess.userId,
      canManage: schema.mailboxAccess.canManage,
      canSend: schema.mailboxAccess.canSend,
    })
    .from(schema.mailboxAccess)
    .where(eq(schema.mailboxAccess.mailboxId, box.id));

  const placementRows = await db
    .select({ placement: schema.threadState.placement, n: count() })
    .from(schema.threadState)
    .where(eq(schema.threadState.mailboxId, box.id))
    .groupBy(schema.threadState.placement);
  const counts = Object.fromEntries(placementRows.map((r) => [r.placement, r.n])) as Record<
    string,
    number
  >;

  const recentRows = await db
    .select({
      id: schema.message.id,
      from: schema.message.fromAddr,
      subjectEnc: schema.message.subjectEnc,
      at: schema.message.sentAt,
    })
    .from(schema.delivery)
    .innerJoin(schema.message, eq(schema.message.id, schema.delivery.messageId))
    .where(eq(schema.delivery.mailboxId, box.id))
    .orderBy(desc(schema.message.sentAt))
    .limit(5);

  const ck = dek ? await importKey(dek) : null;
  const recent = await Promise.all(
    recentRows.map(async (m) => ({
      id: m.id,
      from: m.from,
      subject: ck ? await decryptContent(ck, m.subjectEnc) : null,
      at: m.at ? m.at.getTime() : null,
    })),
  );

  return {
    orgId: box.orgId,
    mailbox: { ...box, createdAt: box.createdAt ? box.createdAt.getTime() : null },
    members,
    grants,
    activity: {
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      recent,
    },
  };
}

/** True if the user holds a can_manage grant on this mailbox. */
export async function isMailboxManager(db: Db, userId: string, mailboxId: string): Promise<boolean> {
  const row = await db.query.mailboxAccess.findFirst({
    where: and(
      eq(schema.mailboxAccess.userId, userId),
      eq(schema.mailboxAccess.mailboxId, mailboxId),
      eq(schema.mailboxAccess.canManage, true),
    ),
    columns: { id: true },
  });
  return !!row;
}
