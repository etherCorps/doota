// SPDX-License-Identifier: Apache-2.0
// Mailbox import — export's mirror. A browser slices an mbox into fixed-size
// plaintext chunks; each lands as its own encrypted R2 object; a resumable job
// walks them and materializes messages through the normal path.
//
// Why part objects and not an R2 multipart upload: putEncryptedBlob gzips and
// encrypts the whole object, and a whole-object cipher cannot be range-read —
// which the byte cursor depends on. Fixing the PLAINTEXT chunk size instead
// keeps `offset → part index` a division, and every byte stays encrypted at
// rest. Same layout export already uses.
//
// The job deliberately does NOT run the inbound stages. Rules, vacation and
// notify are all wrong for archived mail: nobody wants auto-replies to
// five-year-old threads or forty thousand push notifications.
import { and, eq } from "drizzle-orm";
import PostalMime from "postal-mime";
import * as mail from "@doota/db/mail.schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { getDecryptedBlob, putEncryptedBlob, type ContentKey } from "./crypto.js";
import { materializeMessage, materializeDelivery, type ParsedMessage } from "./materialize.js";
import { createLabel, applyLabel } from "./labels.js";
import { log } from "./log.js";

type Db = DrizzleD1Database<typeof schema>;

export type MailboxImportJob = { kind: "mailbox_import"; importId: string };

/** Plaintext bytes per uploaded chunk. The client MUST slice on exactly this
 * boundary (except the final chunk) or the cursor→part arithmetic breaks. */
export const PART_PLAINTEXT_BYTES = 8 * 1024 * 1024;

// Work ceilings for one invocation — whichever trips first.
//
// Each message costs a MIME parse, an encrypted R2 put, a handful of sequential
// D1 round-trips and an FTS index write, so a batch sized like export's (which
// only reads and concatenates) overruns the invocation. When that happens the
// cursor is never written, the job retries from the same offset, and it wedges
// permanently — status `running`, cursor 0, forever. Found exactly that way on
// a 120-message file.
//
// The time budget is the real guard: it adapts to whatever the runtime and the
// data actually cost, where a tuned message count only encodes today's guess.
const MAX_MESSAGES_PER_RUN = 12;
const MAX_BYTES_PER_RUN = 16 * 1024 * 1024;
const TIME_BUDGET_MS = 12_000;

export function importPartKey(orgId: string, importId: string, index: number): string {
  return `import/${orgId}/${importId}/part-${String(index).padStart(5, "0")}`;
}

// ------------------------------------------------------------------ mbox ---
// mbox is not one format. Our own export writes RFC 4155 escaping; Gmail
// Takeout writes mboxrd; Apple writes mboxcl2. They agree on one thing: a
// message starts at a line beginning "From ". Be liberal about the rest.

const FROM_ = [0x46, 0x72, 0x6f, 0x6d, 0x20]; // "From "

/** Is there a `From ` line starting at `at`? (Caller guarantees line start.) */
function isFromLine(bytes: Uint8Array, at: number): boolean {
  if (at + FROM_.length > bytes.length) return false;
  for (let i = 0; i < FROM_.length; i++) if (bytes[at + i] !== FROM_[i]) return false;
  return true;
}

/**
 * Byte offset of the next message separator strictly after `from`, or -1.
 * A separator is a "From " at the very start of the buffer or immediately
 * after a newline.
 */
export function nextSeparator(bytes: Uint8Array, from: number): number {
  for (let i = Math.max(from, 0); i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue; // '\n'
    if (isFromLine(bytes, i + 1)) return i + 1;
  }
  return -1;
}

/**
 * Undo mbox body escaping: a line of `>From `, `>>From `, … loses one `>`.
 * Leaves everything else byte-identical, so attachments survive.
 */
export function unescapeMboxBody(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let w = 0;
  let atLineStart = true;
  for (let i = 0; i < bytes.length; i++) {
    if (atLineStart && bytes[i] === 0x3e) {
      // '>' — only strip when the run of '>' is followed by "From "
      let j = i;
      while (j < bytes.length && bytes[j] === 0x3e) j++;
      if (isFromLine(bytes, j)) {
        i++; // drop exactly one '>'
        atLineStart = false;
        if (i < bytes.length) out[w++] = bytes[i];
        continue;
      }
    }
    out[w++] = bytes[i];
    atLineStart = bytes[i] === 0x0a;
  }
  return out.subarray(0, w);
}

