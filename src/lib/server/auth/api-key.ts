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
 */
import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../db/schema.js";
import { apiKey } from "../db/mail.schema.js";

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
  userId: string;
  orgId: string;
  /** When set, the key may only send as this mailbox. */
  mailboxId: string | null;
};

/**
 * Mint a key. Returns the PLAINTEXT secret exactly once — only its hash is
 * persisted, so it cannot be recovered later. Caller has already authorized this
 * (org-admin / mailbox manager) through can().
 */
export async function createApiKey(
  db: Db,
  input: { orgId: string; userId: string; mailboxId?: string | null; name?: string },
): Promise<{ id: string; key: string; prefix: string }> {
  const secret = `dk_${hex(crypto.getRandomValues(new Uint8Array(KEY_BYTES)).buffer)}`;
  const keyHash = await sha256Hex(secret);
  const prefix = secret.slice(0, PREFIX_LEN);
  const rows = await db
    .insert(apiKey)
    .values({
      orgId: input.orgId,
      userId: input.userId,
      mailboxId: input.mailboxId ?? null,
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
    columns: { id: true, userId: true, orgId: true, mailboxId: true },
  });
  if (!row) return null;
  await db.update(apiKey).set({ lastUsedAt: new Date() }).where(eq(apiKey.id, row.id));
  return { keyId: row.id, userId: row.userId, orgId: row.orgId, mailboxId: row.mailboxId };
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
