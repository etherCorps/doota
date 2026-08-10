// SPDX-License-Identifier: Apache-2.0
import { json, error, type RequestHandler } from "@sveltejs/kit";
import { bearerFromHeaders, verifyApiKey } from "$lib/server/auth/api-key.js";
import { enqueueSend, type OutboundEnv } from "@doota/mail-core/outbound";
import { resolveSender, resolveServiceSender } from "@doota/mail-core/resolver";
import { logSendEvent } from "@doota/mail-core/send-log";
import { tryLog } from "@doota/mail-core/log";
import { loadTemplateForSend, renderTemplate, sensitiveKeysOf } from "$lib/server/templates.js";
import { builtinMergeData } from "$lib/mjml/variables.js";
import { unsubscribeUrlFor } from "@doota/mail-core/unsubscribe";
import { resolveApiAttachments, type ApiAttachmentInput } from "$lib/server/api-attachments.js";

/**
 * Programmatic send via bearer API key (Part I). External/machine clients POST
 * here with `Authorization: Bearer dk_…`. The key resolves to its owning user and
 * is authorized against the same can() mailbox send capability as an interactive
 * session — no parallel permission path. If the key is mailbox-scoped, that
 * mailbox is used and any body mailboxId must match.
 */
export const POST: RequestHandler = async ({ request, locals, platform, url }) => {
  const presented = bearerFromHeaders(request.headers);
  if (!presented) error(401, "Missing bearer API key");

  const actor = await verifyApiKey(locals.db, presented);
  if (!actor) error(401, "Invalid API key");

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) error(400, "Invalid JSON body");

  const bodyMailbox = typeof body.mailboxId === "string" ? body.mailboxId : null;
  const mailboxId = actor.mailboxId ?? bodyMailbox;
  if (!mailboxId) error(400, "mailboxId is required");
  if (actor.mailboxId && bodyMailbox && bodyMailbox !== actor.mailboxId) {
    error(403, "This key may only send as its bound mailbox");
  }

  const env = platform?.env;
  if (!env?.MAIL_DEK || !env?.MAIL_SEARCH_KEY || !env?.MAIL_RAW || !env?.MAIL_OUT_QUEUE) {
    error(500, "Outbound mail is not configured.");
  }
  const outbound: OutboundEnv = {
    MAIL_DEK: env.MAIL_DEK,
    MAIL_SEARCH_KEY: env.MAIL_SEARCH_KEY,
    MAIL_RAW: env.MAIL_RAW,
    MAIL_OUT_QUEUE: env.MAIL_OUT_QUEUE,
  };

  const fromAliasId = typeof body.fromAliasId === "string" ? body.fromAliasId : null;
  // Service keys authorize the mailbox directly; legacy keys act as their user.
  let sender;
  if (actor.isService) {
    sender = await resolveServiceSender(locals.db, mailboxId, fromAliasId);
  } else if (actor.userId) {
    sender = await resolveSender(locals.db, actor.userId, mailboxId, fromAliasId);
  } else {
    error(401, "This key is no longer valid.");
  }
  const createdByUserId = actor.isService ? null : actor.userId;

  const asAddrs = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const to = asAddrs(body.to);
  const cc = asAddrs(body.cc);
  const bcc = asAddrs(body.bcc);
  if (to.length + cc.length + bcc.length === 0) error(400, "At least one recipient is required");

  // Templated send: load the org's template, render subject + html with the
  // caller's `data` (un-jinja). Raw sends pass subject/text/html directly.
  const templateId = typeof body.templateId === "string" ? body.templateId : null;
  const data =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : {};
  let subject = typeof body.subject === "string" ? body.subject : "";
  let text = typeof body.text === "string" ? body.text : null;
  let html = typeof body.html === "string" ? body.html : null;
  let templateVersion: number | null = null;
  let sensitiveKeys: string[] = [];
  if (templateId) {
    const tmpl = await loadTemplateForSend(locals.db, sender.orgId, templateId);
    if (!tmpl) error(404, "Template not found for this account");
    // Built-in variables (recipient, sender, date…) are filled by us and win over
    // caller data of the same name; everything else comes from the caller's `data`.
    // Unsubscribe link for the primary recipient — host from this request's
    // origin (multi-domain safe), path optionally overridden by UNSUBSCRIBE_URL.
    // Exposed as {{ unsubscribe_url }}; built-ins win over caller data.
    const primary = [...to, ...cc, ...bcc][0];
    const mergeData = {
      ...data,
      ...builtinMergeData({ fromAddress: sender.fromAddress, fromName: sender.fromName, recipients: [...to, ...cc, ...bcc] }),
      unsubscribe_url: unsubscribeUrlFor(url.origin, primary ?? "", env.UNSUBSCRIBE_URL),
    };
    const rendered = renderTemplate(tmpl, mergeData);
    subject = rendered.subject;
    html = rendered.html;
    text = null; // template renders HTML; the provider derives the text part.
    templateVersion = tmpl.version;
    sensitiveKeys = sensitiveKeysOf(tmpl.variablesSchema);
  }

  // Attachments (inline base64 `content` or a remote `url`) → encrypted R2 blobs.
  const attachments = Array.isArray(body.attachments)
    ? await resolveApiAttachments({ MAIL_RAW: env.MAIL_RAW, MAIL_DEK: env.MAIL_DEK }, sender.orgId, body.attachments as ApiAttachmentInput[])
    : [];

  const res = await enqueueSend(locals.db, outbound, {
    orgId: sender.orgId,
    mailboxId,
    createdByUserId,
    apiKeyId: actor.keyId,
    fromAddress: sender.fromAddress,
    fromName: sender.fromName,
    fromAliasId: sender.fromAliasId,
    to,
    cc,
    bcc,
    subject,
    text,
    html,
    parentMessageId: typeof body.parentMessageId === "string" ? body.parentMessageId : null,
    sendAt: typeof body.sendAt === "number" ? body.sendAt : null,
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : crypto.randomUUID(),
    attachments,
  });

  // Service-account send log (best-effort — never fail a send because logging did).
  // Raw sends log metadata only; templated sends (Phase 2) also log the payload.
  if (actor.isService && !res.deduped) {
    await tryLog(
      "out.sendlog_failed",
      logSendEvent(locals.db, {
        orgId: sender.orgId,
        mailboxId,
        apiKeyId: actor.keyId,
        submissionId: res.submissionId,
        templateId,
        templateVersion,
        to,
        cc,
        bcc,
        subject,
        status: "queued",
        data: templateId ? data : null,
        sensitiveKeys,
        dek: env.MAIL_DEK,
      }),
    );
  }

  return json({ submissionId: res.submissionId, deduped: res.deduped }, { status: 202 });
};
