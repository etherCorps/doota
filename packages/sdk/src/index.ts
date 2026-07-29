// SPDX-License-Identifier: Apache-2.0
/**
 * Doota send SDK — a thin, Resend-shaped client over `POST /api/send`
 * (docs/service-accounts.md § SDK). Bearer-authenticated with a service-account
 * key (`dk_…`). No secrets stored beyond the key the caller passes in.
 *
 *   const doota = new Doota("dk_live_…", { baseUrl: "https://mail.acme.com" });
 *   await doota.emails.send({ to: "ana@x.com", templateId: "tmpl_…", data: { name: "Ana" } });
 */

export type Address = string | string[];

/** A file to attach. Supply exactly one of `content` (raw bytes/base64) or
 * `url` (a public URL Doota fetches, SSRF-guarded). */
export type Attachment = {
  filename: string;
  /** Raw bytes or a base64 string. `Buffer`/`Uint8Array` are base64-encoded for you. */
  content?: string | Uint8Array;
  /** A remote URL to fetch the file from instead of sending bytes. */
  url?: string;
  /** MIME type (defaults to the fetched type, or application/octet-stream). */
  contentType?: string;
};

export type SendParams = {
  /** Recipients — at least one across to/cc/bcc. */
  to?: Address;
  cc?: Address;
  bcc?: Address;
  /** Raw send — subject + body. Omit when using a template. */
  subject?: string;
  text?: string;
  html?: string;
  /** Templated send — the template slug/id + its merge data. */
  templateId?: string;
  data?: Record<string, unknown>;
  /** Only needed for a key not bound to a single mailbox. */
  mailboxId?: string;
  /** Send from one of the mailbox's aliases. */
  fromAliasId?: string;
  /** Thread as a reply to this Message-ID. */
  parentMessageId?: string;
  /** Schedule for a future epoch-ms timestamp. */
  sendAt?: number;
  /** Dedupe key — a repeated value returns the original submission. */
  idempotencyKey?: string;
  /** Files to attach — inline bytes/base64, or a URL for Doota to fetch. */
  attachments?: Attachment[];
};

export type SendResult = { submissionId: string; deduped: boolean };

export type DootaOptions = {
  /** Base URL of your Doota instance, e.g. https://mail.acme.com. */
  baseUrl: string;
  /** Override fetch (tests, custom agents). Defaults to global fetch. */
  fetch?: typeof fetch;
};

/** A non-2xx response from the send API. `status` is the HTTP code. */
export class DootaError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DootaError";
    this.status = status;
  }
}

function asArray(v: Address | undefined): string[] | undefined {
  if (v == null) return undefined;
  return Array.isArray(v) ? v : [v];
}

function toBase64(bytes: Uint8Array): string {
  // Prefer Buffer in Node; fall back to btoa in browsers/workers.
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString("base64");
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Wire form of an attachment: bytes → base64 `content`, or pass `url` through. */
function wireAttachment(a: Attachment): Record<string, unknown> {
  if (a.url) return { filename: a.filename, url: a.url, contentType: a.contentType };
  const content = typeof a.content === "string" ? a.content : toBase64(a.content ?? new Uint8Array());
  return { filename: a.filename, content, contentType: a.contentType };
}

export class Doota {
  #apiKey: string;
  #baseUrl: string;
  #fetch: typeof fetch;

  constructor(apiKey: string, options: DootaOptions) {
    if (!apiKey) throw new Error("Doota: an API key is required");
    if (!options?.baseUrl) throw new Error("Doota: options.baseUrl is required");
    this.#apiKey = apiKey;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  emails = {
    /** Enqueue a message. Resolves to the submission id; throws DootaError on failure. */
    send: async (params: SendParams): Promise<SendResult> => {
      const body: Record<string, unknown> = {
        to: asArray(params.to),
        cc: asArray(params.cc),
        bcc: asArray(params.bcc),
        subject: params.subject,
        text: params.text,
        html: params.html,
        templateId: params.templateId,
        data: params.data,
        mailboxId: params.mailboxId,
        fromAliasId: params.fromAliasId,
        parentMessageId: params.parentMessageId,
        sendAt: params.sendAt,
        idempotencyKey: params.idempotencyKey,
        attachments: params.attachments?.map(wireAttachment),
      };
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];

      const res = await this.#fetch(`${this.#baseUrl}/api/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        let message = `Send failed (${res.status})`;
        try {
          const err = (await res.json()) as { message?: string };
          if (err?.message) message = err.message;
        } catch {
          // non-JSON error body — keep the status message
        }
        throw new DootaError(res.status, message);
      }
      return (await res.json()) as SendResult;
    },
  };
}
