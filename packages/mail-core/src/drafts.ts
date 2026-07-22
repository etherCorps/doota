import { and, desc, eq, gt, isNotNull, lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { error } from "@sveltejs/kit";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { decryptContent, encryptContent, type ContentKey } from "./crypto";
import { resolveSender } from "./resolver";
import { enqueueSend, cancelSend, type OutboundEnv } from "./outbound";
import { stripHtmlTags } from "./mail-thread-contract";

/** A draft body is HTML (rich composer). Detect plain-text bodies so legacy/
 * plain content isn't mangled — wrap them into minimal HTML on send. */
function looksLikeHtml(s: string): boolean {
  return /<[a-z][\s\S]*>/i.test(s);
}
/** Tiptap serializes trailing blank lines/spaces as empty <p>s, <br>s and
 * &nbsp; — strip them from the tail so sent mail doesn't end with phantom
 * whitespace the recipient's client renders. */
function trimTrailingHtml(html: string): string {
  let prev: string;
  do {
    prev = html;
    html = html
      .replace(/(?:\s|&nbsp;|<br\s*\/?>)+(<\/(?:p|div)>)\s*$/i, "$1")
      .replace(/<(p|div)(?:\s[^>]*)?>\s*<\/\1>\s*$/i, "")
      .trimEnd();
  } while (html !== prev);
  return html;
}

function toHtmlAndText(body: string | null): { html: string | null; text: string | null } {
  if (!body) return { html: null, text: null };
  if (looksLikeHtml(body)) {
    const html = trimTrailingHtml(body);
    return { html: html || null, text: stripHtmlTags(html) || null };
  }
  // Plain text → escape + line breaks so it renders faithfully on the wire.
  const esc = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return { html: esc.replace(/\r?\n/g, "<br>"), text: body };
}

type Db = DrizzleD1Database<typeof schema>;

/**
 * Draft lifecycle (per-user compose state). A draft never becomes a `message`
 * by mutation — at Send a FRESH immutable message + submission are built from
 * its fields (via the existing outbound path) and the draft is retained as a
 * tombstone until the submission leaves its cancellable window, so undo can
 * restore an editable draft. See mail.schema.ts `draft` for the model.
 */

export type AttachmentRef = {
  r2Key: string;
  filename: string;
  contentType: string;
  size: number;
};

// Server-authoritative attachment limits (never trust the client).
export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB per file
export const MAX_DRAFT_ATTACH_TOTAL_BYTES = 40 * 1024 * 1024; // 40 MB per draft

const DRAFT_KINDS = ["new", "reply", "reply_all", "forward"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export type DraftInput = {
  mailboxId: string;
  kind: DraftKind;
  threadId?: string | null;
  inReplyToMessageId?: string | null;
  fromAliasId?: string | null;
  subaddressTag?: string | null;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string | null;
  body?: string | null;
};

export type DraftDTO = {
  id: string;
  orgId: string;
  mailboxId: string;
  kind: string;
  threadId: string | null;
  inReplyToMessageId: string | null;
  fromAliasId: string | null;
  subaddressTag: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  body: string | null;
  attachments: AttachmentRef[];
  status: string;
  clientRevision: number;
  updatedAt: number;
};

function jsonArray<T>(raw: string | null | undefined, fallback: T[] = []): T[] {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function preview(text: string | null, n = 140): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

/** Load a draft the user owns, or fail. Ownership is per createdByUserId. */
async function ownDraftRow(db: Db, draftId: string, userId: string) {
  const row = await db.query.draft.findFirst({
    where: eq(schema.draft.id, draftId),
  });
  if (!row) error(404, "Draft not found");
  if (row.createdByUserId !== userId) error(403, "Not your draft");
  return row;
}

async function toDTO(ck: ContentKey, row: typeof schema.draft.$inferSelect): Promise<DraftDTO> {
  const [subject, body] = await Promise.all([
    decryptContent(ck, row.subjectEnc),
    decryptContent(ck, row.bodyEnc),
  ]);
  return {
    id: row.id,
    orgId: row.orgId,
    mailboxId: row.mailboxId,
    kind: row.kind,
    threadId: row.threadId,
    inReplyToMessageId: row.inReplyToMessageId,
    fromAliasId: row.fromAliasId,
    subaddressTag: row.subaddressTag,
    to: jsonArray<string>(row.toAddrs),
    cc: jsonArray<string>(row.ccAddrs),
    bcc: jsonArray<string>(row.bccAddrs),
    subject,
    body,
    attachments: jsonArray<AttachmentRef>(row.attachments),
    status: row.status,
    clientRevision: row.clientRevision,
    updatedAt: row.updatedAt.getTime(),
  };
}

/**
 * Create a draft. `mailboxId`/`fromAliasId` are validated through the same
 * resolveSender() the send path uses, so a draft can never carry a sending
 * identity the user can't actually send as (re-checked again on send).
 */
export async function createDraft(
  db: Db,
  ck: ContentKey,
  userId: string,
  input: DraftInput,
): Promise<DraftDTO> {
  const sender = await resolveSender(db, userId, input.mailboxId, input.fromAliasId ?? null);
  const [subjectEnc, bodyEnc] = await Promise.all([
    encryptContent(ck, input.subject ?? null),
    encryptContent(ck, input.body ?? null),
  ]);
  const inserted = await db
    .insert(mail.draft)
    .values({
      orgId: sender.orgId,
      mailboxId: input.mailboxId,
      createdByUserId: userId,
      kind: input.kind,
      threadId: input.threadId ?? null,
      inReplyToMessageId: input.inReplyToMessageId ?? null,
      fromAliasId: sender.fromAliasId,
      subaddressTag: input.subaddressTag ?? null,
      toAddrs: JSON.stringify(input.to ?? []),
      ccAddrs: JSON.stringify(input.cc ?? []),
      bccAddrs: JSON.stringify(input.bcc ?? []),
      subjectEnc,
      bodyEnc,
    })
    .returning();
  return toDTO(ck, inserted[0]);
}

export type SaveResult =
  | { ok: true; clientRevision: number; updatedAt: number }
  | { ok: false; conflict: true; draft: DraftDTO };

/**
 * Autosave with optimistic-concurrency. The caller passes the revision it last
 * read; the compare-and-set update only fires when it still matches, then bumps
 * it. A stale write (same user, two tabs) returns { conflict, draft } with the
 * server's current state instead of silently overwriting.
 */
export async function saveDraft(
  db: Db,
  ck: ContentKey,
  userId: string,
  input: {
    draftId: string;
    clientRevision: number;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string | null;
    body?: string | null;
    fromAliasId?: string | null;
    subaddressTag?: string | null;
  },
): Promise<SaveResult> {
  const row = await ownDraftRow(db, input.draftId, userId);
  if (row.status !== "editing") error(409, "This draft has already been sent.");

  // Re-validate a changed sending identity through the send capability check.
  let fromAliasId = row.fromAliasId;
  if (input.fromAliasId !== undefined) {
    const sender = await resolveSender(db, userId, row.mailboxId, input.fromAliasId);
    fromAliasId = sender.fromAliasId;
  }

  const [subjectEnc, bodyEnc] = await Promise.all([
    input.subject !== undefined ? encryptContent(ck, input.subject) : Promise.resolve(row.subjectEnc),
    input.body !== undefined ? encryptContent(ck, input.body) : Promise.resolve(row.bodyEnc),
  ]);

  const next = row.clientRevision + 1;
  const updated = await db
    .update(mail.draft)
    .set({
      toAddrs: input.to !== undefined ? JSON.stringify(input.to) : row.toAddrs,
      ccAddrs: input.cc !== undefined ? JSON.stringify(input.cc) : row.ccAddrs,
      bccAddrs: input.bcc !== undefined ? JSON.stringify(input.bcc) : row.bccAddrs,
      subjectEnc,
      bodyEnc,
      fromAliasId,
      subaddressTag: input.subaddressTag !== undefined ? input.subaddressTag : row.subaddressTag,
      clientRevision: next,
    })
    .where(
      and(
        eq(mail.draft.id, input.draftId),
        eq(mail.draft.createdByUserId, userId),
        eq(mail.draft.clientRevision, input.clientRevision),
        eq(mail.draft.status, "editing"),
      ),
    )
    .returning({ rev: mail.draft.clientRevision, updatedAt: mail.draft.updatedAt });

  if (!updated[0]) {
    // Revision moved under us — return current state, don't clobber.
    const fresh = await ownDraftRow(db, input.draftId, userId);
    return { ok: false, conflict: true, draft: await toDTO(ck, fresh) };
  }
  return { ok: true, clientRevision: updated[0].rev, updatedAt: updated[0].updatedAt.getTime() };
}

export type DraftSummary = {
  id: string;
  mailboxId: string;
  kind: string;
  threadId: string | null;
  subject: string | null;
  snippet: string | null;
  to: string[];
  status: string;
  updatedAt: number;
};

/** A user's own editable drafts, most-recently-edited first. */
export async function listDrafts(db: Db, ck: ContentKey, userId: string): Promise<DraftSummary[]> {
  const rows = await db.query.draft.findMany({
    where: and(eq(schema.draft.createdByUserId, userId), eq(schema.draft.status, "editing")),
    orderBy: desc(schema.draft.updatedAt),
    limit: 100,
  });
  const out: DraftSummary[] = [];
  for (const r of rows) {
    const [subject, body] = await Promise.all([
      decryptContent(ck, r.subjectEnc),
      decryptContent(ck, r.bodyEnc),
    ]);
    out.push({
      id: r.id,
      mailboxId: r.mailboxId,
      kind: r.kind,
      threadId: r.threadId,
      subject,
      snippet: preview(body),
      to: jsonArray<string>(r.toAddrs),
      status: r.status,
      updatedAt: r.updatedAt.getTime(),
    });
  }
  return out;
}

export async function getDraft(
  db: Db,
  ck: ContentKey,
  draftId: string,
  userId: string,
): Promise<DraftDTO> {
  return toDTO(ck, await ownDraftRow(db, draftId, userId));
}

export type ScheduledSend = {
  submissionId: string;
  sendAt: number;
  subject: string | null;
  to: string | null;
};

/**
 * The user's pending scheduled sends (future send_at, still queued) — a place to
 * see and cancel them. Cancel goes through undoDraftSend (removes the pending
 * bubble + reopens the draft to edit/reschedule).
 */
export async function listScheduled(db: Db, ck: ContentKey, userId: string): Promise<ScheduledSend[]> {
  const rows = await db.query.submission.findMany({
    where: and(
      eq(schema.submission.createdByUserId, userId),
      eq(schema.submission.status, "queued"),
      isNotNull(schema.submission.sendAt),
      gt(schema.submission.sendAt, new Date()),
    ),
    orderBy: schema.submission.sendAt,
    columns: { id: true, sendAt: true, messageId: true },
    limit: 100,
  });
  const out: ScheduledSend[] = [];
  for (const r of rows) {
    const msg = await db.query.message.findFirst({
      where: eq(schema.message.id, r.messageId),
      columns: { subjectEnc: true },
    });
    const firstRecip = await db.query.submissionRecipient.findFirst({
      where: eq(schema.submissionRecipient.submissionId, r.id),
      columns: { address: true },
    });
    out.push({
      submissionId: r.id,
      sendAt: r.sendAt!.getTime(),
      subject: await decryptContent(ck, msg?.subjectEnc),
      to: firstRecip?.address ?? null,
    });
  }
  return out;
}

const STALE_DRAFT_MS = 14 * 24 * 60 * 60 * 1000; // 14 days untouched

/**
 * Garbage-collect abandoned drafts: still-editing rows untouched past the cutoff,
 * plus their staged R2 objects. Meant to run from the scheduled (cron) handler —
 * see sweepDueSubmissions for the same pattern. Returns the count removed.
 */
export async function sweepStaleDrafts(
  db: Db,
  env: OutboundEnv,
  olderThanMs = STALE_DRAFT_MS,
  limit = 200,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const stale = await db
    .select({ id: schema.draft.id, orgId: schema.draft.orgId })
    .from(schema.draft)
    .where(and(eq(schema.draft.status, "editing"), lt(schema.draft.updatedAt, cutoff)))
    .limit(limit);
  for (const d of stale) {
    await purgeDraftBlobs(env, d.orgId, d.id);
    await db.delete(mail.draft).where(eq(mail.draft.id, d.id));
  }
  return stale.length;
}

/** Delete R2 objects staged under a draft's prefix. */
async function purgeDraftBlobs(env: OutboundEnv, orgId: string, draftId: string): Promise<void> {
  const prefix = `draft/${orgId}/${draftId}/`;
  const listed = await env.MAIL_RAW.list({ prefix });
  await Promise.all(listed.objects.map((o) => env.MAIL_RAW.delete(o.key)));
}

/** Discard a draft: delete the row and garbage-collect its staged R2 objects. */
export async function discardDraft(
  db: Db,
  env: OutboundEnv,
  draftId: string,
  userId: string,
): Promise<void> {
  const row = await ownDraftRow(db, draftId, userId);
  await purgeDraftBlobs(env, row.orgId, draftId);
  await db.delete(mail.draft).where(eq(mail.draft.id, draftId));
}

/**
 * Stage an uploaded attachment: enforce count/size limits (server-authoritative,
 * BEFORE writing bytes), write it to R2 under the draft's prefix, and append the
 * ref. Returns the updated attachment list.
 */
export async function stageDraftAttachment(
  db: Db,
  env: OutboundEnv,
  draftId: string,
  userId: string,
  file: { name: string; type: string; size: number; bytes: ArrayBuffer },
): Promise<AttachmentRef[]> {
  const row = await ownDraftRow(db, draftId, userId);
  if (row.status !== "editing") error(409, "This draft has already been sent.");
  const current = jsonArray<AttachmentRef>(row.attachments);
  if (current.length >= MAX_ATTACHMENTS) error(413, "Too many attachments.");
  if (file.size > MAX_ATTACHMENT_BYTES) error(413, "Attachment is too large.");
  const total = current.reduce((n, a) => n + a.size, 0) + file.size;
  if (total > MAX_DRAFT_ATTACH_TOTAL_BYTES) error(413, "Attachments exceed the total size limit.");

  const key = `draft/${row.orgId}/${draftId}/${crypto.randomUUID()}`;
  await env.MAIL_RAW.put(key, file.bytes, { httpMetadata: { contentType: file.type } });
  const ref: AttachmentRef = {
    r2Key: key,
    filename: file.name,
    contentType: file.type,
    size: file.size,
  };
  const nextList = [...current, ref];
  await db
    .update(mail.draft)
    .set({ attachments: JSON.stringify(nextList) })
    .where(eq(mail.draft.id, draftId));
  return nextList;
}

/** Remove a staged attachment (deletes both the ref and the R2 object). */
/**
 * Read a draft attachment's bytes for its OWNER only — powers compose-time
 * thumbnails. Never public: ownership is checked (ownDraftRow) and the key must
 * belong to the draft's attachment list. Returns null when absent.
 */
export async function readDraftAttachment(
  db: Db,
  env: { MAIL_RAW: R2Bucket },
  draftId: string,
  userId: string,
  r2Key: string,
): Promise<{ body: ReadableStream; contentType: string; filename: string } | null> {
  const row = await ownDraftRow(db, draftId, userId);
  const ref = jsonArray<AttachmentRef>(row.attachments).find((a) => a.r2Key === r2Key);
  if (!ref) return null;
  const obj = await env.MAIL_RAW.get(r2Key);
  if (!obj) return null;
  return { body: obj.body, contentType: ref.contentType, filename: ref.filename };
}

export async function removeDraftAttachment(
  db: Db,
  env: OutboundEnv,
  draftId: string,
  userId: string,
  r2Key: string,
): Promise<AttachmentRef[]> {
  const row = await ownDraftRow(db, draftId, userId);
  const current = jsonArray<AttachmentRef>(row.attachments);
  const nextList = current.filter((a) => a.r2Key !== r2Key);
  // Only delete the object if it belonged to this draft's prefix (defensive).
  if (r2Key.startsWith(`draft/${row.orgId}/${draftId}/`)) {
    await env.MAIL_RAW.delete(r2Key);
  }
  await db
    .update(mail.draft)
    .set({ attachments: JSON.stringify(nextList) })
    .where(eq(mail.draft.id, draftId));
  return nextList;
}

/** Copy a staged draft object to an outbound key the message will own. */
async function copyToOutbound(env: OutboundEnv, orgId: string, ref: AttachmentRef): Promise<AttachmentRef> {
  const obj = await env.MAIL_RAW.get(ref.r2Key);
  if (!obj) error(409, "A staged attachment is missing; re-attach it and try again.");
  const newKey = `outbound/${orgId}/${crypto.randomUUID()}`;
  await env.MAIL_RAW.put(newKey, await obj.arrayBuffer(), {
    httpMetadata: { contentType: ref.contentType },
  });
  return { ...ref, r2Key: newKey };
}

/**
 * Send a draft through the EXISTING outbound path. Attachments are copied to
 * outbound keys (the message owns its own objects; the draft keeps its staged
 * copies for a possible undo-restore). The draft is retained as a `sent`
 * tombstone linked to the submission until the undo window closes.
 */
export async function sendDraft(
  db: Db,
  env: OutboundEnv,
  ck: ContentKey,
  userId: string,
  input: { draftId: string; sendAt?: number | null; undoSeconds?: number },
): Promise<{ submissionId: string; threadId: string }> {
  const row = await ownDraftRow(db, input.draftId, userId);
  if (row.status !== "editing") error(409, "This draft has already been sent.");

  const to = jsonArray<string>(row.toAddrs);
  const cc = jsonArray<string>(row.ccAddrs);
  const bcc = jsonArray<string>(row.bccAddrs);
  if (to.length + cc.length + bcc.length === 0) error(400, "At least one recipient is required.");

  // Same server-side identity re-check the interactive send does.
  const sender = await resolveSender(db, userId, row.mailboxId, row.fromAliasId);
  const [subject, body] = await Promise.all([
    decryptContent(ck, row.subjectEnc),
    decryptContent(ck, row.bodyEnc),
  ]);

  const staged = jsonArray<AttachmentRef>(row.attachments);
  const outboundAttachments = await Promise.all(staged.map((a) => copyToOutbound(env, row.orgId, a)));
  const { html, text } = toHtmlAndText(body);

  const res = await enqueueSend(db, env, {
    orgId: sender.orgId,
    mailboxId: row.mailboxId,
    createdByUserId: userId,
    fromAddress: sender.fromAddress,
    fromName: sender.fromName,
    fromAliasId: sender.fromAliasId,
    to,
    cc,
    bcc,
    subject: subject ?? "",
    text,
    html,
    parentMessageId: row.inReplyToMessageId,
    attachments: outboundAttachments,
    sendAt: input.sendAt ?? null,
    idempotencyKey: crypto.randomUUID(),
    undoSeconds: input.undoSeconds,
  });

  // Retain as a tombstone linked to the submission (undo can restore it).
  await db
    .update(mail.draft)
    .set({ status: "sent", submissionId: res.submissionId })
    .where(eq(mail.draft.id, input.draftId));

  return { submissionId: res.submissionId, threadId: res.threadId };
}

/**
 * Undo a draft's send within the window. Because `message` is immutable, we
 * DELETE the sender's timeline copy rather than mutate it, then reopen the
 * retained draft for editing — a retry mints a brand-new message (no duplicate).
 * Returns the reopened draft, or null if the window had already closed.
 */
export async function undoDraftSend(
  db: Db,
  env: OutboundEnv,
  ck: ContentKey,
  userId: string,
  submissionId: string,
): Promise<DraftDTO | null> {
  const sub = await db.query.submission.findFirst({
    where: eq(schema.submission.id, submissionId),
    columns: { id: true, messageId: true, mailboxId: true, createdByUserId: true },
  });
  if (!sub) error(404, "Submission not found");
  if (sub.createdByUserId !== userId) error(403, "Not your send to undo.");

  const canceled = await cancelSend(db, submissionId);
  if (!canceled) return null; // window closed / already sending — not undoable

  // Remove the sender's timeline copy so no ghost bubble remains.
  await db
    .delete(mail.delivery)
    .where(and(eq(mail.delivery.messageId, sub.messageId), eq(mail.delivery.role, "from")));
  const remaining = await db.query.delivery.findFirst({
    where: eq(schema.delivery.messageId, sub.messageId),
    columns: { id: true },
  });
  if (!remaining) {
    // Orphan message: delete its outbound attachment objects, then the row
    // (cascade drops attachment rows + the canceled submission).
    const atts = await db.query.attachment.findMany({
      where: eq(schema.attachment.messageId, sub.messageId),
      columns: { r2Key: true },
    });
    await Promise.all(atts.map((a) => (a.r2Key ? env.MAIL_RAW.delete(a.r2Key) : Promise.resolve())));
    await db.delete(mail.message).where(eq(mail.message.id, sub.messageId));
  }

  // Reopen the retained draft, if any.
  const draftRow = await db.query.draft.findFirst({
    where: eq(schema.draft.submissionId, submissionId),
  });
  if (!draftRow) return null;
  await db
    .update(mail.draft)
    .set({ status: "editing", submissionId: null })
    .where(eq(mail.draft.id, draftRow.id));
  return getDraft(db, ck, draftRow.id, userId);
}
