import { json, error, type RequestHandler } from "@sveltejs/kit";
import { bearerFromHeaders, verifyApiKey } from "$lib/server/auth/api-key.js";
import { enqueueSend, type OutboundEnv } from "$lib/server/mail/outbound.js";
import { resolveSender } from "$lib/server/mail/resolver";

/**
 * Programmatic send via bearer API key (Part I). External/machine clients POST
 * here with `Authorization: Bearer dk_…`. The key resolves to its owning user and
 * is authorized against the SAME can() mailbox SEND capability as an interactive
 * session — no parallel permission path. If the key is mailbox-scoped, that
 * mailbox is used and any body mailboxId must match.
 */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
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
  const sender = await resolveSender(locals.db, actor.userId, mailboxId, fromAliasId);

  const asAddrs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const to = asAddrs(body.to);
  const cc = asAddrs(body.cc);
  const bcc = asAddrs(body.bcc);
  if (to.length + cc.length + bcc.length === 0) error(400, "At least one recipient is required");

  const res = await enqueueSend(locals.db, outbound, {
    orgId: sender.orgId,
    mailboxId,
    createdByUserId: actor.userId,
    fromAddress: sender.fromAddress,
    fromName: sender.fromName,
    fromAliasId: sender.fromAliasId,
    to,
    cc,
    bcc,
    subject: typeof body.subject === "string" ? body.subject : "",
    text: typeof body.text === "string" ? body.text : null,
    html: typeof body.html === "string" ? body.html : null,
    parentMessageId: typeof body.parentMessageId === "string" ? body.parentMessageId : null,
    sendAt: typeof body.sendAt === "number" ? body.sendAt : null,
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : crypto.randomUUID(),
  });

  return json({ submissionId: res.submissionId, deduped: res.deduped }, { status: 202 });
};
