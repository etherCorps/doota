// SPDX-License-Identifier: Apache-2.0
// Send an iTIP REPLY (RFC 5546) for an RSVP. The Cloudflare provider builds MIME
// itself and can't emit a `text/calendar` BODY part, so the REPLY rides as a
// `text/calendar; method=REPLY` ATTACHMENT (the canonical payload; attachment
// transport) — Gmail/Outlook still process it as an RSVP. Sent to the ORGANIZER
// ONLY, carrying EXACTLY the replying attendee (never the guest list).
//
// The gates (attendee-only, organizer-valid, not-cancelled, dedup) live in the
// caller (setInviteRsvp) where the db + viewer identity are at hand; this helper
// is the mechanical build + stage + enqueue.
import { importKey, putEncryptedBlob, type ContentKey } from "@doota/mail-core/crypto";
import { buildReply, type ReplyPartstat } from "@doota/mail-core/ical";
import { enqueueSend, type OutboundEnv } from "@doota/mail-core/outbound";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "@doota/db/schema";

const PARTSTAT: Record<"accepted" | "declined" | "tentative", ReplyPartstat> = {
  accepted: "ACCEPTED",
  declined: "DECLINED",
  tentative: "TENTATIVE",
};
const SUBJECT_VERB: Record<"accepted" | "declined" | "tentative", string> = {
  accepted: "Accepted",
  declined: "Declined",
  tentative: "Tentative",
};

export type RsvpReplyInput = {
  orgId: string;
  mailboxId: string;
  userId: string;
  /** The replying identity — the viewer's mailbox address (an attendee). */
  fromAddress: string;
  fromName: string | null;
  organizerEmail: string;
  organizerName: string | null;
  uid: string;
  recurrenceId: string; // '' for the series master
  sequence: number;
  status: "accepted" | "declined" | "tentative";
  summary: string | null;
};

/** Build + stage + enqueue the REPLY. Returns the submission id. */
export async function sendRsvpReply(
  db: DrizzleD1Database<typeof schema>,
  env: OutboundEnv,
  input: RsvpReplyInput,
): Promise<string> {
  const partstat = PARTSTAT[input.status];
  const ics = buildReply({
    uid: input.uid,
    sequence: input.sequence,
    recurrenceId: input.recurrenceId || null,
    organizerEmail: input.organizerEmail,
    organizerName: input.organizerName,
    attendeeEmail: input.fromAddress,
    attendeeName: input.fromName,
    partstat,
    summary: input.summary,
  });

  // Stage the REPLY encrypted at rest, like every outbound attachment; the
  // provider decrypts + MIMEs it at send.
  const ck: ContentKey = await importKey(env.MAIL_DEK);
  const r2Key = `outbound-cal/${input.orgId}/${crypto.randomUUID()}.ics`;
  await putEncryptedBlob(env.MAIL_RAW, r2Key, ck, new TextEncoder().encode(ics), {
    httpMetadata: { contentType: "text/calendar" },
  });

  const summary = input.summary?.trim() || "invitation";
  const res = await enqueueSend(db, env, {
    orgId: input.orgId,
    mailboxId: input.mailboxId,
    createdByUserId: input.userId,
    fromAddress: input.fromAddress,
    fromName: input.fromName,
    // ORGANIZER ONLY — never the attendee list.
    to: [input.organizerEmail],
    subject: `${SUBJECT_VERB[input.status]}: ${summary}`,
    attachments: [
      {
        r2Key,
        filename: "reply.ics",
        // method=REPLY is what makes a client treat the .ics as an iTIP reply.
        contentType: "text/calendar; method=REPLY; charset=utf-8",
      },
    ],
    // No undo window on an RSVP; a repeat of the SAME answer dedupes here.
    idempotencyKey: `itip-reply:${input.userId}:${input.uid}:${input.recurrenceId}:${partstat}`,
    undoSeconds: 0,
  });
  return res.submissionId;
}
