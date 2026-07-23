import { and, eq, inArray, notExists, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { suppress, rollupToWorst } from "./bounce";
import { setRecipient, rollup } from "./outbound-consumer";
import { notifySubmissionState, type EventHubNamespace } from "./events-hub";
import { log } from "./log";

/**
 * Cloudflare Email Service event-subscriptions consumer (doota-mail-events
 * queue). The authoritative per-recipient delivery lifecycle: delivered /
 * deferred / bounced / failed / rejected / complained, correlated back to our
 * rows via the provider-minted Message-ID we captured from send() —
 * submission_recipient.provider_message_id + address (indexes from 0012).
 *
 * Replaces DSN regex-parsing as the primary signal (bounce.ts stays as the
 * fallback for DSNs that arrive as plain inbound mail). Every transition ends
 * with a hub notification so open clients update ticks live; failure statuses
 * additionally raise a toast client-side.
 *
 * Idempotent: statuses only move "forward" (a redelivered event converges),
 * suppression upserts, rollups are monotonic-worst.
 */

export type MailEventsEnv = {
  DB: D1Database;
  MAIL_EVENTS?: EventHubNamespace;
  LOG_LEVEL?: string;
};

/** Tolerant shape of one event-subscription message (only what we consume). */
type ProviderEvent = {
  type?: string; // "message.delivered" | "message.bounced" | …
  event?: string; // fallback key some payloads use
  messageId?: string;
  recipient?: string;
  smtpResponse?: string;
  bounce?: { type?: string };
};

type QueueBatch = { messages: { body: unknown; ack(): void; retry(): void }[] };

export async function handleMailEventsQueue(batch: QueueBatch, env: MailEventsEnv): Promise<void> {
  const db = drizzle(env.DB, { schema });
  for (const m of batch.messages) {
    try {
      await applyProviderEvent(db, env, m.body as ProviderEvent);
      m.ack();
    } catch (e) {
      log.error("evt.job_retry", { err: e instanceof Error ? e.message : String(e) });
      m.retry();
    }
  }
}

export async function applyProviderEvent(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Pick<MailEventsEnv, "MAIL_EVENTS">,
  evt: ProviderEvent,
): Promise<void> {
  const kind = (evt.type ?? evt.event ?? "").replace(/^message\./, "");
  const providerId = evt.messageId?.trim();
  const address = evt.recipient?.trim().toLowerCase();
  if (!kind || !providerId || !address) {
    log.warn("evt.unusable", { kind, hasId: !!providerId, hasRecipient: !!address });
    return;
  }
  if (kind === "deferred") {
    log.info("evt.deferred", { msgId: providerId, to: address });
    return; // transient — provider keeps retrying, nothing to record yet
  }

  const target = await findRecipient(db, providerId, address);
  if (!target) {
    // Not ours / pre-capture send / already GC'd — nothing to update.
    log.warn("evt.unmatched", { kind, msgId: providerId });
    return;
  }
  const { recipientId, submission, orgId } = target;

  let notifyStatus: string;

  switch (kind) {
    case "delivered": {
      // Guarded flip: never downgrade a terminal recipient (bounce beat us).
      await db
        .update(mail.submissionRecipient)
        .set({ status: "delivered" })
        .where(
          and(
            eq(mail.submissionRecipient.id, recipientId),
            notInArray(mail.submissionRecipient.status, ["bounced", "complained", "failed", "dropped"]),
          ),
        );
      // All non-dropped recipients delivered → submission `delivered` (double
      // tick). One conditional UPDATE — no row fetch, redelivery converges.
      const upgraded = await db
        .update(mail.submission)
        .set({ status: "delivered" })
        .where(
          and(
            eq(mail.submission.id, submission.id),
            eq(mail.submission.status, "sent"),
            notExists(
              db
                .select({ one: sql`1` })
                .from(mail.submissionRecipient)
                .where(
                  and(
                    eq(mail.submissionRecipient.submissionId, submission.id),
                    notInArray(mail.submissionRecipient.status, ["delivered", "dropped"]),
                  ),
                ),
            ),
          ),
        )
        .returning({ id: mail.submission.id });
      notifyStatus = upgraded.length ? "delivered" : submission.status;
      break;
    }
    case "bounced": {
      const hard = (evt.bounce?.type ?? "hard").toLowerCase() !== "soft";
      await setRecipient(db, recipientId, {
        status: "bounced",
        bounceType: hard ? "hard" : "soft",
        bounceReason: evt.smtpResponse ?? `${hard ? "hard" : "soft"} bounce`,
      });
      if (hard) await suppress(db, orgId, address, "hard_bounce");
      notifyStatus = hard ? "bounced_hard" : "bounced_soft";
      await rollupToWorst(db, submission.id, notifyStatus as "bounced_hard" | "bounced_soft");
      break;
    }
    case "complained": {
      await setRecipient(db, recipientId, {
        status: "complained",
        bounceType: "hard",
        bounceReason: `spam complaint from ${address}`,
      });
      await suppress(db, orgId, address, "complaint");
      notifyStatus = "complained";
      await rollupToWorst(db, submission.id, "complained");
      break;
    }
    case "failed":
    case "rejected": {
      await setRecipient(db, recipientId, {
        status: "failed",
        bounceReason: evt.smtpResponse ?? `provider ${kind} the message`,
      });
      // Shared lattice: failed only when nothing was sent/delivered (a
      // deliberate drop is not a failure) — same rules as the send-time rollup.
      notifyStatus = (await rollup(db, submission.id)).status;
      break;
    }
    default:
      log.warn("evt.unknown_kind", { kind });
      return;
  }

  log.info("evt.applied", { kind, subId: submission.id, to: address });
  await notifySubmissionState(db, env.MAIL_EVENTS, submission.id, notifyStatus, {
    userId: submission.createdByUserId,
  });
}

// ---- helpers -----------------------------------------------------------------

/** Provider ids are stored in wire form `<id@domain>`; events may carry either. */
function idVariants(providerId: string): string[] {
  const bare = providerId.replace(/^</, "").replace(/>$/, "");
  return [`<${bare}>`, bare];
}

/** One indexed query: recipient row + its submission, id-form tolerant. */
async function findRecipient(
  db: ReturnType<typeof drizzle<typeof schema>>,
  providerId: string,
  address: string,
) {
  const rec = await db
    .select({
      recipientId: schema.submissionRecipient.id,
      submissionId: schema.submission.id,
      submissionStatus: schema.submission.status,
      createdByUserId: schema.submission.createdByUserId,
      orgId: schema.submission.orgId,
    })
    .from(schema.submissionRecipient)
    .innerJoin(schema.submission, eq(schema.submissionRecipient.submissionId, schema.submission.id))
    .where(
      and(
        inArray(schema.submissionRecipient.providerMessageId, idVariants(providerId)),
        eq(schema.submissionRecipient.address, address),
      ),
    )
    .limit(1);
  if (!rec[0]) return null;
  return {
    recipientId: rec[0].recipientId,
    submission: {
      id: rec[0].submissionId,
      status: rec[0].submissionStatus,
      createdByUserId: rec[0].createdByUserId,
    },
    orgId: rec[0].orgId,
  };
}
