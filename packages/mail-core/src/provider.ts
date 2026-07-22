/**
 * Provider seam. Cloudflare Email Service is the sole provider (public beta — a
 * named dependency risk), behind the `MailProvider` interface. Nothing
 * provider-specific leaks past it: the consumer builds an `OutboundEmail` and
 * calls send(); classification of failures is by the `permanent` flag on the
 * thrown error, never by provider payload shape.
 */

/** One provider call's worth of mail. Recipients are already chunked (≤50). */
export type OutboundEmail = {
  from: { name?: string; email: string };
  to: string[];
  cc?: string[];
  /** Envelope-only: never rendered into transmitted To/Cc headers. */
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  /** Message-ID / In-Reply-To / References — we own the Message-ID. */
  headers?: Record<string, string>;
  /** `contentId` set → inline (referenced by `cid:` in the html), else a normal
   *  file attachment. */
  attachments?: { filename: string; contentType: string; content: ArrayBuffer; contentId?: string }[];
};

export type SendResult = { providerMessageId: string };

/** Thrown on send failure. `permanent` → hard (no retry); else soft (retry). */
export class ProviderSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderSendError";
  }
}

export interface MailProvider {
  readonly name: string;
  send(email: OutboundEmail): Promise<SendResult>;
}

export type ProviderEnv = {
  EMAIL_SENDER?: SendEmail;
};

/**
 * Cloudflare Email Service via the `EMAIL_SENDER` binding's structured builder —
 * which gives BCC-as-envelope-only, custom threading headers, and attachments
 * natively, so no raw MIME is hand-assembled here. The binding sets the DKIM +
 * return-path itself from the onboarded sending subdomain, so envelope-from is
 * not passed. A 4xx/transient failure surfaces as soft (retryable); a 5xx / bad
 * request as permanent. The result carries only a message id — per-recipient
 * outcomes arrive later as DSNs to the return-path (see bounce.ts).
 */
class CloudflareProvider implements MailProvider {
  readonly name = "cloudflare";
  constructor(private readonly sender: SendEmail) {}

  async send(email: OutboundEmail): Promise<SendResult> {
    // Cloudflare Email Sending only accepts whitelisted + X-* headers and sets
    // Message-ID itself — passing our own is rejected ("custom header 'Message-ID'
    // is not allowed"). Keep the threading headers it does accept; drop the rest.
    const headers = filterCloudflareHeaders(email.headers);
    try {
      const res = await this.sender.send({
        from: email.from.name ? { name: email.from.name, email: email.from.email } : email.from.email,
        subject: email.subject,
        // `to` is required by the builder type (empty array for a bcc-only
        // overflow chunk — the destinations union still has ≥1 via bcc).
        to: email.to,
        ...(email.cc?.length ? { cc: email.cc } : {}),
        ...(email.bcc?.length ? { bcc: email.bcc } : {}),
        ...(headers ? { headers } : {}),
        ...(email.text ? { text: email.text } : {}),
        ...(email.html ? { html: email.html } : {}),
        ...(email.attachments?.length
          ? {
              attachments: email.attachments.map((a) =>
                a.contentId
                  ? {
                      disposition: "inline" as const,
                      contentId: a.contentId,
                      filename: a.filename,
                      type: a.contentType,
                      content: base64(a.content),
                    }
                  : {
                      disposition: "attachment" as const,
                      filename: a.filename,
                      type: a.contentType,
                      content: base64(a.content),
                    },
              ),
            }
          : {}),
      });
      // EMAIL_SENDER may be a REMOTE binding, so `res` is an RPC stub at runtime
      // even though the static type says POJO. Await the id off it, then dispose
      // the stub — supporting EITHER disposal symbol (remote stubs can expose
      // asyncDispose, and `Symbol.dispose?.()` alone silently no-ops those) — or
      // the runtime warns ("An RPC stub was not disposed properly"). The finally
      // guarantees disposal even if the read throws. Local POJO binding: no-op.
      try {
        return { providerMessageId: await res.messageId };
      } finally {
        const d = res as { [Symbol.dispose]?(): void; [Symbol.asyncDispose]?(): Promise<void> };
        const asyncDispose = d[Symbol.asyncDispose];
        if (asyncDispose) await asyncDispose.call(d);
        else d[Symbol.dispose]?.();
      }
    } catch (e) {
      // ponytail: the binding surfaces little structure today; treat as soft
      // (retryable) unless the message clearly reads as a permanent rejection.
      // Tighten once Email Service exposes typed errors past beta.
      const msg = e instanceof Error ? e.message : String(e);
      const permanent = /\b(5\d\d|invalid|malformed|rejected|not allowed)\b/i.test(msg);
      throw new ProviderSendError(msg, permanent, e);
    }
  }
}

/** ArrayBuffer → base64 string. The EMAIL_SENDER binding can't serialize a raw
 *  ArrayBuffer ("Cannot serialize value: [object ArrayBuffer]") — content must be
 *  a base64 string. */
function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CH = 0x8000; // chunk to avoid arg-count limits on large images
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

/**
 * Headers Cloudflare Email Sending accepts: threading (In-Reply-To, References)
 * plus any X-* header. Message-ID and everything else are dropped — the binding
 * rejects unknown headers and sets Message-ID itself. Returns undefined if none
 * survive (so the send omits the field entirely).
 */
const CF_ALLOWED_HEADERS = new Set(["in-reply-to", "references"]);
function filterCloudflareHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (CF_ALLOWED_HEADERS.has(key) || key.startsWith("x-")) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The active provider from bindings: Cloudflare Email Service when its binding is
 * present. Returns null when it's absent (dev with no bindings) so the caller can
 * no-op instead of pretending to send.
 */
export function selectProvider(env: ProviderEnv): MailProvider | null {
  if (env.EMAIL_SENDER) return new CloudflareProvider(env.EMAIL_SENDER);
  return null;
}
