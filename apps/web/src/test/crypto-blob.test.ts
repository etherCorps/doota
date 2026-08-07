// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  importKey,
  packBlob,
  unpackBlob,
  encryptBytes,

  decryptBytes,
  putEncryptedBlob,
  getDecryptedBlob,
} from "@doota/mail-core/crypto";

const KEY = btoa("0123456789abcdef0123456789abcdef");

// A tiny in-memory R2 stand-in (stores the exact bytes written).
function fakeBucket() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    async put(key: string, value: ArrayBuffer | ArrayBufferView | string) {
      const b =
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      store.set(key, new Uint8Array(b));
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const v = store.get(key)!;
      return { async arrayBuffer() { return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer; } };
    },
  };
}

describe("content blob crypto (R2 at rest)", () => {
  it("packBlob → unpackBlob round-trips (gzip + AES-GCM)", async () => {
    const ck = await importKey(KEY);
    const data = new TextEncoder().encode("<html>".repeat(5000)); // compressible
    const packed = await packBlob(ck, data);
    expect(packed.length).toBeLessThan(data.length); // gzip shrank it
    expect(packed[0]).toBe(1); // version byte
    const back = await unpackBlob(ck, packed);
    expect(new TextDecoder().decode(back)).toBe("<html>".repeat(5000));
  });

  it("encryptBytes → decryptBytes round-trips; a wrong key throws", async () => {
    const ck = await importKey(KEY);
    const other = await importKey(btoa("ffffffffffffffffffffffffffffffff"));
    const blob = await encryptBytes(ck, new Uint8Array([1, 2, 3, 4]));
    expect([...(await decryptBytes(ck, blob))]).toEqual([1, 2, 3, 4]);
    await expect(decryptBytes(other, blob)).rejects.toThrow();
  });

  it("decryptBytes rejects a plaintext (non-envelope) blob", async () => {
    const ck = await importKey(KEY);
    await expect(decryptBytes(ck, new TextEncoder().encode("raw plaintext"))).rejects.toThrow();
  });

  it("unpackBlob FAILS CLOSED on a plaintext (non-envelope) blob", async () => {
    const ck = await importKey(KEY);
    const plaintext = new TextEncoder().encode("Received: from mx\r\n\r\nold plaintext email");
    // No 0x01 version byte → rejected, never served as content (encrypted-only
    // read path; legacy plaintext must be re-encrypted before release).
    await expect(unpackBlob(ck, plaintext)).rejects.toThrow();
  });

  it("putEncryptedBlob stores ciphertext; getDecryptedBlob recovers it", async () => {
    const ck = await importKey(KEY);
    const bucket = fakeBucket();
    await putEncryptedBlob(bucket, "raw/x", ck, "From: a@b\r\n\r\nsecret body");
    // On disk it is NOT the plaintext.
    expect(new TextDecoder().decode(bucket.store.get("raw/x")!)).not.toContain("secret body");
    const back = await getDecryptedBlob(bucket, "raw/x", ck);
    expect(new TextDecoder().decode(back!)).toBe("From: a@b\r\n\r\nsecret body");
    expect(await getDecryptedBlob(bucket, "missing", ck)).toBeNull();
  });
});
