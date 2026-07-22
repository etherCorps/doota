import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { can, type Actor } from "@doota/db/can";
import { routingForHost } from "@doota/db/org-domains";
import { importKey, decryptContent, type ContentKey } from "./crypto";
import { resolveRecipient } from "./resolver";
import { materializeDelivery } from "./materialize";
import { sendGrantUserIds } from "./mailbox";
import { buildQuotedText, buildQuotedHtml } from "./mail-thread-contract";
import { chargeSend } from "./send-rate-limit";
import { selectProvider, ProviderSendError, type OutboundEmail } from "./provider";
import { extractInlineImages } from "./inline-images";
import { log, errInfo } from "./log";
import type { OutboundJob } from "./outbound";

/**
 * Outbound queue consumer — the heavy, idempotent, retryable work (Parts B/C/D/G).
 * The submission row already exists (written before enqueue), so a redelivered
 * job re-reads state and never double-sends: recipients already marked sent are
 * skipped, and a canceled submission is acked without sending. Preflight runs
 * before any provider call; internal recipients short-circuit through
 * materializeDelivery instead of going out to SMTP and back.
 */

export type OutboundConsumerEnv = {
  DB: D1Database;
  MAIL_RAW: R2Bucket;
  MAIL_DEK: string;
  MAIL_SEARCH_KEY: string;
  EMAIL_SENDER?: SendEmail;
  MAIL_OUT_QUEUE: Queue<OutboundJob>;
  LOG_LEVEL?: string;
};

const CHUNK = 50; // recipients per provider call
const MAX_ATTEMPTS = 5; // soft-failure retry cap before giving up
const BACKOFF_BASE_SECONDS = 30;

type Db = ReturnType<typeof drizzle<typeof schema>>;
type QueueBatch = { messages: { body: OutboundJob; ack(): void; retry(opts?: { delaySeconds?: number }): void }[] };

const TERMINAL = new Set(["sent", "delivered", "bounced_hard", "bounced_soft", "complained", "canceled", "failed"]);

export async function handleOutboundQueue(batch: QueueBatch, env: OutboundConsumerEnv): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const ck = await importKey(env.MAIL_DEK);

  for (const m of batch.messages) {
    try {
      await processSubmission(db, env, ck, m);
    } catch (e) {
      // A soft/unclassified failure: retry the whole job with backoff.
      log.error("out.job_retry", { subId: m.body.submissionId, ...errInfo(e) });
      m.retry({ delaySeconds: BACKOFF_BASE_SECONDS });
    }
  }
}

/**
 * Process a single submission NOW, in-process, without the queue — used by the
 * app worker's synchronous delivery bridge (deliver-bridge.ts) while the
 * doota-mail queue consumer isn't wired in dev. `ack`/`retry` are no-ops: soft
 * failures simply aren't retried (the real queue does that once enabled).
 * Idempotent with the queue path, so enabling the consumer later can't double-send.
 */
export async function deliverSubmissionNow(env: OutboundConsumerEnv, submissionId: string): Promise<void> {
  await handleOutboundQueue(
    { messages: [{ body: { submissionId }, ack() {}, retry() {} }] },
    env,
  );
}

/**
 * Process one submission job. Exported so tests can drive it with an in-memory db
 * directly (the batch handler above builds its db from env.DB). Idempotent:
 * re-running re-reads state and never re-sends an already-sent recipient.
 */
