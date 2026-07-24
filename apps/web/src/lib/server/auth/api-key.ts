// SPDX-License-Identifier: Apache-2.0
/**
 * Programmatic bearer API keys for external send (Part I). App-owned (Better
 * Auth's apiKey plugin isn't present at the pinned better-auth version) but kept
 * INSIDE the auth boundary: creation, hashing, and verification live here so key
 * handling is auditable in one place, like every other auth concern.
 *
 * A key acts as its owning user. verify() returns the actor identity; the caller
 * runs the SAME can() send-capability check as an interactive session — there is
 * no parallel permission path. Only the SHA-256 of the secret is stored; the
 * plaintext is returned once at creation and never again.
 *
 * SCOPE: these keys are SEND-ONLY. The single bearer-authenticated endpoint is
 * POST /api/send (verifyApiKey is imported nowhere else); every other surface
 * requires an interactive session or a distinct secret (e.g. CRON_SECRET). A key
 * grants no account, admin, or read access — only enqueuing outbound mail.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { apiKey } from "@doota/db/mail.schema";

type Db = DrizzleD1Database<typeof schema>;

const KEY_BYTES = 32;
const PREFIX_LEN = 12; // stored cleartext for display ("dk_1a2b3c…"), not secret.

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

/** The identity a valid key authenticates as, plus any mailbox restriction. */
export type ApiKeyActor = {
  keyId: string;
  /** Legacy human owner; null for service keys (they authorize the mailbox). */
  userId: string | null;
  orgId: string;
  /** The mailbox the key sends as. Required (non-null) for service keys. */
  mailboxId: string | null;
  /** Service keys send AS the mailbox directly — no per-user grant is consulted. */
  isService: boolean;
};

/* Legacy per-user key creation removed — programmatic send is now a
 * service-mailbox concern (admins issue keys against service mailboxes). Existing
 * user-tied keys keep working via the userId path in verifyApiKey / resolveSender. */

/**
 * Mint a SERVICE key against a service mailbox. Returns the PLAINTEXT secret once
 * — only its hash is persisted. The key sends as the mailbox itself (no owning
 * user), so it survives staff turnover; `createdByUserId` is audit only. The
 * caller has already authorized this (org-admin) through can().
 */
export async function createServiceApiKey(
  db: Db,
  input: { orgId: string; mailboxId: string; createdByUserId: string; name?: string },
): Promise<{ id: string; key: string; prefix: string }> {
  const secret = `dk_${hex(crypto.getRandomValues(new Uint8Array(KEY_BYTES)).buffer)}`;
  const keyHash = await sha256Hex(secret);
  const prefix = secret.slice(0, PREFIX_LEN);
  const rows = await db
    .insert(apiKey)
    .values({
      orgId: input.orgId,
      userId: null,
      createdByUserId: input.createdByUserId,
      mailboxId: input.mailboxId,
      isService: true,
      name: input.name ?? null,
      keyHash,
      prefix,
    })
    .returning({ id: apiKey.id });
  return { id: rows[0].id, key: secret, prefix };
}

/**
 * Resolve a presented bearer secret to its actor, or null if unknown/revoked.
 * Constant-ish: a single indexed lookup by hash. Bumps last_used_at (best effort).
 */
export async function verifyApiKey(db: Db, presented: string): Promise<ApiKeyActor | null> {
  const secret = presented.trim();
  if (!secret.startsWith("dk_")) return null;
  const keyHash = await sha256Hex(secret);
  const row = await db.query.apiKey.findFirst({
    where: and(eq(apiKey.keyHash, keyHash), isNull(apiKey.revokedAt)),
    columns: { id: true, userId: true, orgId: true, mailboxId: true, isService: true },
  });
  if (!row) return null;
  await db.update(apiKey).set({ lastUsedAt: new Date() }).where(eq(apiKey.id, row.id));
  return {
    keyId: row.id,
    userId: row.userId,
    orgId: row.orgId,
    mailboxId: row.mailboxId,
    isService: row.isService,
  };
}

/** A key row for display — NEVER includes the hash or secret. */
export type ApiKeySummary = {
  id: string;
  name: string | null;
  prefix: string;
  mailboxId: string | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
};

/** A user's own keys, newest first (metadata only — no secret material). */
export async function listApiKeys(db: Db, userId: string): Promise<ApiKeySummary[]> {
  const rows = await db.query.apiKey.findMany({
    where: eq(apiKey.userId, userId),
    orderBy: desc(apiKey.createdAt),
    columns: {
      id: true,
      name: true,
      prefix: true,
      mailboxId: true,
      lastUsedAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    mailboxId: r.mailboxId,
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.getTime() : null,
    revokedAt: r.revokedAt ? r.revokedAt.getTime() : null,
    createdAt: r.createdAt.getTime(),
  }));
}

/** Service keys issued against a mailbox, newest first (admin management view). */
export async function listApiKeysForMailbox(db: Db, mailboxId: string): Promise<ApiKeySummary[]> {
  const rows = await db.query.apiKey.findMany({
    where: and(eq(apiKey.mailboxId, mailboxId), eq(apiKey.isService, true)),
    orderBy: desc(apiKey.createdAt),
    columns: {
      id: true,
      name: true,
      prefix: true,
      mailboxId: true,
      lastUsedAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    mailboxId: r.mailboxId,
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.getTime() : null,
    revokedAt: r.revokedAt ? r.revokedAt.getTime() : null,
    createdAt: r.createdAt.getTime(),
  }));
}

/** The mailbox + org a key belongs to — for an authorization check before revoke. */
export async function apiKeyMailbox(
  db: Db,
  keyId: string,
): Promise<{ mailboxId: string | null; orgId: string; isService: boolean } | null> {
  const row = await db.query.apiKey.findFirst({
    where: eq(apiKey.id, keyId),
    columns: { mailboxId: true, orgId: true, isService: true },
  });
  return row ?? null;
}

/** The user id that owns a key, or null — for an ownership check before revoke. */
export async function apiKeyOwner(db: Db, keyId: string): Promise<string | null> {
  const row = await db.query.apiKey.findFirst({
    where: eq(apiKey.id, keyId),
    columns: { userId: true },
  });
  return row?.userId ?? null;
}

/** Revoke a key (soft — keeps the audit row). */
export async function revokeApiKey(db: Db, keyId: string): Promise<void> {
  await db.update(apiKey).set({ revokedAt: new Date() }).where(eq(apiKey.id, keyId));
}

/** Extract the bearer secret from an Authorization header, if present. */
export function bearerFromHeaders(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : null;
}
