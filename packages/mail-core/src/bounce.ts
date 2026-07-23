import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Bounce & complaint handling (Part F). Cloudflare Email Service (public beta)
 * has NO bounce webhooks and no reliable synchronous bounce field — verified
 * against current docs. Bounces come back as INBOUND email (a DSN from
 * mailer-daemon, multipart/report) delivered to the return-path subdomain, which
 * routes through Email Routing → the mail-in worker. So the inbound consumer must
 * recognize these and route them here instead of materializing them into an inbox.
 *
 * The parser is pure (regex over the DSN text — the same shape CF's own hard-bounce
 * example parses) so it's unit-testable without a live mailbox.
 */

export type BounceKind = "hard" | "soft";
export type ParsedBounce = {
  /** Message-ID of the ORIGINAL message we sent (ours) — links to the submission. */
  originalMessageId: string | null;
  /** Recipients that failed, with hard/soft from the DSN status/SMTP code. */
  failures: { address: string; kind: BounceKind }[];
  /** Spam complaint (ARF feedback-report) rather than a delivery failure. */
  isComplaint: boolean;
};

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/**
 * Heuristic: does this inbound message look like a DSN/complaint rather than
 * normal mail? Strongest signal is the null / mailer-daemon envelope sender or a
 * recipient on our return-path subdomain; subject/daemon address corroborate.
 */
export function looksLikeBounce(input: {
  envelopeFrom: string | null;
  fromAddress: string | null;
  subject: string | null;
  recipient: string | null;
  returnPathDomain: string | null;
}): boolean {
  const env = (input.envelopeFrom ?? "").trim().toLowerCase();
  if (env === "" || env === "<>") return true;
  const from = (input.fromAddress ?? "").toLowerCase();
  if (/(^|[<@.])(mailer-daemon|postmaster)([@>]|$)/.test(from) || /mailer-daemon|postmaster/.test(env)) {
    return true;
  }
  const rp = input.returnPathDomain?.toLowerCase();
  const rcpt = (input.recipient ?? "").toLowerCase();
  if (rp && rcpt.endsWith(`@${rp}`)) return true;
  return /delivery status notification|mail delivery (failed|subsystem)|undeliverable|returned mail|failure notice/i.test(
    input.subject ?? "",
  );
}

/**
 * Parse a DSN/ARF body: original Message-ID, failed recipients + hard/soft, and
 * whether it's a complaint. Hard = SMTP 5.x.x / Status 5.x.x; soft = 4.x.x.
 */
export function parseBounce(text: string): ParsedBounce {
  const isComplaint = /report-type=feedback-report|feedback-type:\s*abuse|this is an email abuse report/i.test(text);

  const midMatch = text.match(/Message-ID:\s*(<[^>]+>)/i);
  const originalMessageId = midMatch ? midMatch[1].trim() : null;

  const failures: { address: string; kind: BounceKind }[] = [];
  // Per-recipient DSN blocks: Final-Recipient + a Status: N.x.x line.
  const recipRe = /Final-Recipient:[^\n]*?;[^\n]*?([a-z0-9._%+-]+@[a-z0-9.-]+)[^]*?Status:\s*([245])\.\d+\.\d+/gi;
  let m: RegExpExecArray | null;
  while ((m = recipRe.exec(text))) {
    const address = m[1].trim().toLowerCase();
    const kind: BounceKind = m[2] === "4" ? "soft" : "hard";
    if (!failures.some((f) => f.address === address)) failures.push({ address, kind });
  }
  // Complaint ARF: the abused recipient is in Original-Rcpt-To / the returned To.
  if (isComplaint && failures.length === 0) {
    const orig = text.match(/Original-Rcpt-To:\s*([^\s]+@[^\s]+)/i) ?? text.match(/Removal-Recipient:\s*([^\s]+@[^\s]+)/i);
    if (orig) failures.push({ address: orig[1].trim().toLowerCase(), kind: "hard" });
  }
  // Last resort: an SMTP 5xx code anywhere + a single address → hard bounce.
  if (failures.length === 0 && /\b5\d\d\b|status:\s*5\./i.test(text)) {
    const any = text.match(EMAIL_RE);
    if (any) failures.push({ address: any[0].toLowerCase(), kind: "hard" });
  }

  return { originalMessageId, failures, isComplaint };
}

const WORST_STATUS = ["complained", "bounced_hard", "bounced_soft"] as const;

