// SPDX-License-Identifier: Apache-2.0
// Web Push sender (docs/notifications.md, Phase B). Pure WebCrypto — VAPID ES256
// JWT (RFC 8292) + aes128gcm payload encryption (RFC 8291 over RFC 8188). No
// dependency; runs on CF Workers and Node (crypto.subtle). Delivers a
// notification with the app closed; a 404/410 from the push service means the
// subscription is gone and the caller prunes it.
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";

type Db = DrizzleD1Database<typeof schema>;

export type WebPushEnv = {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};

/** Structural-only, same rule as the notification row — no subject/body leaks. */
export type PushPayload = { title: string; body?: string; url?: string; tag?: string };

const enc = new TextEncoder();
// TS lib nit: a Uint8Array is generic over ArrayBufferLike, but the WebCrypto /
// fetch signatures want an ArrayBuffer-backed BufferSource. The values here are
// always ArrayBuffer-backed at runtime — cast at the boundary.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

// --- base64url --------------------------------------------------------------
export function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64url(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", bs(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, bs(data)));
}

// --- VAPID (RFC 8292) -------------------------------------------------------
async function importVapidKey(publicB64: string, privateB64: string): Promise<CryptoKey> {
  const pub = b64urlToBytes(publicB64); // 0x04 || x(32) || y(32)
  const d = b64urlToBytes(privateB64); // 32
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: bytesToB64url(d), x: bytesToB64url(pub.slice(1, 33)), y: bytesToB64url(pub.slice(33, 65)), ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function vapidAuthHeader(env: WebPushEnv, endpoint: string): Promise<string> {
  const url = new URL(endpoint);
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64url(
    enc.encode(
      JSON.stringify({
        aud: `${url.protocol}//${url.host}`,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: env.VAPID_SUBJECT || "mailto:admin@doota.app",
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const key = await importVapidKey(env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bs(enc.encode(signingInput))));
  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// --- aes128gcm payload (RFC 8291 key derivation over RFC 8188 coding) --------
export async function encryptPayload(plaintext: Uint8Array, uaPublicB64: string, authB64: string): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(uaPublicB64); // 65
  const authSecret = b64urlToBytes(authB64); // 16
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const as = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", as.publicKey)) as ArrayBuffer); // 65
  const uaKey = await crypto.subtle.importKey("raw", bs(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  // The runtime (and the WebCrypto spec) take `public`; @cloudflare/workers-types
  // names it `$public`, so cast the params to satisfy the compiler either way.
  const deriveParams = { name: "ECDH", public: uaKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(deriveParams, as.privateKey, 256));

  // RFC 8291 §3.4: IKM = HKDF(salt=auth, ikm=ecdh, info="WebPush: info\0"||ua||as, 32)
  const prkCombined = await hmac(authSecret, ecdh);
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = (await hmac(prkCombined, concat(keyInfo, Uint8Array.of(1)))).slice(0, 32);

  // RFC 8188: PRK=HKDF-Extract(salt, ikm); CEK/NONCE = HKDF-Expand(PRK, info\0\x01)
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), Uint8Array.of(1)))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), Uint8Array.of(1)))).slice(0, 12);

  const cekKey = await crypto.subtle.importKey("raw", bs(cek), { name: "AES-GCM" }, false, ["encrypt"]);
  const record = concat(plaintext, Uint8Array.of(2)); // 0x02 = last-record delimiter
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(nonce), tagLength: 128 }, cekKey, bs(record)));

  // header: salt(16) || rs(uint32=4096) || idlen(1)=65 || keyid(as_public)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, Uint8Array.of(asPublic.length), asPublic, cipher);
}

// --- send -------------------------------------------------------------------
/** Encrypt + POST one push. Returns the HTTP status (404/410 = gone → prune). */
export async function sendWebPush(
  env: WebPushEnv,
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload,
): Promise<number> {
  const body = await encryptPayload(enc.encode(JSON.stringify(payload)), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthHeader(env, sub.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "2419200", // 28 days
    },
    body: bs(body) as BodyInit,
  });
  return res.status;
}

/** Fan a payload to all of a user's subscriptions; prune the dead ones. No-op
 * when VAPID isn't configured. Best-effort — never throws to the caller. */
export async function sendPushToUser(db: Db, env: WebPushEnv, userId: string, payload: PushPayload): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
  const subs = await db
    .select({ endpoint: mail.pushSubscription.endpoint, p256dh: mail.pushSubscription.p256dh, auth: mail.pushSubscription.auth })
    .from(mail.pushSubscription)
    .where(eq(mail.pushSubscription.userId, userId));
  for (const sub of subs) {
    try {
      const status = await sendWebPush(env, sub, payload);
      if (status === 404 || status === 410) {
        await db.delete(mail.pushSubscription).where(eq(mail.pushSubscription.endpoint, sub.endpoint));
      }
    } catch {
      // transient push-service error — leave it; a later event retries
    }
  }
}
