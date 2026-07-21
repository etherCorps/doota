/**
 * Provider seam. Cloudflare Email Service is primary (public beta — a named
 * dependency risk), Resend is the fallback behind the SAME interface. Nothing
 * provider-specific leaks past `MailProvider`: the consumer builds an
 * `OutboundEmail` and calls send(); classification of failures is by the
 * `permanent` flag on the thrown error, never by provider payload shape.
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
  attachments?: { filename: string; contentType: string; content: ArrayBuffer }[];
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
  RESEND_API_KEY?: string;
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
    try {
      const res = await this.sender.send({
        from: email.from.name ? { name: email.from.name, email: email.from.email } : email.from.email,
        subject: email.subject,
        // `to` is always present (the destinations union needs one of to/cc/bcc);
        // a chunk always carries ≥1 recipient across the three roles.
        to: email.to,
        ...(email.cc?.length ? { cc: email.cc } : {}),
        ...(email.bcc?.length ? { bcc: email.bcc } : {}),
        ...(email.headers ? { headers: email.headers } : {}),
        ...(email.text ? { text: email.text } : {}),
        ...(email.html ? { html: email.html } : {}),
        ...(email.attachments?.length
          ? {
              attachments: email.attachments.map((a) => ({
                disposition: "attachment" as const,
                filename: a.filename,
                type: a.contentType,
                content: a.content,
              })),
            }
          : {}),
      });
      return { providerMessageId: res.messageId };
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

/**
 * Resend fallback — stubbed, same interface. Wire the HTTP send when Cloudflare
 * Email Service's beta risk actually bites; until then it fails loudly rather
 * than silently pretending to send.
 */
class ResendProvider implements MailProvider {
  readonly name = "resend";
  constructor(private readonly apiKey: string) {}

  async send(_email: OutboundEmail): Promise<SendResult> {
    // ponytail: implement POST https://api.resend.com/emails here; kept a stub so
    // the seam exists and the switch is one env var, not a code change.
    void this.apiKey;
    throw new ProviderSendError("Resend provider not implemented", true);
  }
}

/**
 * Pick the active provider from bindings: Cloudflare Email Service when its
 * binding is present, else Resend when an API key is configured. Returns null
 * when neither is available (dev with no bindings) so the caller can no-op.
 */
export function selectProvider(env: ProviderEnv): MailProvider | null {
  if (env.EMAIL_SENDER) return new CloudflareProvider(env.EMAIL_SENDER);
  if (env.RESEND_API_KEY) return new ResendProvider(env.RESEND_API_KEY);
  return null;
}
