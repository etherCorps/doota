/**
 * Zero-access content encryption (ARCHITECTURE.md §1). Subject and bodies are
 * encrypted at rest with AES-256-GCM (WebCrypto). Routing/threading metadata
 * stays cleartext so the hot path and threading never decrypt. This is
 * zero-access at rest, NOT E2EE — operator oversight is intended.
 *
 * The DEK is an instance secret (Worker secret / Secrets Store), passed in as a
 * base64 32-byte key — NEVER stored in D1. Envelope format is versioned and
 * key-id-tagged so rotation is an additive envelope change, not a re-encrypt:
 *
 *   v1.<keyId>.<base64(iv)>.<base64(ciphertext+tag)>
 */

const ENC = "v1";
const IV_BYTES = 12;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
/**
 * base64 → bytes, tolerant of base64url and stray whitespace/padding — env
 * secrets arrive from many generators (`openssl rand -base64`, base64url
 * tooling, copy/paste with newlines) and Workers' atob() is strict.
 */
export function b64ToBytes(s: string): Uint8Array {
  const norm = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const unb64 = b64ToBytes;

export type ContentKey = { keyId: string; key: CryptoKey };

/**
 * Import a base64 32-byte DEK into an AES-GCM CryptoKey. `keyId` tags the
 * envelope so a rotated key can still decrypt old rows (look up by id).
 */
export async function importKey(base64Key: string, keyId = "0"): Promise<ContentKey> {
  let raw: Uint8Array;
  try {
    raw = unb64(base64Key);
  } catch {
    throw new Error(
      "MAIL_DEK is not valid base64 — regenerate with `openssl rand -base64 32` and re-set the worker secret",
    );
  }
  if (raw.length !== 32) throw new Error(`MAIL_DEK must decode to 32 bytes, got ${raw.length}`);
  const key = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return { keyId, key };
}

/** Encrypt a string → versioned envelope. null/empty passes through as null. */
export async function encryptContent(
  ck: ContentKey,
  plaintext: string | null | undefined,
): Promise<string | null> {
  if (plaintext == null || plaintext === "") return null;
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(plaintext);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ck.key, data),
  );
  return `${ENC}.${ck.keyId}.${b64(iv)}.${b64(ct)}`;
}

/** Decrypt a v1 envelope. Returns null for null input; throws on tamper/bad key. */
export async function decryptContent(
  ck: ContentKey,
  envelope: string | null | undefined,
): Promise<string | null> {
  if (!envelope) return null;
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== ENC) {
    throw new Error("unrecognized content envelope");
  }
  const [, , ivB64, ctB64] = parts;
  const iv = unb64(ivB64);
  const ct = unb64(ctB64);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    ck.key,
    ct as BufferSource,
  );
  return new TextDecoder().decode(pt);
}
