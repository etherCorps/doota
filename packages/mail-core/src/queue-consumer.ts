// SPDX-License-Identifier: Apache-2.0
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import PostalMime from "postal-mime";
import * as schema from "@doota/db/schema";
import { importKey, encryptContent, putEncryptedBlob, getDecryptedBlob, type ContentKey } from "./crypto";
import { materializeMessage, materializeDelivery, type ParsedMessage, type PlacementPolicy } from "./materialize";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { loadRules, evalRules, applyRuleOutcome, emptyOutcome, type RuleOutcome, type RuleMessageView } from "./rules";
import { classifyInbound } from "./spam";
import { handleRuleBackfill, type RuleBackfillJob } from "./rules-backfill";
import { handleExportJob, type MailboxExportJob } from "./export";
import { enqueueSend, type OutboundEnv } from "./outbound";
import { maybeVacationReply } from "./vacation";
import { parseIcs, extractRsvpLinks, findCalendarPart } from "./calendar";
import { looksLikeBounce, parseBounce, applyBounce, isDeliveryReport } from "./bounce";
import { notifyInboundMail, notifySubmissionState } from "./events-hub";
import { emitInboundWebhook } from "./webhooks";
import { sendGrantUserIds } from "./mailbox";
import { recordNewMail } from "./notify";
import { recordCorrespondents } from "./contacts";
import { log, errInfo, tryLog } from "./log";
import type { InboundJob, MailEnv } from "./inbound-worker";

/**
 * Inbound queue consumer — the heavy, idempotent work. Fetch raw from R2, parse
 * MIME with postal-mime (Workers-compatible, NOT Node mailparser), then upsert
 * message / delivery / thread_state through the shared materialize seam. Every
 * step is safe to re-run: a redelivered job converges, never duplicates, so on
 * any error we retry the whole job rather than half-commit.
 */

type PMAddress = { address?: string; name?: string };
type PMParsed = {
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  from?: PMAddress;
  to?: PMAddress[];
  cc?: PMAddress[];
  replyTo?: PMAddress[];
  subject?: string;
  date?: string;
  text?: string;
  html?: string;
  attachments?: PMAttachment[];
  /** Full header list from postal-mime — rules (List-Id) + auto-reply guards. */
  headers?: { key: string; value: string }[];
};

/** First header value by (case-insensitive) name, or null. */
export function headerValue(parsed: PMParsed, name: string): string | null {
  const lower = name.toLowerCase();
  return parsed.headers?.find((h) => h.key.toLowerCase() === lower)?.value ?? null;
}
type PMAttachment = {
  filename?: string;
  mimeType?: string;
  content?: ArrayBuffer | string;
  contentId?: string;
  disposition?: "attachment" | "inline" | null;
  related?: boolean;
};

function addrList(list: PMAddress[] | undefined): string[] {
  return (list ?? []).map((a) => (a.address ?? "").trim().toLowerCase()).filter(Boolean);
}

/**
 * A MIME part is a real attachment only if it has a filename, or a Content-ID
 * (a `cid:`-referenced inline image), or `Content-Disposition: attachment`.
 * Everything else is a BODY representation — most importantly a `text/calendar`
 * (or any other) part sitting in a `multipart/alternative`, which postal-mime
 * surfaces in `attachments` but which must never become a phantom download.
 * postal-mime already lifts the chosen text/plain + text/html out into
 * `parsed.text`/`parsed.html`, so this only ever drops non-body alternatives.
 */
export function isRealAttachment(a: {
  filename?: string | null;
  contentId?: string;
  disposition?: "attachment" | "inline" | null;
}): boolean {
  return !!a.filename || !!a.contentId || a.disposition === "attachment";
}
function realAttachments(parsed: PMParsed): PMAttachment[] {
  return (parsed.attachments ?? []).filter(isRealAttachment);
}

/** Strip a +tag from the recipient so it matches the visible header addresses. */
export function baseAddress(address: string, tag: string | null): string {
  if (!tag) return address.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at).replace(`+${tag}`, "");
  return `${local}${address.slice(at)}`.trim().toLowerCase();
}

/**
 * Role of THIS recipient: visible in To → to, in Cc → cc, else the envelope
 * recipient isn't in any visible header, which means it was Bcc'd. Bcc therefore
 * exists ONLY as a delivery row, never back in the stored message headers.
 */
