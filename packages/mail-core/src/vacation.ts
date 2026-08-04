// SPDX-License-Identifier: Apache-2.0
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { enqueueSend, type OutboundEnv } from "./outbound";
import { chargeCounter } from "./send-rate-limit";
import { log } from "./log";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Vacation auto-responder (build guide, Phase 4). The UI is trivial — RFC 3834
 * compliance IS the feature: get it wrong and every Doota instance becomes a
 * mail-loop participant.
 *
 * Never reply when (each returns a reason string for the test matrix):
 *  - the message was classified junk (spam evaluates before vacation)
 *  - Return-Path is null (<>) — a bounce
 *  - Auto-Submitted present and not "no"
 *  - Precedence is bulk/list/junk
 *  - list headers present (List-Id / List-Unsubscribe / List-Post)
 *  - our own address is not in To/Cc (Bcc'd or list mail — role bcc)
 *  - our own forward marker is present (rules forward)
 * Always: Auto-Submitted: auto-replied on the outgoing reply — that is what
 * stops the loop with someone ELSE'S correctly-implemented autoresponder.
 * (A null outgoing return-path is not expressible through the Email Service
 * binding — it sets the envelope itself; Auto-Submitted carries the burden.)
 *
 * Dedupe: one reply per (mailbox, sender) per interval_days, in KV with TTL —
 * self-cleaning, no cron, no table growth.
 * Rate: vacation has its OWN hourly + daily ceilings (a mail bomb must not
 * turn the responder into an amplifier). Replies additionally flow through the
 * normal outbound pipeline and ITS limits — over-limiting is the safe
 * direction for an automation.
 */

export type VacationHeaders = { key: string; value: string }[];

export type VacationCheckInput = {
  junk: boolean;
  envelopeFrom: string | null;
  role: "to" | "cc" | "bcc";
  headers: VacationHeaders;
  fromAddress: string | null;
  mailboxAddress: string;
};

const headerOf = (headers: VacationHeaders, name: string): string | null => {
  const lower = name.toLowerCase();
  return headers.find((h) => h.key.toLowerCase() === lower)?.value ?? null;
};

/** Pure guard — returns the reason to stay silent, or null to proceed. */
export function vacationSuppressReason(input: VacationCheckInput): string | null {
  if (input.junk) return "junk";
  if (!input.envelopeFrom || input.envelopeFrom === "<>") return "null_return_path";
  const auto = headerOf(input.headers, "auto-submitted");
  if (auto && auto.trim().toLowerCase() !== "no") return "auto_submitted";
  const precedence = headerOf(input.headers, "precedence")?.trim().toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") return "precedence";
  if (
    headerOf(input.headers, "list-id") ||
    headerOf(input.headers, "list-unsubscribe") ||
    headerOf(input.headers, "list-post")
  ) {
    return "list_mail";
  }
  if (input.role === "bcc") return "not_addressed"; // our address absent from To/Cc
  if (headerOf(input.headers, "x-doota-forwarded")) return "doota_forward";
  if (input.fromAddress && input.fromAddress.toLowerCase() === input.mailboxAddress.toLowerCase()) {
    return "self";
  }
  return null;
}

const VACATION_HOURLY_CAP = 30;
const VACATION_DAILY_CAP = 200;

export type VacationEnv = OutboundEnv & { AUTH_KV?: KVNamespace };

/**
 * Evaluate + (maybe) send the auto-reply for one inbound delivery. Call AFTER
 * spam/rules evaluation (junk decision is an input). Best-effort: callers wrap
 * in tryLog, a responder failure never fails the delivery.
 */
export async function maybeVacationReply(
  db: Db,
  env: VacationEnv,
  input: {
    mailboxId: string;
    orgId: string;
    check: Omit<VacationCheckInput, "mailboxAddress">;
    /** Inbound message's Message-ID header (threading + idempotency). */
    messageIdHeader: string | null;
    subject: string | null;
    now?: number;
  },
): Promise<{ sent: boolean; reason?: string }> {
  const now = input.now ?? Date.now();
  const settings = await db.query.mailboxVacation.findFirst({
    where: eq(schema.mailboxVacation.mailboxId, input.mailboxId),
  });
  if (!settings?.enabled) return { sent: false, reason: "disabled" };
  if (settings.startsAt && now < settings.startsAt.getTime()) return { sent: false, reason: "not_started" };
  if (settings.endsAt && now > settings.endsAt.getTime()) return { sent: false, reason: "ended" };
  if (!settings.enabledByUserId) return { sent: false, reason: "no_owner" };

  const box = await db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, input.mailboxId),
    columns: { address: true },
  });
  if (!box) return { sent: false, reason: "no_mailbox" };

  const suppress = vacationSuppressReason({ ...input.check, mailboxAddress: box.address });
  if (suppress) return { sent: false, reason: suppress };

  const sender = (input.check.envelopeFrom ?? "").trim().toLowerCase();

  // KV dedupe: one reply per sender per interval. TTL == the window, so the
  // key self-expires — no cron, no table. Without KV (tests/dev) we still
  // send, but exactly once per message via the idempotency key below.
  const dedupeKey = `vac:${input.mailboxId}:${sender}`;
  if (env.AUTH_KV) {
    if (await env.AUTH_KV.get(dedupeKey)) return { sent: false, reason: "deduped" };
  }

  // Own ceilings, charged BEFORE the send so a mail bomb caps out fast.
  const hourly = await chargeCounter(db, "vacation_hour", input.mailboxId, 60 * 60 * 1000, VACATION_HOURLY_CAP, 1, now);
  if (!hourly.ok) return { sent: false, reason: "rate_hourly" };
  const daily = await chargeCounter(db, "vacation_day", input.mailboxId, 24 * 60 * 60 * 1000, VACATION_DAILY_CAP, 1, now);
  if (!daily.ok) return { sent: false, reason: "rate_daily" };

  const subject = settings.subject.trim() || `Auto: Re: ${input.subject ?? ""}`.trim();
  await enqueueSend(db, env, {
    orgId: input.orgId,
    mailboxId: input.mailboxId,
    createdByUserId: settings.enabledByUserId,
    fromAddress: box.address,
    to: [sender],
    subject,
    text: settings.bodyText || "I'm away and will reply when I'm back.",
    parentMessageId: input.messageIdHeader,
    // One auto-reply per triggering message even if the job redelivers.
    idempotencyKey: `vacation:${input.mailboxId}:${input.messageIdHeader ?? sender + ":" + now}`,
    undoSeconds: 0,
    // RFC 3834: mark the reply as auto-generated — the other side's responder
    // must not answer it. (Allowlisted by the Email Service binding.)
    wireHeaders: { "Auto-Submitted": "auto-replied" },
  });
  if (env.AUTH_KV) {
    await env.AUTH_KV.put(dedupeKey, "1", {
      expirationTtl: Math.max(60, settings.intervalDays * 24 * 60 * 60),
    });
  }
  log.info("vacation.replied", { mailboxId: input.mailboxId, sender });
  return { sent: true };
}
