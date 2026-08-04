// SPDX-License-Identifier: Apache-2.0
import { query, command, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { getAuthz } from "$lib/server/authz.js";

/** Vacation auto-responder settings (build guide, Phase 4). Per mailbox; a
 * mailbox grant is the gate. The responder itself lives in mail-core
 * vacation.ts and runs at the inbound `vacation` stage. */

async function grantOn(mailboxId: string) {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  const box = await locals.db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, mailboxId),
    columns: { id: true, orgId: true },
  });
  if (!box) error(404, "Mailbox not found");
  const { mailboxIds } = await getAuthz();
  if (!mailboxIds.includes(mailboxId)) error(403, "You need access to this mailbox.");
  return { box, user: locals.user, db: locals.db };
}

export const vacationSettings = query(z.object({ mailboxId: z.string().min(1) }), async ({ mailboxId }) => {
  const { db } = await grantOn(mailboxId);
  const row = await db.query.mailboxVacation.findFirst({
    where: eq(schema.mailboxVacation.mailboxId, mailboxId),
  });
  return {
    enabled: row?.enabled ?? false,
    subject: row?.subject ?? "",
    bodyText: row?.bodyText ?? "",
    startsAt: row?.startsAt ? row.startsAt.getTime() : null,
    endsAt: row?.endsAt ? row.endsAt.getTime() : null,
    intervalDays: row?.intervalDays ?? 4,
  };
});

export const setVacationSettings = command(
  z.object({
    mailboxId: z.string().min(1),
    enabled: z.boolean(),
    subject: z.string().trim().max(200).default(""),
    bodyText: z.string().max(10_000).default(""),
    startsAt: z.number().int().positive().nullable().default(null),
    endsAt: z.number().int().positive().nullable().default(null),
    intervalDays: z.number().int().min(1).max(30).default(4),
  }),
  async (input) => {
    const { box, user, db } = await grantOn(input.mailboxId);
    if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) {
      error(400, "End must be after start.");
    }
    const values = {
      mailboxId: input.mailboxId,
      orgId: box.orgId,
      enabled: input.enabled,
      // The reply is authorized as whoever last configured the responder.
      enabledByUserId: user.id,
      subject: input.subject,
      bodyText: input.bodyText,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      intervalDays: input.intervalDays,
      updatedAt: new Date(),
    };
    await db
      .insert(mail.mailboxVacation)
      .values(values)
      .onConflictDoUpdate({ target: mail.mailboxVacation.mailboxId, set: values });
    return { ok: true as const };
  },
);