export function deriveRole(parsed: PMParsed, recipientBase: string): "to" | "cc" | "bcc" {
  if (addrList(parsed.to).includes(recipientBase)) return "to";
  if (addrList(parsed.cc).includes(recipientBase)) return "cc";
  return "bcc";
}

function toParsedMessage(parsed: PMParsed, job: InboundJob): ParsedMessage {
  const messageIdHeader =
    parsed.messageId?.trim() || job.messageIdHeader || `generated:${job.r2RawKey}`;
  const sentAt = parsed.date ? Date.parse(parsed.date) || null : null;
  return {
    messageIdHeader,
    inReplyTo: parsed.inReplyTo ?? null,
    references: parsed.references ?? null,
    from: parsed.from?.address ?? job.envelopeFrom ?? null,
    fromName: parsed.from?.name?.trim() || null,
    to: addrList(parsed.to),
    cc: addrList(parsed.cc),
    replyTo: parsed.replyTo?.[0]?.address?.trim().toLowerCase() ?? null,
    subject: parsed.subject ?? null,
    sentAt,
    text: parsed.text ?? null,
    html: parsed.html ?? null,
    r2RawKey: job.r2RawKey,
    dmarcPass: job.dmarcPass ?? false, // ?? false: jobs queued before this field

    // r2Key is filled by stageInboundAttachments before materialize — a null
    // key means an empty/unreadable part, and stays undownloadable. Only REAL
    // attachments (not body-alternative parts like a bare text/calendar) — see
    // isRealAttachment. Staging applies the same filter so indices stay aligned.
    attachments: realAttachments(parsed).map((a, i) => ({
      partId: a.contentId ?? String(i),
      filename: a.filename ?? null,
      contentType: a.mimeType ?? null,
      size: typeof a.content === "string" ? a.content.length : (a.content?.byteLength ?? null),
      r2Key: null,
    })),
  };
}

/**
 * Give each attachment its own R2 object and stamp the key onto the parsed
 * message. The raw MIME stays canonical, but nothing re-parses it at read
 * time: the download endpoint and outbound forwarding both stream per-part
 * keys — without this, inbound attachments 404 and forwards drop them.
 */
