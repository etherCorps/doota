// SPDX-License-Identifier: Apache-2.0
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { getDecryptedBlob, putEncryptedBlob, decryptContent, importKey } from "./crypto";
import { log } from "./log";
import type { MailEnv } from "./inbound-worker";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Mailbox export (build guide, Phase 6): mbox with X-Doota-* headers carrying
 * Doota-specific state, plus a sidecar JSON for what can't survive a header
 * (notes, per-thread label sets). mbox because every mail tool imports it, and
 * the custom headers keep the export losslessly re-importable into Doota later
 * (Phase 7) without a second proprietary format.
 *
 * Resumable queue job, same pattern as the rules backfill: the cursor lives
 * in D1 (mail_export.cursor), each batch appends one R2 part object
 * (`export/{orgId}/{exportId}/part-NNNNN`), the job re-enqueues itself until
 * done, and the download route streams the parts in order. Parts are stored
 * with the same at-rest encryption as everything else; the download is
 * plaintext by definition, so the UI must say so at the point of export, and
 * the mail_export row (who/when) is the audit record.
 */
export type MailboxExportJob = { kind: "mailbox_export"; exportId: string };

const BATCH = 50;

export function exportPartKey(orgId: string, exportId: string, seq: number): string {
  return `export/${orgId}/${exportId}/part-${String(seq).padStart(5, "0")}`;
}
export function exportSidecarKey(orgId: string, exportId: string): string {
  return `export/${orgId}/${exportId}/sidecar.json`;
}

export async function kickExport(
  db: Db,
  queue: Queue<MailboxExportJob>,
  input: { orgId: string; mailboxId: string; requestedByUserId: string },
): Promise<string> {
  const [row] = await db
    .insert(mail.mailExport)
    .values({ orgId: input.orgId, mailboxId: input.mailboxId, requestedByUserId: input.requestedByUserId })
    .returning({ id: mail.mailExport.id });
  // Audit trail: an export decrypts the whole mailbox.
  log.warn("export.requested", { exportId: row.id, mailboxId: input.mailboxId, by: input.requestedByUserId });
  await queue.send({ kind: "mailbox_export", exportId: row.id });
  return row.id;
}

/** RFC 4155-style From_ separator; body lines starting "From " get quoted. */
function mboxEscape(body: string): string {
  return body.replace(/^(>*)From /gm, ">$1From ");
}

function header(name: string, value: string | null | undefined): string {
  return value ? `${name}: ${value.replace(/[\r\n]+/g, " ")}\r\n` : "";
}

/**
 * Mark an export terminally failed with a reason.
 *
 * Retries still happen — the queue owns that — but each attempt leaves the
 * cause on the row, so a job that exhausts its retries ends visibly failed
 * rather than frozen at `running`. A later successful attempt overwrites the
 * status back to running/done, so a transient failure doesn't stick.
 */
export async function failExport(db: Db, exportId: string, cause: unknown): Promise<void> {
  await db
    .update(mail.mailExport)
    .set({
      status: "failed",
      error: String(cause instanceof Error ? cause.message : cause).slice(0, 300),
      completedAt: new Date(),
    })
    .where(eq(mail.mailExport.id, exportId));
}

