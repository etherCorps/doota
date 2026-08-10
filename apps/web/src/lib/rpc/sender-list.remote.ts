// SPDX-License-Identifier: Apache-2.0
import { query, command, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { getAuthz } from "$lib/server/authz.js";
import { addSenderListEntry, removeSenderListEntry } from "@doota/mail-core/spam";

/** Per-mailbox allow/block lists (build guide, Phase 5). Evaluated before the
 * spam classifier. The un-junk implicit allow also lands here. */

async function grantOn(mailboxId: string) {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  const { mailboxIds } = await getAuthz();
  if (!mailboxIds.includes(mailboxId)) error(403, "You need access to this mailbox.");
  return { db: locals.db };
}

export const senderLists = query(z.object({ mailboxId: z.string().min(1) }), async ({ mailboxId }) => {
  const { db } = await grantOn(mailboxId);
  const rows = await db.query.mailboxSenderList.findMany({
    where: eq(schema.mailboxSenderList.mailboxId, mailboxId),
    orderBy: asc(schema.mailboxSenderList.address),
  });
  return rows.map((r) => ({ id: r.id, address: r.address, kind: r.kind as "allow" | "block" }));
});

const entrySchema = z.object({
  mailboxId: z.string().min(1),
  // Full address or "@domain".
  address: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(320)
    .regex(/^(@[^\s@]+\.[^\s@]+|[^\s@]+@[^\s@]+\.[^\s@]+)$/, "Enter an address or @domain"),
  kind: z.enum(["allow", "block"]),
});

export const addSenderEntry = command(entrySchema, async ({ mailboxId, address, kind }) => {
  const { db } = await grantOn(mailboxId);
  await addSenderListEntry(db, { mailboxId, address, kind });
  return { ok: true as const };
});

export const removeSenderEntry = command(
  z.object({ mailboxId: z.string().min(1), address: z.string().trim().toLowerCase().min(3) }),
  async ({ mailboxId, address }) => {
    const { db } = await grantOn(mailboxId);
    await removeSenderListEntry(db, { mailboxId, address });
    return { ok: true as const };
  },
);