async function stageInboundAttachments(
  env: MailEnv,
  orgId: string,
  parsed: PMParsed,
  pm: ParsedMessage,
  ck: ContentKey,
): Promise<void> {
  const parts = realAttachments(parsed); // same filter + order as toParsedMessage
  for (let i = 0; i < pm.attachments.length; i++) {
    const content = parts[i]?.content;
    if (content == null) continue;
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const key = `attachments/${orgId}/${crypto.randomUUID()}`;
    // Attachment bytes encrypted at rest, same as the raw. The declared type
    // lives on the D1 attachment row; the R2 object is opaque ciphertext.
    await putEncryptedBlob(env.MAIL_RAW, key, ck, bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    pm.attachments[i].r2Key = key;
  }
}

/**
 * Parse any calendar part on the message and persist a calendar_event row.
 * Structural fields stay cleartext; the sensitive free-text (summary/location/
 * description/joinUrl/rsvpLinks) is encrypted into details_enc with the same DEK
 * as the subject/body. Idempotent: unique on message_id, so a redelivered job
 * no-ops. Never throws into the delivery path — a malformed invite must not lose
 * the mail (it still lands as a normal message with its .ics attachment).
 */
async function persistInvite(
  db: ReturnType<typeof drizzle<typeof schema>>,
  ck: ContentKey,
  orgId: string,
  messageId: string,
  parsed: PMParsed,
): Promise<void> {
  try {
    const raw = findCalendarPart(parsed.attachments);
    if (!raw) return;
    const inv = parseIcs(raw);
    if (!inv) return;
    const rsvpLinks = extractRsvpLinks(parsed.html);
    const detailsEnc = await encryptContent(
      ck,
      JSON.stringify({
        summary: inv.summary,
        description: inv.description,
        location: inv.location,
        joinUrl: inv.joinUrl,
        rsvpLinks,
      }),
    );
    await db
      .insert(schema.calendarEvent)
      .values({
        orgId,
        messageId,
        uid: inv.uid,
        method: inv.method,
        sequence: inv.sequence,
        status: inv.status,
        startMs: inv.startMs,
        endMs: inv.endMs,
        tz: inv.tz,
        allDay: inv.allDay,
        organizerEmail: inv.organizer.email,
        organizerName: inv.organizer.name,
        attendeesJson: JSON.stringify(inv.attendees),
        meetingPlatform: inv.meetingPlatform,
        calOrigin: inv.calOrigin,
        detailsEnc,
      })
      .onConflictDoNothing({ target: schema.calendarEvent.messageId });
  } catch (e) {
    log.warn("in.invite_parse_failed", { messageId, ...errInfo(e) });
  }
}

type QueueBatch = {
  messages: { body: InboundJob | RuleBackfillJob | MailboxExportJob; ack(): void; retry(): void }[];
};

/**
 * Named inbound stages (build guide 0b): metadata → rulesEval → placement →
 * notify. Execution is driven by INBOUND_STAGES, so the order is structural —
 * the one load-bearing constraint is that rulesEval precedes notify: a rule
 * that files or junks a message must suppress its notification in the same
 * pass, before the notification dedupe machinery ever records the event.
 * receive (handleEmail) and parse (PostalMime + bounce short-circuit) run
 * before the stage loop.
 */
export type RulesOutcome = {
  /** Placement override handed to materializeDelivery; null = default policy. */
  placement: PlacementPolicy | null;
  /** A rule filed/junked the mail — no new-mail notification. */
  suppressNotification: boolean;
  /** Full evaluation detail — the placement stage applies it. */
  outcome?: RuleOutcome;
};

type InboundStageCtx = {
  db: DrizzleD1Database<typeof schema> & { $client: D1Database };
  env: MailEnv;
  deps: { ck: ContentKey; searchKeyB64: string };
  job: InboundJob;
  parsed: PMParsed;
  pm: ParsedMessage;
  /** Raw MIME size in bytes (rules `size` conditions). */
  rawSize?: number;
  messageId?: string;
  threadId?: string;
  role?: "to" | "cc" | "bcc";
  rules?: RulesOutcome;
};

async function metadataStage(ctx: InboundStageCtx): Promise<void> {
  await stageInboundAttachments(ctx.env, ctx.job.orgId, ctx.parsed, ctx.pm, ctx.deps.ck);
  const { messageId, threadId } = await materializeMessage(ctx.db, ctx.job.orgId, ctx.pm, ctx.deps);
  ctx.messageId = messageId;
  ctx.threadId = threadId;
  // Calendar invite (iMIP): parse + store alongside the message, before the
  // delivery so the invite is present the first time the thread is opened.
  await persistInvite(ctx.db, ctx.deps.ck, ctx.job.orgId, messageId, ctx.parsed);
  const recipientBase = baseAddress(ctx.job.recipient, ctx.job.subaddressTag);
  ctx.role = deriveRole(ctx.parsed, recipientBase);
}

/** Tier-1 view of the message — everything already in memory post-parse. */
export function ruleViewOf(parsed: PMParsed, pm: ParsedMessage, rawSize: number | null): RuleMessageView {
  return {
    from: pm.from,
    to: pm.to ?? [],
    cc: pm.cc ?? [],
    subject: pm.subject ?? null,
    listId: headerValue(parsed, "list-id"),
    hasAttachment: realAttachments(parsed).length > 0,
    size: rawSize,
  };
}

async function rulesEvalStage(ctx: InboundStageCtx): Promise<void> {
  const rules = await loadRules(ctx.db, ctx.job.resolvedMailboxId);
  // Tier-2 body is ALREADY in memory at ingest (postal-mime parsed it) — the
  // lazy getter costs nothing here; the R2 gate matters in the backfill.
  const outcome = rules.length
    ? await evalRules(rules, ruleViewOf(ctx.parsed, ctx.pm, ctx.rawSize ?? null), async () => ctx.pm.text ?? null)
    : emptyOutcome();
  // Spam (Phase 5) is a built-in rule kind on the same stage: lists → tier-2
  // ham floor → tier-1 auth verdict. An explicit user-rule filing beats the
  // classifier (a rule moveTo is a statement about this sender; the heuristic
  // yields), and a user junk rule needs no help.
  if (outcome.moveToLabelId === null && !outcome.junk) {
    const verdict = await classifyInbound(ctx.db, {
      mailboxId: ctx.job.resolvedMailboxId,
      fromAddress: ctx.pm.from,
      dmarcPass: ctx.job.dmarcPass,
      authResults: ctx.job.authResults,
    });
    if (verdict.spam) {
      outcome.junk = true; // junkRuleId stays null → "marked as spam" origin
      log.info("in.spam_classified", { mailboxId: ctx.job.resolvedMailboxId, reason: verdict.reason });
    }
  }
  ctx.rules = {
    // Placement override applies at INSERT time so rule-matched mail never
    // appears in Inbox first — a new thread lands filed/junked directly.
    placement: outcome.junk
      ? { newThread: "spam", unarchiveOnReply: false }
      : outcome.moveToLabelId
        ? { newThread: "archived", unarchiveOnReply: false }
        : null,
    // Junk is silent. Folder-filed mail is silenced via the target folder's
    // notify_new_mail setting (rule-fed folders default to None), which
    // recordNewMail reads AFTER labels apply — see notify.ts folderSilenced.
    suppressNotification: outcome.junk,
    outcome,
  };
}

async function placementStage(ctx: InboundStageCtx): Promise<void> {
  const out = ctx.rules?.outcome;
  const keywords: string[] = [];
  if (out?.markRead) keywords.push("$seen");
  if (out?.markFlagged) keywords.push("$flagged");
  await materializeDelivery(ctx.db, {
    orgId: ctx.job.orgId,
    messageId: ctx.messageId!,
    threadId: ctx.threadId!,
    mailboxId: ctx.job.resolvedMailboxId,
    role: ctx.role!,
    viaAliasId: ctx.job.viaAliasId,
    subaddressTag: ctx.job.subaddressTag,
    sentAt: ctx.pm.sentAt,
    placement: ctx.rules?.placement ?? undefined,
    isRead: out?.markRead || undefined,
    keywords: keywords.length ? keywords : undefined,
  });
  if (out) {
    await applyRuleOutcome(ctx.db, {
      mailboxId: ctx.job.resolvedMailboxId,
      threadId: ctx.threadId!,
      outcome: out,
    });
    await executeForwards(ctx);
  }
}

/**
 * Rules-engine `forward` action. Mail-loop + exfiltration guards, in order of
 * cheapness: needs the outbound binding; never re-forward our own forwards
 * (X-Doota-Forwarded); never forward auto-generated mail; never forward a
 * bounce (null envelope); never forward to the mailbox itself. Sends are
 * authorized as the rule's creator, so the normal can() send gate and the
 * outbound rate limit both apply.
 */
async function executeForwards(ctx: InboundStageCtx): Promise<void> {
  const forwards = ctx.rules?.outcome?.forwards ?? [];
  if (!forwards.length) return;
  if (!ctx.env.MAIL_OUT_QUEUE) {
    log.warn("rules.forward_skipped", { reason: "no MAIL_OUT_QUEUE binding" });
    return;
  }
  if (headerValue(ctx.parsed, "x-doota-forwarded")) {
    log.warn("rules.forward_loop_blocked", { messageId: ctx.messageId });
    return;
  }
  const autoSubmitted = headerValue(ctx.parsed, "auto-submitted");
  if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== "no") return;
  if (!ctx.job.envelopeFrom) return;
  const box = await ctx.db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, ctx.job.resolvedMailboxId),
    columns: { address: true },
  });
  if (!box) return;
  const outboundEnv: OutboundEnv = {
    MAIL_DEK: ctx.env.MAIL_DEK,
    MAIL_SEARCH_KEY: ctx.env.MAIL_SEARCH_KEY,
    MAIL_RAW: ctx.env.MAIL_RAW,
    MAIL_OUT_QUEUE: ctx.env.MAIL_OUT_QUEUE,
  };
  for (const fwd of forwards) {
    if (fwd.to === box.address) continue;
    const ruleRow = await ctx.db.query.rule.findFirst({
      where: eq(schema.rule.id, fwd.ruleId),
      columns: { createdByUserId: true },
    });
    if (!ruleRow?.createdByUserId) {
      log.warn("rules.forward_skipped", { reason: "rule has no creator", ruleId: fwd.ruleId });
      continue;
    }
    await tryLog(
      "rules.forward_failed",
      enqueueSend(ctx.db, outboundEnv, {
        orgId: ctx.job.orgId,
        mailboxId: ctx.job.resolvedMailboxId,
        createdByUserId: ruleRow.createdByUserId,
        fromAddress: box.address,
        to: [fwd.to],
        subject: `Fwd: ${ctx.pm.subject ?? ""}`,
        text: ctx.pm.text,
        html: ctx.pm.html,
        // Redelivered inbound job → same key → no duplicate forward.
        idempotencyKey: `rulefwd:${fwd.ruleId}:${ctx.messageId}`,
        undoSeconds: 0,
        wireHeaders: { "X-Doota-Forwarded": "1" },
      }),
      { ruleId: fwd.ruleId },
    );
  }
}