/** One batch; re-enqueues itself until the mailbox is exhausted. */
export async function handleExportJob(db: Db, env: MailEnv, job: MailboxExportJob): Promise<void> {
  const exp = await db.query.mailExport.findFirst({ where: eq(schema.mailExport.id, job.exportId) });
  if (!exp || exp.status !== "running") return;
  const ck = await importKey(env.MAIL_DEK);

  const deliveries = await db
    .select({ deliveryId: mail.delivery.id, messageId: mail.delivery.messageId })
    .from(mail.delivery)
    .where(and(eq(mail.delivery.mailboxId, exp.mailboxId), gt(mail.delivery.id, exp.cursor)))
    .orderBy(asc(mail.delivery.id))
    .limit(BATCH);

  const blocks: string[] = [];
  const threadIds = new Set<string>();
  for (const del of deliveries) {
    const message = await db.query.message.findFirst({ where: eq(schema.message.id, del.messageId) });
    if (!message) continue;
    threadIds.add(message.threadId);

    // Doota state as X- headers (thread-level state repeated per message —
    // mbox has no thread container).
    const state = await db.query.threadState.findFirst({
      where: and(eq(schema.threadState.threadId, message.threadId), eq(schema.threadState.mailboxId, exp.mailboxId)),
      columns: { placement: true, assigneeUserId: true, snoozedUntil: true },
    });
    const labels = await db
      .select({ name: mail.label.name })
      .from(mail.threadLabel)
      .innerJoin(mail.label, eq(mail.threadLabel.labelId, mail.label.id))
      .where(and(eq(mail.threadLabel.threadId, message.threadId), eq(mail.threadLabel.mailboxId, exp.mailboxId)));
    let doota = "";
    doota += header("X-Doota-Thread-Id", message.threadId);
    doota += header("X-Doota-Placement", state?.placement);
    doota += header("X-Doota-Labels", labels.map((l) => l.name).join(",") || null);
    doota += header("X-Doota-Assigned-To", state?.assigneeUserId);
    doota += header("X-Doota-Snooze-Until", state?.snoozedUntil ? state.snoozedUntil.toISOString() : null);

    const fromLine = `From ${message.fromAddr ?? "MAILER-DAEMON"} ${new Date(message.sentAt?.getTime() ?? message.createdAt.getTime()).toUTCString()}\r\n`;

    // Inbound: the raw MIME is canonical (full fidelity, attachments intact).
    let rfc822: string | null = null;
    if (message.r2RawKey && !message.r2RawKey.startsWith("outbound/")) {
      const buf = await getDecryptedBlob(env.MAIL_RAW, message.r2RawKey, ck);
      if (buf) rfc822 = new TextDecoder().decode(buf);
    }
    if (rfc822 == null) {
      // Outbound (or lost raw): synthesize a minimal RFC822 from the row.
      const subject = (await decryptContent(ck, message.subjectEnc)) ?? "";
      const body = (await decryptContent(ck, message.bodyFullEnc)) ?? "";
      rfc822 =
        header("Message-ID", message.messageIdHeader) +
        header("From", message.fromAddr) +
        header("To", safeAddrs(message.toAddrs)) +
        header("Cc", safeAddrs(message.ccAddrs)) +
        header("Subject", subject) +
        header("Date", message.sentAt ? message.sentAt.toUTCString() : null) +
        header("In-Reply-To", message.inReplyTo) +
        header("References", message.references) +
        `Content-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
    }
    // The X-Doota headers are prepended to the message's header block:
    // valid RFC822 (header order is free) and trivially strippable.
    blocks.push(fromLine + doota + mboxEscape(rfc822) + "\r\n");
  }

  if (blocks.length) {
    const seq = exp.partCount + 1;
    await putEncryptedBlob(env.MAIL_RAW, exportPartKey(exp.orgId, exp.id, seq), ck, blocks.join(""), {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    await db
      .update(mail.mailExport)
      .set({
        cursor: deliveries[deliveries.length - 1].deliveryId,
        messageCount: exp.messageCount + blocks.length,
        partCount: seq,
      })
      .where(eq(mail.mailExport.id, exp.id));
  }

  if (deliveries.length === BATCH) {
    await (env.MAIL_QUEUE as unknown as Queue<MailboxExportJob>).send(job);
    return;
  }

  // Finalize: sidecar JSON (notes + assignment + full label sets per thread —
  // the state a header can't carry losslessly), then done.
  const allThreads = await db
    .select({ threadId: mail.threadState.threadId, placement: mail.threadState.placement, assignee: mail.threadState.assigneeUserId, snoozedUntil: mail.threadState.snoozedUntil, muted: mail.threadState.muted })
    .from(mail.threadState)
    .where(eq(mail.threadState.mailboxId, exp.mailboxId));
  const labelRows = allThreads.length
    ? await db
        .select({ threadId: mail.threadLabel.threadId, name: mail.label.name })
        .from(mail.threadLabel)
        .innerJoin(mail.label, eq(mail.threadLabel.labelId, mail.label.id))
        .where(
          and(
            eq(mail.threadLabel.mailboxId, exp.mailboxId),
            inArray(mail.threadLabel.threadId, allThreads.map((t) => t.threadId)),
          ),
        )
    : [];
  const labelsByThread = new Map<string, string[]>();
  for (const l of labelRows) labelsByThread.set(l.threadId, [...(labelsByThread.get(l.threadId) ?? []), l.name]);
  const sidecar = {
    version: 1,
    mailboxId: exp.mailboxId,
    threads: allThreads.map((t) => ({
      threadId: t.threadId,
      placement: t.placement,
      labels: labelsByThread.get(t.threadId) ?? [],
      assignedTo: t.assignee,
      snoozeUntil: t.snoozedUntil ? t.snoozedUntil.toISOString() : null,
      muted: t.muted,
    })),
  };
  await putEncryptedBlob(env.MAIL_RAW, exportSidecarKey(exp.orgId, exp.id), ck, JSON.stringify(sidecar), {
    httpMetadata: { contentType: "application/json" },
  });
  await db
    .update(mail.mailExport)
    .set({ status: "done", completedAt: new Date() })
    .where(eq(mail.mailExport.id, exp.id));
  log.warn("export.completed", { exportId: exp.id, mailboxId: exp.mailboxId, messages: exp.messageCount + blocks.length });
}

function safeAddrs(json: string | null): string | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) && parsed.length ? parsed.join(", ") : null;
  } catch {
    return null;
  }
}