/**
 * Apply a parsed bounce to submission state + suppression list. Per-recipient:
 * flip status to bounced/complained + record kind/reason. Hard bounces and
 * complaints add the address to `suppressions` (blocks the next send). The
 * submission rolls up to its worst outcome. Idempotent — re-applying a duplicate
 * DSN converges (upserts + fixed status transitions).
 */
export type AppliedBounce = {
  matchedSubmission: string | null;
  suppressed: string[];
  /** The status the submission rolled to — the caller's notification payload. */
  worstStatus: (typeof WORST_STATUS)[number] | null;
};

export async function applyBounce(db: Db, orgId: string, parsed: ParsedBounce): Promise<AppliedBounce> {
  if (parsed.failures.length === 0) return { matchedSubmission: null, suppressed: [], worstStatus: null };

  // Link to the submission via our original Message-ID → message → submission.
  let submissionId: string | null = null;
  if (parsed.originalMessageId) {
    const msg = await db.query.message.findFirst({
      where: and(eq(schema.message.orgId, orgId), eq(schema.message.messageIdHeader, parsed.originalMessageId)),
      columns: { id: true },
    });
    if (msg) {
      const sub = await db.query.submission.findFirst({
        where: eq(schema.submission.messageId, msg.id),
        columns: { id: true },
      });
      submissionId = sub?.id ?? null;
    }
  }

  const suppressed: string[] = [];
  for (const f of parsed.failures) {
    const complaint = parsed.isComplaint;
    const recipStatus = complaint ? "complained" : "bounced";
    const bounceType = complaint ? "hard" : f.kind;

    if (submissionId) {
      await db
        .update(mail.submissionRecipient)
        .set({ status: recipStatus, bounceType, bounceReason: complaint ? "complaint" : `${f.kind} bounce` })
        .where(
          and(
            eq(mail.submissionRecipient.submissionId, submissionId),
            eq(mail.submissionRecipient.address, f.address),
          ),
        );
    }

    // Hard bounces + complaints suppress; soft bounces retry within policy and are
    // NOT suppressed (a transient failure shouldn't block the address forever).
    if (complaint || f.kind === "hard") {
      await suppress(db, orgId, f.address, complaint ? "complaint" : "hard_bounce");
      suppressed.push(f.address);
    }
  }

  let worstStatus: AppliedBounce["worstStatus"] = null;
  if (submissionId) {
    worstStatus = parsed.isComplaint
      ? "complained"
      : parsed.failures.some((f) => f.kind === "hard")
        ? "bounced_hard"
        : "bounced_soft";
    await rollupToWorst(db, submissionId, worstStatus);
  }

  return { matchedSubmission: submissionId, suppressed, worstStatus };
}

/** Upsert a suppression, bumping last_seen_at on repeat. Exported so manual
 * (admin-added) suppressions go through the same upsert as automatic ones. */
export async function suppress(db: Db, orgId: string, address: string, reason: string): Promise<void> {
  await db
    .insert(mail.suppression)
    .values({ orgId, address: address.trim().toLowerCase(), reason })
    .onConflictDoUpdate({
      target: [mail.suppression.orgId, mail.suppression.address],
      set: { lastSeenAt: new Date(), reason },
    });
}

/** Remove a suppression (manual un-suppress). Returns whether a row was deleted. */
export async function unsuppress(db: Db, orgId: string, address: string): Promise<boolean> {
  const deleted = await db
    .delete(mail.suppression)
    .where(and(eq(mail.suppression.orgId, orgId), eq(mail.suppression.address, address.trim().toLowerCase())))
    .returning({ id: mail.suppression.id });
  return deleted.length > 0;
}

/** Move the submission status to `candidate` only if it's worse than current.
 * Exported for the structured event-subscriptions consumer (same transition rules). */
export async function rollupToWorst(
  db: Db,
  submissionId: string,
  candidate: (typeof WORST_STATUS)[number],
): Promise<void> {
  const cur = await db.query.submission.findFirst({
    where: eq(schema.submission.id, submissionId),
    columns: { status: true },
  });
  const rank = (s: string) => {
    const i = (WORST_STATUS as readonly string[]).indexOf(s);
    return i === -1 ? Infinity : i; // non-bounce (e.g. "sent") ranks worst-eligible
  };
  if (!cur || rank(candidate) <= rank(cur.status)) {
    await db.update(mail.submission).set({ status: candidate }).where(eq(mail.submission.id, submissionId));
  }
}
