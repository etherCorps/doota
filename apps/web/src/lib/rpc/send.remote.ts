import { command, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { can } from "@doota/db/can";
import { sendGrantUserIds } from "@doota/mail-core/mailbox";
import { enqueueSend, cancelSend, type OutboundEnv } from "@doota/mail-core/outbound";
import { deliverInBackground } from "$lib/server/mail/deliver-bridge.js";
import { resolveSender } from "@doota/mail-core/resolver";

/**
 * Send trigger surfaces (Part I). App-session sends go through these remote
 * functions, gated by can()'s mailbox SEND capability — the SAME check the API
 * key path and the consumer preflight use (no parallel permission path). No
 * compose UI here; this is the callable seam.
 */

const AddrList = z.array(z.email()).default([]);
const SendInput = z.object({
  mailboxId: z.string().min(1),
  fromAliasId: z.string().nullish(),
  to: AddrList,
  cc: AddrList,
  bcc: AddrList,
  subject: z.string().default(""),
  text: z.string().nullish(),
  html: z.string().nullish(),
  parentMessageId: z.string().nullish(),
  attachments: z
    .array(
      z.object({
        r2Key: z.string(),
        filename: z.string(),
        contentType: z.string(),
        size: z.number().nullish(),
      }),
    )
    .default([]),
  sendAt: z.number().nullish(),
  idempotencyKey: z.string().nullish(),
  undoSeconds: z.number().int().min(0).max(300).nullish(),
});

export type SendInput = z.infer<typeof SendInput>;

function outboundEnv(): OutboundEnv {
  const env = getRequestEvent().platform?.env;
  if (!env?.MAIL_DEK || !env?.MAIL_SEARCH_KEY || !env?.MAIL_RAW || !env?.MAIL_OUT_QUEUE) {
    error(500, "Outbound mail is not configured.");
  }
  return {
    MAIL_DEK: env.MAIL_DEK,
    MAIL_SEARCH_KEY: env.MAIL_SEARCH_KEY,
    MAIL_RAW: env.MAIL_RAW,
    MAIL_OUT_QUEUE: env.MAIL_OUT_QUEUE,
  };
}

export const sendMessage = command(SendInput, async (input) => {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  if (input.to.length + input.cc.length + input.bcc.length === 0) {
    error(400, "At least one recipient is required.");
  }

  const sender = await resolveSender(locals.db, locals.user.id, input.mailboxId, input.fromAliasId);

  const res = await enqueueSend(locals.db, outboundEnv(), {
    orgId: sender.orgId,
    mailboxId: input.mailboxId,
    createdByUserId: locals.user.id,
    fromAddress: sender.fromAddress,
    fromName: sender.fromName,
    fromAliasId: sender.fromAliasId,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text ?? null,
    html: input.html ?? null,
    parentMessageId: input.parentMessageId ?? null,
    attachments: input.attachments,
    sendAt: input.sendAt ?? null,
    idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
    undoSeconds: input.undoSeconds ?? undefined,
  });
  // Bridge: drain this send in-process (see deliver-bridge.ts) since the queue
  // consumer isn't running. Skip future-scheduled sends (left for the queue/cron).
  const undo = input.undoSeconds ?? 10;
  if (!input.sendAt || input.sendAt <= Date.now() + undo * 1000) {
    deliverInBackground(res.submissionId, undo);
  }
  return { submissionId: res.submissionId, threadId: res.threadId, deduped: res.deduped };
});

export const undoSend = command(z.object({ submissionId: z.string().min(1) }), async ({ submissionId }) => {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");

  const sub = await locals.db.query.submission.findFirst({
    where: eq(schema.submission.id, submissionId),
    columns: { mailboxId: true },
  });
  if (!sub) error(404, "Submission not found");
  // Same send-capability gate: only someone who could send as the mailbox may undo.
  const grantedSenderIds = await sendGrantUserIds(locals.db, sub.mailboxId);
  const box = await locals.db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, sub.mailboxId),
    columns: { orgId: true },
  });
  const allowed = can(
    { id: locals.user.id },
    "send",
    { type: "mailbox", ownerId: "", organizationId: box?.orgId, grantedSenderIds },
  );
  if (!allowed) error(403, "You can't cancel this send.");

  const canceled = await cancelSend(locals.db, submissionId);
  return { canceled };
});
