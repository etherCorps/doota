// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { encryptPayload, b64urlToBytes, bytesToB64url } from "@doota/mail-core/web-push";

const te = new TextEncoder();
const concat = (...a: Uint8Array[]) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of a) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
const buf = (b: Uint8Array) => b as unknown as BufferSource; // lib DOM ArrayBufferLike nit
const hmac = async (k: Uint8Array, d: Uint8Array) => {
  const key = await crypto.subtle.importKey("raw", buf(k), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, buf(d)));
};

describe("web-push crypto", () => {
  it("base64url round-trips", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(40));
    expect([...b64urlToBytes(bytesToB64url(bytes))]).toEqual([...bytes]);
    expect(bytesToB64url(bytes)).not.toMatch(/[+/=]/); // url-safe, unpadded
  });

  it("encrypts a payload the subscriber can decrypt (RFC 8291/8188 round-trip)", async () => {
    // Stand in for the browser's subscription keypair + auth secret.
    const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
    const auth = crypto.getRandomValues(new Uint8Array(16));

    const plaintext = te.encode(JSON.stringify({ title: "New message", url: "/app" }));
    const body = await encryptPayload(plaintext, bytesToB64url(uaPublic), bytesToB64url(auth));

    // Parse the aes128gcm header: salt(16) | rs(4) | idlen(1) | keyid(as_public).
    const salt = body.slice(0, 16);
    const idlen = body[20];
    const asPublic = body.slice(21, 21 + idlen);
    const cipher = body.slice(21 + idlen);
    expect(idlen).toBe(65);

    // Derive the same keys from the SUBSCRIBER side (ECDH is symmetric).
    const asKey = await crypto.subtle.importKey("raw", buf(asPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const ecdh = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0], ua.privateKey, 256),
    );
    const prkCombined = await hmac(auth, ecdh);
    const keyInfo = concat(te.encode("WebPush: info\0"), uaPublic, asPublic);
    const ikm = (await hmac(prkCombined, concat(keyInfo, Uint8Array.of(1)))).slice(0, 32);
    const prk = await hmac(salt, ikm);
    const cek = (await hmac(prk, concat(te.encode("Content-Encoding: aes128gcm\0"), Uint8Array.of(1)))).slice(0, 16);
    const nonce = (await hmac(prk, concat(te.encode("Content-Encoding: nonce\0"), Uint8Array.of(1)))).slice(0, 12);

    const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
    const record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, cekKey, cipher));

    expect(record[record.length - 1]).toBe(2); // last-record delimiter
    expect(JSON.parse(new TextDecoder().decode(record.slice(0, -1)))).toEqual({ title: "New message", url: "/app" });
  });
});