/** Strip the leading `From ` envelope line — it is a separator, not a header. */
function stripEnvelopeLine(bytes: Uint8Array): Uint8Array {
  if (!isFromLine(bytes, 0)) return bytes;
  const nl = bytes.indexOf(0x0a);
  return nl === -1 ? bytes.subarray(0, 0) : bytes.subarray(nl + 1);
}

// ------------------------------------------------------------- part reads ---

/** Concatenated plaintext of parts covering [start, start+want), clipped to EOF. */
async function readFrom(
  env: { MAIL_RAW: R2Bucket },
  ck: ContentKey,
  orgId: string,
  importId: string,
  partCount: number,
  start: number,
  want: number,
): Promise<Uint8Array> {
  const firstPart = Math.floor(start / PART_PLAINTEXT_BYTES);
  const lastPart = Math.min(partCount - 1, Math.floor((start + want - 1) / PART_PLAINTEXT_BYTES));
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let index = firstPart; index <= lastPart; index++) {
    const bytes = await getDecryptedBlob(env.MAIL_RAW, importPartKey(orgId, importId, index), ck);
    if (!bytes) break; // a missing part truncates rather than throwing — the run ends early
    const view = new Uint8Array(bytes);
    chunks.push(view);
    total += view.length;
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined.subarray(start - firstPart * PART_PLAINTEXT_BYTES);
}

/** Same shape handleEmail uses to key a raw off its Message-ID. */
function safeKey(messageIdHeader: string): string {
  return messageIdHeader.replace(/[^a-zA-Z0-9._@-]/g, "_").slice(0, 200);
}

// ----------------------------------------------------------------- public ---

export async function startImport(
  db: Db,
  input: { orgId: string; mailboxId: string; requestedByUserId: string; filename: string; sizeBytes: number },
): Promise<string> {
  const [row] = await db
    .insert(mail.mailImport)
    .values({
      orgId: input.orgId,
      mailboxId: input.mailboxId,
      requestedByUserId: input.requestedByUserId,
      filename: input.filename.slice(0, 200),
      sizeBytes: input.sizeBytes,
      status: "uploading",
    })
    .returning({ id: mail.mailImport.id });
  log.warn("import.started", { importId: row.id, mailboxId: input.mailboxId, bytes: input.sizeBytes });
  return row.id;
}

