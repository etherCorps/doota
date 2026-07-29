// SPDX-License-Identifier: Apache-2.0
// Resolve API-supplied attachments (Resend-shaped: inline base64 `content`, or a
// remote `url`) into ENCRYPTED R2 blobs, returning the refs enqueueSend stores on
// the message. Inline is decoded directly; url is fetched behind the same SSRF
// guard + redirect re-validation as the image proxy. Bytes are encrypted at rest
// (MAIL_DEK), identical to every other blob in the pipeline.
import { error } from "@sveltejs/kit";
import { importKey, putEncryptedBlob } from "@doota/mail-core/crypto";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "@doota/mail-core/drafts";
import { isBlockedHost } from "./ssrf";

const MAX_TOTAL_BYTES = 40 * 1024 * 1024; // per send
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export type ApiAttachmentInput = { filename?: unknown; content?: unknown; url?: unknown; contentType?: unknown };
export type StoredAttachment = { r2Key: string; filename: string; contentType: string; size: number };
type Env = { MAIL_RAW: R2Bucket; MAIL_DEK: string };

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]*,/, "").replace(/\s/g, ""); // tolerate a data: prefix
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Fetch a remote attachment behind the SSRF guard (re-checked on every hop). */
async function fetchRemote(rawUrl: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const validate = (u: URL): URL => {
    if (u.protocol !== "https:" && u.protocol !== "http:") error(400, "Attachment url must be http(s).");
    if (isBlockedHost(u.hostname)) error(400, "Attachment url host is not allowed.");
    return u;
  };
  let current: URL;
  try {
    current = validate(new URL(rawUrl));
  } catch (e) {
    if (e instanceof Error && "status" in e) throw e; // a thrown SvelteKit error
    error(400, `Invalid attachment url: ${rawUrl}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let res: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetch(current.href, {
        method: "GET",
        redirect: "manual", // follow by hand so each hop is re-validated
        signal: controller.signal,
        referrerPolicy: "no-referrer",
        headers: { "Accept-Encoding": "identity" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) error(502, "Bad redirect fetching attachment.");
        current = validate(new URL(loc, current.href));
        continue;
      }
      break;
    }
    if (!res || !res.ok) error(502, "Could not fetch the attachment url.");
    if (Number(res.headers.get("content-length") ?? "0") > MAX_ATTACHMENT_BYTES) error(413, "Attachment is too large.");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) error(413, "Attachment is too large.");
    const contentType = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
    return { bytes, contentType };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") error(504, "Attachment fetch timed out.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveApiAttachments(env: Env, orgId: string, inputs: ApiAttachmentInput[]): Promise<StoredAttachment[]> {
  if (!inputs.length) return [];
  if (inputs.length > MAX_ATTACHMENTS) error(413, `Too many attachments (max ${MAX_ATTACHMENTS}).`);
  const ck = await importKey(env.MAIL_DEK);
  const out: StoredAttachment[] = [];
  let total = 0;
  for (const a of inputs) {
    if (typeof a.filename !== "string" || !a.filename.trim()) error(400, "Each attachment needs a filename.");
    const filename = a.filename.trim();
    const hasContent = typeof a.content === "string" && a.content.length > 0;
    const hasUrl = typeof a.url === "string" && a.url.length > 0;
    if (hasContent === hasUrl) error(400, "Each attachment needs exactly one of `content` or `url`.");
    let contentType = typeof a.contentType === "string" && a.contentType ? a.contentType : "application/octet-stream";

    let bytes: Uint8Array;
    if (hasContent) {
      try {
        bytes = b64ToBytes(a.content as string);
      } catch {
        error(400, `Attachment "${filename}" content is not valid base64.`);
      }
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) error(413, "Attachment is too large.");
    } else {
      const fetched = await fetchRemote(a.url as string);
      bytes = fetched.bytes;
      if (!(typeof a.contentType === "string" && a.contentType)) contentType = fetched.contentType;
    }

    total += bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) error(413, "Attachments exceed the total size limit.");
    const r2Key = `outbound-att/${orgId}/${crypto.randomUUID()}`;
    await putEncryptedBlob(env.MAIL_RAW, r2Key, ck, bytes, { httpMetadata: { contentType } });
    out.push({ r2Key, filename, contentType, size: bytes.byteLength });
  }
  return out;
}
