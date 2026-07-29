// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveApiAttachments } from "$lib/server/api-attachments.js";

const MAIL_DEK = btoa("0".repeat(32)); // 32-byte key

/** Minimal R2 stub — records puts so we can assert bytes landed. */
function bucket() {
  const store = new Map<string, unknown>();
  return { store, put: vi.fn(async (k: string, v: unknown) => void store.set(k, v)) };
}
function env(b = bucket()) {
  return { env: { MAIL_RAW: b as unknown as R2Bucket, MAIL_DEK }, bucket: b };
}
const b64 = (s: string) => btoa(s);

afterEach(() => vi.unstubAllGlobals());

describe("resolveApiAttachments", () => {
  it("stores inline base64 content encrypted and returns a ref", async () => {
    const { env: e, bucket: b } = env();
    const out = await resolveApiAttachments(e, "org1", [{ filename: "hi.txt", content: b64("hello"), contentType: "text/plain" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ filename: "hi.txt", contentType: "text/plain", size: 5 });
    expect(out[0].r2Key).toMatch(/^outbound-att\/org1\//);
    expect(b.put).toHaveBeenCalledOnce();
    // Stored bytes are the ENCRYPTED envelope, not the plaintext.
    expect(b.store.get(out[0].r2Key)).not.toEqual(new TextEncoder().encode("hello"));
  });

  it("rejects an attachment without a filename", async () => {
    await expect(resolveApiAttachments(env().env, "o", [{ content: b64("x") }])).rejects.toMatchObject({ status: 400 });
  });

  it("requires exactly one of content or url", async () => {
    await expect(resolveApiAttachments(env().env, "o", [{ filename: "a", content: b64("x"), url: "https://x/y" }])).rejects.toMatchObject({ status: 400 });
    await expect(resolveApiAttachments(env().env, "o", [{ filename: "a" }])).rejects.toMatchObject({ status: 400 });
  });

  it("rejects more than the max attachment count", async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ filename: `f${i}`, content: b64("x") }));
    await expect(resolveApiAttachments(env().env, "o", many)).rejects.toMatchObject({ status: 413 });
  });

  it("blocks a url pointing at a private/loopback host (SSRF)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(resolveApiAttachments(env().env, "o", [{ filename: "x", url: "http://127.0.0.1/secret" }])).rejects.toMatchObject({ status: 400 });
    expect(spy).not.toHaveBeenCalled(); // never even fetched
  });

  it("fetches a remote url and stores it, taking the response content-type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "application/pdf", "content-length": "4" } })),
    );
    const { env: e, bucket: b } = env();
    const out = await resolveApiAttachments(e, "org1", [{ filename: "doc.pdf", url: "https://files.example.com/doc.pdf" }]);
    expect(out[0]).toMatchObject({ filename: "doc.pdf", contentType: "application/pdf", size: 4 });
    expect(b.put).toHaveBeenCalledOnce();
  });
});