async function notifyStage(ctx: InboundStageCtx): Promise<void> {
  if (ctx.rules?.suppressNotification) return;
  // Live inbox: wake the mailbox's users — list prepends + badge bumps.
  await notifyInboundMail(ctx.db, ctx.env.MAIL_EVENTS, ctx.job.resolvedMailboxId, ctx.threadId!);
  await emitInboundWebhook(ctx.db, ctx.env.WEBHOOK_QUEUE, ctx.job.resolvedMailboxId, ctx.threadId!);
  // Durable notification (bell) — best-effort, never fails the delivery.
  await tryLog(
    "in.notify_failed",
    recordNewMail(
      ctx.db,
      { orgId: ctx.job.orgId, mailboxId: ctx.job.resolvedMailboxId, threadId: ctx.threadId! },
      ctx.env,
    ),
    { threadId: ctx.threadId },
  );
}

/**
 * Vacation auto-responder (Phase 4) — evaluates AFTER rulesEval (the junk
 * decision is an input: junked mail never gets an auto-reply) and after
 * placement. Best-effort: a responder failure never fails the delivery.
 */
async function vacationStage(ctx: InboundStageCtx): Promise<void> {
  if (!ctx.env.MAIL_OUT_QUEUE) return; // no outbound path in this deployment
  await tryLog(
    "in.vacation_failed",
    maybeVacationReply(
      ctx.db,
      {
        MAIL_DEK: ctx.env.MAIL_DEK,
        MAIL_SEARCH_KEY: ctx.env.MAIL_SEARCH_KEY,
        MAIL_RAW: ctx.env.MAIL_RAW,
        MAIL_OUT_QUEUE: ctx.env.MAIL_OUT_QUEUE,
        AUTH_KV: ctx.env.AUTH_KV,
      },
      {
        mailboxId: ctx.job.resolvedMailboxId,
        orgId: ctx.job.orgId,
        check: {
          junk: ctx.rules?.outcome?.junk ?? false,
          envelopeFrom: ctx.job.envelopeFrom,
          role: ctx.role!,
          headers: ctx.parsed.headers ?? [],
          fromAddress: ctx.pm.from,
        },
        messageIdHeader: ctx.pm.messageIdHeader,
        subject: ctx.pm.subject,
      },
    ),
    { mailboxId: ctx.job.resolvedMailboxId },
  );
}

