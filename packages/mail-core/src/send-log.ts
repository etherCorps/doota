// SPDX-License-Identifier: Apache-2.0
/**
 * Service-account send log (docs/service-accounts.md § Send log). Two tiers:
 *   1. durable metadata — who/when/which key/which template/status/recipients;
 *   2. an ENCRYPTED, short-TTL `data` payload — the template merge variables,
 *      often PII — purged by the cron sweep after `dataExpiresAt`.
 * Rendered HTML is never stored; reconstruct from template + data while in TTL.
 * Variables flagged `sensitive` on the template are redacted before storage.
 */
import { and, desc, eq, isNotNull, lte } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { importKey, encryptContent, decryptContent } from "./crypto";

type Db = DrizzleD1Database<typeof schema>;

/** Default payload retention — 30 days, then the sweep nulls `data_cipher`. */
export const DEFAULT_DATA_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type LogSendInput = {
  orgId: string;
  mailboxId: string;
  apiKeyId?: string | null;
  submissionId?: string | null;
  templateId?: string | null;
  templateVersion?: number | null;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  status?: string;
  /** Merge payload passed to the template (or raw-send metadata). */
  data?: Record<string, unknown> | null;
  /** Variable names to drop before storage (template-flagged sensitive). */
  sensitiveKeys?: string[];
  /** Base64 DEK (MAIL_DEK) — required to encrypt the payload. */
  dek: string;
  /** Payload retention window; defaults to 30 days. */
  dataTtlMs?: number;
};

/** Strip sensitive keys from the payload; return the survivors + what was dropped. */
function redact(
  data: Record<string, unknown> | null | undefined,
  sensitive: string[] | undefined,
): { kept: Record<string, unknown> | null; redacted: string[] } {
  if (!data) return { kept: null, redacted: [] };
  const drop = new Set(sensitive ?? []);
  if (drop.size === 0) return { kept: data, redacted: [] };
  const kept: Record<string, unknown> = {};
  const redacted: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (drop.has(k)) redacted.push(k);
    else kept[k] = v;
  }
  return { kept: Object.keys(kept).length ? kept : null, redacted };
}

/**
 * Write one send-log row. The `data` payload is redacted then AES-GCM encrypted
 * with the instance DEK; only the ciphertext is stored, on a TTL. Best-effort:
 * the caller should not fail a send because logging failed.
 */
export async function logSendEvent(db: Db, input: LogSendInput): Promise<string> {
  const to = [...(input.to ?? []), ...(input.cc ?? []), ...(input.bcc ?? [])];
  const { kept, redacted } = redact(input.data, input.sensitiveKeys);
  const ck = await importKey(input.dek);
  const dataCipher = kept ? await encryptContent(ck, JSON.stringify(kept)) : null;
  const ttl = input.dataTtlMs ?? DEFAULT_DATA_TTL_MS;
  const rows = await db
    .insert(mail.sendEvent)
    .values({
      orgId: input.orgId,
      mailboxId: input.mailboxId,
      apiKeyId: input.apiKeyId ?? null,
      submissionId: input.submissionId ?? null,
      templateId: input.templateId ?? null,
      templateVersion: input.templateVersion ?? null,
      toAddresses: JSON.stringify(to),
      subject: input.subject ?? "",
      status: input.status ?? "queued",
      dataCipher,
      dataExpiresAt: dataCipher ? new Date(Date.now() + ttl) : null,
      redactedKeys: redacted.length ? JSON.stringify(redacted) : null,
    })
    .returning({ id: mail.sendEvent.id });
  return rows[0].id;
}

/** A send-log row for the UI — metadata only, no decrypted payload. */
export type SendEventSummary = {
  id: string;
  apiKeyId: string | null;
  templateId: string | null;
  templateVersion: number | null;
  toAddresses: string[];
  subject: string;
  status: string;
  dataAvailable: boolean;
  redactedKeys: string[];
  createdAt: number;
};

/** List a mailbox's send log, newest first (metadata only). Manager-gated by caller. */
export async function listSendEvents(
  db: Db,
  mailboxId: string,
  limit = 100,
): Promise<SendEventSummary[]> {
  const rows = await db
    .select({
      id: mail.sendEvent.id,
      apiKeyId: mail.sendEvent.apiKeyId,
      templateId: mail.sendEvent.templateId,
      templateVersion: mail.sendEvent.templateVersion,
      toAddresses: mail.sendEvent.toAddresses,
      subject: mail.sendEvent.subject,
      status: mail.sendEvent.status,
      dataCipher: mail.sendEvent.dataCipher,
      redactedKeys: mail.sendEvent.redactedKeys,
      createdAt: mail.sendEvent.createdAt,
    })
    .from(mail.sendEvent)
    .where(eq(mail.sendEvent.mailboxId, mailboxId))
    .orderBy(desc(mail.sendEvent.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    apiKeyId: r.apiKeyId,
    templateId: r.templateId,
    templateVersion: r.templateVersion,
    toAddresses: safeArr(r.toAddresses),
    subject: r.subject,
    status: r.status,
    dataAvailable: r.dataCipher != null,
    redactedKeys: safeArr(r.redactedKeys),
    createdAt: r.createdAt.getTime(),
  }));
}

/** Decrypt one event's payload (detail view). Null once purged past TTL. */
export async function readSendEventData(
  db: Db,
  id: string,
  dek: string,
): Promise<Record<string, unknown> | null> {
  const row = await db.query.sendEvent.findFirst({
    where: eq(mail.sendEvent.id, id),
    columns: { dataCipher: true },
  });
  if (!row?.dataCipher) return null;
  const ck = await importKey(dek);
  const json = await decryptContent(ck, row.dataCipher);
  return json ? (JSON.parse(json) as Record<string, unknown>) : null;
}

/**
 * Purge sweep — null out the encrypted payload of every event whose TTL is due.
 * Metadata rows are kept. Called from the cron worker. Returns rows purged.
 */
export async function purgeExpiredSendData(db: Db, now = new Date()): Promise<number> {
  const due = await db
    .select({ id: mail.sendEvent.id })
    .from(mail.sendEvent)
    .where(
      and(isNotNull(mail.sendEvent.dataCipher), lte(mail.sendEvent.dataExpiresAt, now)),
    );
  if (!due.length) return 0;
  for (const { id } of due) {
    await db
      .update(mail.sendEvent)
      .set({ dataCipher: null, dataExpiresAt: null })
      .where(eq(mail.sendEvent.id, id));
  }
  return due.length;
}

function safeArr(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