/** Store one plaintext chunk as its own encrypted object. Idempotent per index. */
export async function putImportPart(
  db: Db,
  env: { MAIL_RAW: R2Bucket },
  ck: ContentKey,
  importId: string,
  index: number,
  bytes: ArrayBuffer,
): Promise<void> {
  const row = await db.query.mailImport.findFirst({ where: eq(mail.mailImport.id, importId) });
  if (!row) throw new Error("import not found");
  if (row.status !== "uploading") throw new Error("import is no longer accepting parts");
  await putEncryptedBlob(env.MAIL_RAW, importPartKey(row.orgId, importId, index), ck, bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  // Highest index wins, so an out-of-order or retried part can't shrink the count.
  await db
    .update(mail.mailImport)
    .set({ partCount: Math.max(row.partCount, index + 1) })
    .where(eq(mail.mailImport.id, importId));
}

export async function finishUpload(
  db: Db,
  queue: Queue<MailboxImportJob>,
  importId: string,
): Promise<void> {
  await db.update(mail.mailImport).set({ status: "queued" }).where(eq(mail.mailImport.id, importId));
  await queue.send({ kind: "mailbox_import", importId });
}

export async function cancelImport(db: Db, importId: string): Promise<void> {
  await db
    .update(mail.mailImport)
    .set({ status: "canceled", completedAt: new Date() })
    .where(eq(mail.mailImport.id, importId));
}

/**
 * The dated label, reused if it already exists. Two imports into one mailbox on
 * the same day produce the same name, and `label_mailbox_name_uidx` makes
 * createLabel throw on the second — which killed the whole job before it
 * imported anything. Look first, create second.
 */
async function ensureImportLabel(db: Db, orgId: string, mailboxId: string, at: Date): Promise<string> {
  const name = importLabelName(at);
  const existing = await db.query.label.findFirst({
    where: and(eq(mail.label.mailboxId, mailboxId), eq(mail.label.name, name)),
    columns: { id: true },
  });
  if (existing) return existing.id;
  const created = await createLabel(db, { mailboxId, orgId, name });
  return typeof created === "string" ? created : (created as { id: string }).id;
}

/** Label every imported thread carries — the undo handle. */
function importLabelName(at: Date): string {
  return `Imported ${at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
}

/**
 * One batch. Reads from the byte cursor, materializes whole messages, and
 * re-enqueues itself until the file is exhausted.
 */
export async function handleImportJob(
  db: Db,
  env: { MAIL_RAW: R2Bucket; MAIL_QUEUE: Queue<MailboxImportJob>; MAIL_DEK: string },
  ck: ContentKey,
  searchKeyB64: string,
  job: MailboxImportJob,
): Promise<void> {
  const row = await db.query.mailImport.findFirst({ where: eq(mail.mailImport.id, job.importId) });
  if (!row || row.status === "canceled" || row.status === "done") return;

  const box = await db.query.mailbox.findFirst({ where: eq(mail.mailbox.id, row.mailboxId) });
  if (!box) {
    await db
      .update(mail.mailImport)
      .set({ status: "failed", error: "mailbox no longer exists", completedAt: new Date() })
      .where(eq(mail.mailImport.id, row.id));
    return;
  }

  // Dated label, created once and reused across every batch of this import.
  const labelId = row.labelId ?? (await ensureImportLabel(db, row.orgId, row.mailboxId, row.createdAt ?? new Date()));

  await db
    .update(mail.mailImport)
    .set({ status: "running", labelId })
    .where(eq(mail.mailImport.id, row.id));

  const window = await readFrom(env, ck, row.orgId, row.id, row.partCount, row.cursor, MAX_BYTES_PER_RUN);
  if (window.length === 0 && row.cursor < row.sizeBytes) {
    // Nothing readable at the cursor but the file isn't finished: the parts are
    // gone or unreadable. Fail loudly rather than spin.
    await db
      .update(mail.mailImport)
      .set({ status: "failed", error: "The uploaded archive could not be read.", completedAt: new Date() })
      .where(eq(mail.mailImport.id, row.id));
    return;
  }
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let consumed = 0;

  // The window starts at a separator (or at byte 0 of the file).
  let messageStart = isFromLine(window, 0) ? 0 : Math.max(nextSeparator(window, 0), 0);
  const deadline = Date.now() + TIME_BUDGET_MS;
  while (imported + skipped + failed < MAX_MESSAGES_PER_RUN) {
    // Checkpoint rather than overrun: whatever is done so far gets its cursor
    // written, and the next invocation picks up from there.
    if (Date.now() > deadline) break;
    const next = nextSeparator(window, messageStart + 1);
    const atEndOfFile = row.cursor + window.length >= row.sizeBytes;
    // A message with no following separator is only complete at EOF; otherwise
    // it may straddle the window and must wait for the next run.
    if (next === -1 && !atEndOfFile) break;
    const end = next === -1 ? window.length : next;
    if (end <= messageStart) break;

    const raw = unescapeMboxBody(stripEnvelopeLine(window.subarray(messageStart, end)));
    const outcome = await importOne(db, env, row.orgId, row.mailboxId, labelId, raw, { ck, searchKeyB64 });
    if (outcome === "imported") imported++;
    else if (outcome === "skipped") skipped++;
    else failed++;

    consumed = end;
    messageStart = end;
    if (next === -1) break;
  }

  const madeProgress = consumed > 0;
  const reachedEnd = row.cursor + consumed >= row.sizeBytes;
  // No progress AND not at the end means this run couldn't consume a single
  // message — a stall, not a completion. Fail it rather than loop forever.
  const stalled = !madeProgress && !reachedEnd;
  const done = reachedEnd;
  await db
    .update(mail.mailImport)
    .set({
      cursor: row.cursor + (consumed || 0),
      messageCount: row.messageCount + imported,
      skippedCount: row.skippedCount + skipped,
      failedCount: row.failedCount + failed,
      ...(done ? { status: "done" as const, completedAt: new Date() } : {}),
      ...(stalled
        ? {
            status: "failed" as const,
            error: "Stopped: a message in this archive could not be read.",
            completedAt: new Date(),
          }
        : {}),
    })
    .where(eq(mail.mailImport.id, row.id));

  if (stalled) {
    log.error("import.stalled", { importId: row.id, cursor: row.cursor });
    return;
  }
  if (!done) {
    await env.MAIL_QUEUE.send(job);
    return;
  }
  // Success frees the staged archive; a failure keeps it so a retry doesn't
  // mean re-uploading gigabytes.
  for (let index = 0; index < row.partCount; index++) {
    await env.MAIL_RAW.delete(importPartKey(row.orgId, row.id, index)).catch(() => {});
  }
  log.warn("import.completed", {
    importId: row.id,
    imported: row.messageCount + imported,
    skipped: row.skippedCount + skipped,
    failed: row.failedCount + failed,
  });
}

/** Materialize one raw message. Returns what happened, for the counters. */
async function importOne(
  db: Db,
  env: { MAIL_RAW: R2Bucket },
  orgId: string,
  mailboxId: string,
  labelId: string,
  raw: Uint8Array,
  deps: { ck: ContentKey; searchKeyB64: string },
): Promise<"imported" | "skipped" | "failed"> {
  try {
    const parsed = (await PostalMime.parse(raw)) as {
      messageId?: string | null;
      inReplyTo?: string | null;
      references?: string | null;
      subject?: string | null;
      date?: string | null;
      text?: string | null;
      html?: string | null;
      from?: { address?: string | null } | null;
      headers?: { key: string; value: string }[];
    };
    const headerId = parsed.messageId ?? null;
    if (!headerId) return "failed"; // no id, no dedupe — refuse rather than duplicate on re-import

    const already = await db.query.message.findFirst({
      where: and(eq(mail.message.orgId, orgId), eq(mail.message.messageIdHeader, headerId)),
      columns: { id: true },
    });

    const header = (name: string) =>
      parsed.headers?.find((h) => h.key.toLowerCase() === name)?.value ?? null;

    const pm: ParsedMessage = {
      messageIdHeader: headerId,
      inReplyTo: parsed.inReplyTo ?? null,
      references: parsed.references ?? null,
      from: parsed.from?.address ?? "",
      subject: parsed.subject ?? "",
      sentAt: parsed.date ? Date.parse(parsed.date) || Date.now() : Date.now(),
      text: parsed.text ?? null,
      html: parsed.html ?? null,
      // The raw is canonical: bodies and attachments are derived from it on
      // render, so an imported message needs its own durable copy exactly like
      // one that arrived off the wire. The staged archive parts are transient
      // and get deleted when the import finishes.
      r2RawKey: `raw/${orgId}/${safeKey(headerId)}`,
      attachments: [],
    };
    if (!already) {
      await putEncryptedBlob(env.MAIL_RAW, pm.r2RawKey!, deps.ck, raw, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
    }
    const { messageId, threadId } = await materializeMessage(db, orgId, pm, deps);
    await materializeDelivery(db, {
      orgId,
      messageId,
      threadId,
      mailboxId,
      role: "to",
      viaAliasId: null,
      subaddressTag: null,
      sentAt: pm.sentAt,
      // Archived by default: dumping a decade of Gmail into the inbox destroys
      // the mailbox someone was trying to move into. A Doota→Doota round trip
      // restores the original placement from the header we wrote on export.
      placement: {
        newThread: (header("x-doota-placement") ?? "archived").toLowerCase(),
        unarchiveOnReply: false,
      },
      isRead: true,
    });
    await applyLabel(db, { threadId, mailboxId, labelId }).catch(() => {});
    return already ? "skipped" : "imported";
  } catch (err) {
    log.debug("import.message_failed", { err: String(err).slice(0, 160) });
    return "failed";
  }
}