export const INBOUND_STAGES: readonly {
  name: "metadata" | "rulesEval" | "placement" | "vacation" | "notify";
  run(ctx: InboundStageCtx): Promise<void>;
}[] = [
  { name: "metadata", run: metadataStage },
  { name: "rulesEval", run: rulesEvalStage },
  { name: "placement", run: placementStage },
  { name: "vacation", run: vacationStage },
  { name: "notify", run: notifyStage },
];

export async function handleQueue(batch: QueueBatch, env: MailEnv): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const ck = await importKey(env.MAIL_DEK);
  const deps = { ck, searchKeyB64: env.MAIL_SEARCH_KEY };

  for (const m of batch.messages) {
    // Rule backfill + export batches ride the inbound queue (same consumer
    // bindings), routed by `kind` — each re-enqueues itself until done.
    if ("kind" in m.body && m.body.kind === "rule_backfill") {
      try {
        await handleRuleBackfill(db, env, m.body);
        m.ack();
      } catch (e) {
        log.error("rules.backfill_retry", { ruleId: m.body.ruleId, ...errInfo(e) });
        m.retry();
      }
      continue;
    }
    if ("kind" in m.body && m.body.kind === "mailbox_export") {
      try {
        await handleExportJob(db, env, m.body);
        m.ack();
      } catch (e) {
        log.error("export.retry", { exportId: m.body.exportId, ...errInfo(e) });
        m.retry();
      }
      continue;
    }
    const job = m.body as InboundJob;
    try {
      const buf = await getDecryptedBlob(env.MAIL_RAW, job.r2RawKey, ck);
      if (!buf) {
        // Raw is gone (already processed + swept, or never landed). Nothing to
        // reconstruct — ack so the job doesn't retry forever.
        m.ack();
        continue;
      }
      const parsed = (await PostalMime.parse(buf)) as PMParsed;

      // Bounce/complaint short-circuit (Part F): a DSN routed to our return-path
      // must update submission state + suppressions, NEVER land in an inbox.
      const rp = await db.query.orgMailSettings.findFirst({
        where: eq(schema.orgMailSettings.orgId, job.orgId),
        columns: { returnPathDomain: true },
      });
      if (
        looksLikeBounce({
          envelopeFrom: job.envelopeFrom,
          fromAddress: parsed.from?.address ?? null,
          subject: parsed.subject ?? null,
          recipient: job.recipient,
          returnPathDomain: rp?.returnPathDomain ?? null,
        })
      ) {
        // The heuristic said "bounce" — but only DROP if the DSN body actually
        // parses to a failure/complaint. A mail that merely LOOKS like a bounce
        // (subject regex, or addressed to the return-path subdomain) with no
        // parseable failures is a real reply that tripped the heuristic — deliver
        // it instead of eating it silently (the historical misclassification bug).
        const rawText = new TextDecoder().decode(buf);
        // DROP only a STRUCTURAL report (multipart/report). A real reply that
        // merely quotes a bounce is text/* — parseable failures alone must not
        // eat it. Non-report bounces still update state via the primary event path.
        const bounce = parseBounce(rawText);
        if (isDeliveryReport(rawText) && (bounce.failures.length > 0 || bounce.isComplaint)) {
          // DSN fallback path (structured event subscriptions are primary; a DSN
          // that slips through still updates state and wakes the user's stream —
          // client-side dedupe absorbs any double notification).
          const applied = await applyBounce(db, job.orgId, bounce, { hub: env.MAIL_EVENTS, push: env });
          if (applied.matchedSubmission && applied.worstStatus) {
            await notifySubmissionState(db, env.MAIL_EVENTS, applied.matchedSubmission, applied.worstStatus);
          }
          log.warn("in.bounce_classified", {
            r2Key: job.r2RawKey,
            recipient: job.recipient,
            envelopeFrom: job.envelopeFrom,
            from: parsed.from?.address ?? null,
            subject: parsed.subject ?? null,
            returnPathDomain: rp?.returnPathDomain ?? null,
            matchedSubmission: applied.matchedSubmission ?? null,
          });
          m.ack();
          continue;
        }
        // Looked like a bounce, wasn't one — log the averted drop and fall through
        // to normal delivery. Watch this to tune looksLikeBounce if it fires often.
        log.warn("in.bounce_false_positive", {
          r2Key: job.r2RawKey,
          recipient: job.recipient,
          envelopeFrom: job.envelopeFrom,
          from: parsed.from?.address ?? null,
          subject: parsed.subject ?? null,
          returnPathDomain: rp?.returnPathDomain ?? null,
        });
      }

      const pm = toParsedMessage(parsed, job);
      const ctx: InboundStageCtx = { db, env, deps, job, parsed, pm, rawSize: buf.byteLength };
      for (const stage of INBOUND_STAGES) await stage.run(ctx);
      const threadId = ctx.threadId!;

      // A new correspondent just landed — record the sender against this mailbox
      // (autocomplete index) and bust the recipients' cached contact candidates
      // (key shape shared with draft.remote.ts contactsKey) so the sender shows
      // up in suggestions immediately, not after the KV TTL.
      await tryLog(
        "in.correspondent_failed",
        recordCorrespondents(db, [
          { mailboxId: job.resolvedMailboxId, address: pm.from, name: pm.fromName, seenAt: pm.sentAt },
        ]),
        { threadId },
      );
      if (env.AUTH_KV) {
        try {
          const userIds = await sendGrantUserIds(db, job.resolvedMailboxId);
          await Promise.all(userIds.map((u) => env.AUTH_KV!.delete(`contacts:${u}`)));
        } catch (e) {
          log.warn("in.contacts_bust_failed", errInfo(e)); // never fail the delivery over cache hygiene
        }
      }

      m.ack();
    } catch (e) {
      log.error("in.job_retry", { r2Key: job.r2RawKey, ...errInfo(e) });
      m.retry();
    }
  }
}