export async function processSubmission(
  db: Db,
  env: OutboundConsumerEnv,
  ck: ContentKey,
  m: QueueBatch["messages"][number],
): Promise<void> {
  const sub = await db.query.submission.findFirst({
    where: eq(schema.submission.id, m.body.submissionId),
  });
  if (!sub) return m.ack(); // submission gone — nothing to do

  // Undo won, or already processed → ack without sending (idempotent).
  if (sub.status === "canceled" || TERMINAL.has(sub.status)) return m.ack();

  // Fired before the hold elapsed (early sweep) — re-hold for the remainder.
  const now = Date.now();
  if (sub.undoUntil && now < sub.undoUntil.getTime()) {
    m.retry({ delaySeconds: Math.ceil((sub.undoUntil.getTime() - now) / 1000) });
    return;
  }

  await db
    .update(mail.submission)
    .set({ status: "sending", attempts: sub.attempts + 1 })
    .where(eq(mail.submission.id, sub.id));

  log.info("out.processing", { subId: sub.id, from: sub.envelopeFrom, attempt: sub.attempts + 1 });

  // ---- Preflight (Part B.7) — any failure is permanent, no retry ----
  const fail = async (reason: string) => {
    log.warn("out.failed", { subId: sub.id, reason });
    await db.update(mail.submission).set({ status: "failed", lastError: reason }).where(eq(mail.submission.id, sub.id));
    await db
      .update(mail.submissionRecipient)
      .set({ status: "failed", bounceReason: reason })
      .where(and(eq(mail.submissionRecipient.submissionId, sub.id), notTerminalRecipient()));
    m.ack();
  };

  if (!sub.createdByUserId) return fail("no sending user");
  const grantedSenderIds = await sendGrantUserIds(db, sub.mailboxId);
  const actor: Actor = { id: sub.createdByUserId };
  const allowed = can(actor, "send", {
    type: "mailbox",
    ownerId: "",
    organizationId: sub.orgId,
    grantedSenderIds,
  });
  if (!allowed) return fail("send capability revoked");

  const org = await db.query.organization.findFirst({
    where: eq(schema.organization.id, sub.orgId),
    columns: { status: true },
  });
  const routing = await routingForHost(db, sub.envelopeFrom);
  if (org?.status !== "active" || routing?.id !== sub.orgId) {
    return fail("from-address domain is not active");
  }
  // Wire From display name. Alias sends use the alias label ONLY — hide-my-email
  // exists to not leak who's behind it, so never fall through to the user's real
  // name. Direct sends: mailbox displayName, else the sending user's name.
  let fromName: string | undefined;
  if (sub.fromAliasId) {
    const aliasRow = await db.query.alias.findFirst({
      where: eq(schema.alias.id, sub.fromAliasId),
      columns: { isEnabled: true, mailboxId: true, label: true },
    });
    if (!aliasRow?.isEnabled || aliasRow.mailboxId !== sub.mailboxId) {
      return fail("from-alias disabled or not owned by mailbox");
    }
    fromName = aliasRow.label ?? undefined;
  } else {
    const box = await db.query.mailbox.findFirst({
      where: eq(schema.mailbox.id, sub.mailboxId),
      columns: { displayName: true },
    });
    fromName = box?.displayName ?? undefined;
    if (!fromName && sub.createdByUserId) {
      const sender = await db.query.user.findFirst({
        where: eq(schema.user.id, sub.createdByUserId),
        columns: { name: true },
      });
      fromName = sender?.name || undefined;
    }
  }

  // ---- Classify recipients (Part C): suppressed / internal / external ----
  const recipients = await db.query.submissionRecipient.findMany({
    where: eq(schema.submissionRecipient.submissionId, sub.id),
  });
  const message = await db.query.message.findFirst({
    where: eq(schema.message.id, sub.messageId),
  });
  if (!message) return fail("message row missing");

  const external: { id: string; address: string; role: string }[] = [];
  for (const r of recipients) {
    if (TERMINAL.has(r.status) || r.status === "delivered" || r.status === "sent" || r.status === "dropped") {
      continue; // already handled (redelivery) — never re-send
    }
    // Suppressed → drop before the provider, recorded (not silently lost).
    const suppressed = await db.query.suppression.findFirst({
      where: and(eq(schema.suppression.orgId, sub.orgId), eq(schema.suppression.address, r.address)),
      columns: { reason: true },
    });
    if (suppressed) {
      await setRecipient(db, r.id, { status: "dropped", bounceReason: `suppressed:${suppressed.reason}` });
      continue;
    }
    // Internal → materialize directly into the recipient mailbox (no SMTP).
    const resolved = await resolveRecipient(db, r.address);
    if (resolved && resolved.orgId === sub.orgId) {
      await materializeDelivery(db, {
        orgId: sub.orgId,
        messageId: sub.messageId,
        threadId: message.threadId,
        mailboxId: resolved.mailboxId,
        role: r.role as "to" | "cc" | "bcc",
        viaAliasId: resolved.viaAliasId,
        subaddressTag: resolved.subaddressTag,
        sentAt: message.sentAt ? message.sentAt.getTime() : now,
      });
      await setRecipient(db, r.id, { status: "delivered" });
      continue;
    }
    external.push({ id: r.id, address: r.address, role: r.role });
  }

  log.info("out.recipients", { subId: sub.id, external: external.length, internal: recipients.length - external.length });

  // ---- Rate limit (Part G) — external volume only ----
  if (external.length > 0) {
    const rl = await chargeSend(db, sub.mailboxId, external.length);
    if (!rl.ok) return fail(`rate limit exceeded (${rl.scope})`);
  }

  // ---- Send external via provider, chunked at 50 (Part B.4) ----
  if (external.length > 0) {
    const provider = selectProvider({ EMAIL_SENDER: env.EMAIL_SENDER });
    if (!provider) return fail("no mail provider configured");

    const subject = (await decryptContent(ck, message.subjectEnc)) ?? "";
    const built = await buildBody(db, env, ck, message);
    const { text } = built;
    // Pasted/inserted images are base64 data: URIs in the html — providers strip
    // those, so convert them to inline CID attachments and rewrite the src.
    const { html, images } = extractInlineImages(built.html);
    const dataUrisInSource = (built.html?.match(/data:image\//g) ?? []).length;
    log.info("out.body", {
      subId: sub.id,
      htmlLen: built.html?.length ?? 0,
      dataImgs: dataUrisInSource,
      inlined: images.length,
    });
    const headers: Record<string, string> = { "Message-ID": message.messageIdHeader };
    if (message.inReplyTo) headers["In-Reply-To"] = message.inReplyTo;
    if (message.references) headers["References"] = message.references;
    const attachments = [...((await loadAttachments(db, env, sub.messageId)) ?? []), ...images];
    const from = { name: fromName, email: sub.envelopeFrom };

    for (let i = 0; i < external.length; i += CHUNK) {
      const chunk = external.slice(i, i + CHUNK);
      const email: OutboundEmail = {
        from,
        to: chunk.filter((r) => r.role === "to").map((r) => r.address),
        cc: chunk.filter((r) => r.role === "cc").map((r) => r.address),
        bcc: chunk.filter((r) => r.role === "bcc").map((r) => r.address),
        subject,
        text,
        html: html ?? undefined,
        headers,
        attachments,
      };
      const dests = [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])];
      log.info("out.sending", { subId: sub.id, provider: provider.name, to: dests.join(", ") });
      try {
        const res = await provider.send(email);
        log.info("out.sent", { subId: sub.id, provider: provider.name, msgId: res.providerMessageId });
        const ids = chunk.map((r) => r.id);
        await db
          .update(mail.submissionRecipient)
          .set({ status: "sent", providerMessageId: res.providerMessageId })
          .where(inArray(mail.submissionRecipient.id, ids));
        if (!sub.providerMessageId) {
          await db
            .update(mail.submission)
            .set({ provider: provider.name, providerMessageId: res.providerMessageId })
            .where(eq(mail.submission.id, sub.id));
          sub.providerMessageId = res.providerMessageId;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const soft = e instanceof ProviderSendError && !e.permanent;
        log.error("out.provider_error", { subId: sub.id, provider: provider.name, soft, err: msg });
        if (soft) {
          // Soft: give up after the cap, else retry the whole job with backoff.
          if (sub.attempts + 1 >= MAX_ATTEMPTS) return fail(`send failed after retries: ${(e as Error).message}`);
          throw e; // bubbles to handleOutboundQueue → m.retry with backoff
        }
        // Permanent: these recipients fail; keep going with the rest.
        await db
          .update(mail.submissionRecipient)
          .set({ status: "failed", bounceReason: e instanceof Error ? e.message : String(e) })
          .where(inArray(mail.submissionRecipient.id, chunk.map((r) => r.id)));
      }
    }
  }

  await rollup(db, sub.id);
  m.ack();
}

// ---- helpers -----------------------------------------------------------------

/** A recipient row not already in a terminal-ish state (for bulk preflight fail). */
function notTerminalRecipient() {
  return sql`${mail.submissionRecipient.status} not in ('sent','delivered','dropped','bounced','complained')`;
}

async function setRecipient(
  db: Db,
  id: string,
  patch: { status: string; bounceReason?: string; providerMessageId?: string },
): Promise<void> {
  await db.update(mail.submissionRecipient).set(patch).where(eq(mail.submissionRecipient.id, id));
}

/** Build the wire body: R2-staged text/html, re-quoted from the parent (Part E). */
async function buildBody(
  db: Db,
  env: OutboundConsumerEnv,
  ck: Awaited<ReturnType<typeof importKey>>,
  message: typeof schema.message.$inferSelect,
): Promise<{ text?: string; html?: string }> {
  let newText: string | null = null;
  let newHtml: string | null = null;
  if (message.r2RawKey) {
    const obj = await env.MAIL_RAW.get(message.r2RawKey);
    if (obj) {
      const raw = JSON.parse(await obj.text()) as { text: string | null; html: string | null };
      newText = raw.text;
      newHtml = raw.html;
    }
  }
  if (newText == null) newText = await decryptContent(ck, message.bodyFullEnc);

  if (!message.inReplyTo) {
    return { text: newText ?? undefined, html: newHtml ?? undefined };
  }
  const parent = await db.query.message.findFirst({
    where: and(eq(schema.message.orgId, message.orgId), eq(schema.message.messageIdHeader, message.inReplyTo)),
    columns: { fromAddr: true, sentAt: true, bodyFullEnc: true },
  });
  if (!parent) return { text: newText ?? undefined, html: newHtml ?? undefined };
  const parentFull = await decryptContent(ck, parent.bodyFullEnc);
  const q = { from: parent.fromAddr, sentAt: parent.sentAt ? parent.sentAt.getTime() : null, bodyFull: parentFull };
  return {
    text: buildQuotedText(newText ?? "", q),
    html: newHtml ? buildQuotedHtml(newHtml, q) : undefined,
  };
}

async function loadAttachments(
  db: Db,
  env: OutboundConsumerEnv,
  messageId: string,
): Promise<OutboundEmail["attachments"]> {
  const rows = await db.query.attachment.findMany({
    where: eq(schema.attachment.messageId, messageId),
    columns: { filename: true, contentType: true, r2Key: true },
  });
  const out: NonNullable<OutboundEmail["attachments"]> = [];
  for (const a of rows) {
    if (!a.r2Key) continue;
    const obj = await env.MAIL_RAW.get(a.r2Key);
    if (!obj) continue;
    out.push({
      filename: a.filename ?? "attachment",
      contentType: a.contentType ?? "application/octet-stream",
      content: await obj.arrayBuffer(),
    });
  }
  return out.length ? out : undefined;
}

/**
 * Roll the submission status up from its recipients: any sent/delivered → the
 * send succeeded (bounces flip individual recipients later). Nothing sent, but
 * every recipient reached a non-failed terminal state (internal-only, or fully
 * suppressed/dropped) → still `sent` — a deliberate drop is not a failure. Only
 * an actual failure with nothing delivered rolls up to `failed`.
 */
async function rollup(db: Db, submissionId: string): Promise<void> {
  const rows = await db.query.submissionRecipient.findMany({
    where: eq(schema.submissionRecipient.submissionId, submissionId),
    columns: { status: true },
  });
  const anySent = rows.some((r) => r.status === "sent" || r.status === "delivered");
  const anyFailed = rows.some((r) => r.status === "failed");
  const status = anySent || (rows.length > 0 && !anyFailed) ? "sent" : "failed";
  await db.update(mail.submission).set({ status }).where(eq(mail.submission.id, submissionId));
}
