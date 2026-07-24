// SPDX-License-Identifier: Apache-2.0
import { command, query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { importKey } from "@doota/mail-core/crypto";
import type { OutboundEnv } from "@doota/mail-core/outbound";
import { deliverInBackground } from "$lib/server/mail/deliver-bridge.js";
import { listSendIdentities } from "@doota/mail-core/identities";
import { suggestRecipients } from "@doota/mail-core/contacts";
import { mailEventStream } from "@doota/mail-core/events-hub";
import {
  createDraft,
  saveDraft,
  listDrafts,
  getDraft,
  discardDraft,
  removeDraftAttachment,
  sendDraft,
  undoDraftSend,
  listScheduled,
  listFailedSends,
} from "@doota/mail-core/drafts";

/**
 * Compose surfaces (Part C/D). Drafts are per-user; each function re-derives the
 * caller from locals and drafts.ts enforces ownership. Sending goes through the
 * existing outbound path (drafts.sendDraft → enqueueSend), never a parallel one.
 */

function requireUser() {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  return locals.user;
}

async function contentKey() {
  const dek = getRequestEvent().platform?.env?.MAIL_DEK;
  if (!dek) error(500, "Mail encryption key is not configured.");
  return importKey(dek);
}

function outboundEnv(): OutboundEnv {
  const env = getRequestEvent().platform?.env;
  if (!env?.MAIL_DEK || !env?.MAIL_SEARCH_KEY || !env?.MAIL_RAW || !env?.MAIL_OUT_QUEUE) {
    error(500, "Outbound mail is not configured.");
  }
  return {
    MAIL_DEK: env.MAIL_DEK,
    MAIL_SEARCH_KEY: env.MAIL_SEARCH_KEY,
    MAIL_RAW: env.MAIL_RAW,
    MAIL_OUT_QUEUE: env.MAIL_OUT_QUEUE,
    MAIL_EVENTS: env.MAIL_EVENTS,
  };
}

const AddrList = z.array(z.email()).default([]);
const Kind = z.enum(["new", "reply", "reply_all", "forward"]);

export const sendIdentities = query(async () => {
  const user = requireUser();
  const { locals } = getRequestEvent();
  return listSendIdentities(locals.db, user.id);
});

export const recipientSuggestions = query(z.string(), async (prefix) => {
  const user = requireUser();
  const { locals } = getRequestEvent();
  return suggestRecipients(locals.db, user.id, prefix);
});

export const myDrafts = query(async () => {
  const user = requireUser();
  const { locals } = getRequestEvent();
  return listDrafts(locals.db, await contentKey(), user.id);
});

export const scheduledSends = query(async () => {
  const user = requireUser();
  const { locals } = getRequestEvent();
  return listScheduled(locals.db, await contentKey(), user.id);
});

/** Recent failed sends (incl. bounces/complaints) — the notifier's catch-up
 * read on mount and after each live failure event. */
export const failedSends = query(async () => {
  const user = requireUser();
  const { locals } = getRequestEvent();
  return listFailedSends(locals.db, await contentKey(), user.id);
});

/**
 * Live send-state events (query.live). The generator subscribes to the user's
 * MailEventHub (Durable Object in doota-mail-jobs, hibernatable WebSocket) and
 * yields each pushed transition — no DB polling anywhere: producers (outbound
 * consumer, event-subscriptions consumer, DSN fallback) notify the hub only
 * when a state actually changed. Clients react by refreshing what they show
 * (ticks in an open thread, failure toasts). Without the binding (vite dev)
 * the stream is silent and the UI falls back to read-time state.
 */
export const mailEvents = query.live(async function* () {
  const user = requireUser();
  const { platform } = getRequestEvent();
  const hub = platform?.env?.MAIL_EVENTS;
  if (!hub) return;
  while (true) {
    try {
      for await (const evt of mailEventStream(hub, user.id)) {
        yield evt;
      }
    } catch {
      // Hub unreachable — back off, then reconnect.
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
});

export const draftById = query(z.object({ draftId: z.string().min(1) }), async ({ draftId }) => {
  const user = requireUser();
  const { locals } = getRequestEvent();
  return getDraft(locals.db, await contentKey(), draftId, user.id);
});

export const startDraft = command(
  z.object({
    mailboxId: z.string().min(1),
    kind: Kind.default("new"),
    threadId: z.string().nullish(),
    inReplyToMessageId: z.string().nullish(),
    fromAliasId: z.string().nullish(),
    subaddressTag: z.string().nullish(),
    to: AddrList,
    cc: AddrList,
    bcc: AddrList,
    subject: z.string().nullish(),
    body: z.string().nullish(),
  }),
  async (input) => {
    const user = requireUser();
    const { locals } = getRequestEvent();
    return createDraft(locals.db, await contentKey(), user.id, input);
  },
);

export const autosaveDraft = command(
  z.object({
    draftId: z.string().min(1),
    clientRevision: z.number().int().min(0),
    to: AddrList.optional(),
    cc: AddrList.optional(),
    bcc: AddrList.optional(),
    subject: z.string().nullish(),
    body: z.string().nullish(),
    fromAliasId: z.string().nullish(),
    subaddressTag: z.string().nullish(),
  }),
  async (input) => {
    const user = requireUser();
    const { locals } = getRequestEvent();
    return saveDraft(locals.db, await contentKey(), user.id, input);
  },
);

export const discardDraftById = command(z.object({ draftId: z.string().min(1) }), async ({ draftId }) => {
  const user = requireUser();
  const { locals } = getRequestEvent();
  await discardDraft(locals.db, outboundEnv(), draftId, user.id);
  return { discarded: true };
});

export const discardDrafts = command(
  z.object({ draftIds: z.array(z.string().min(1)).min(1).max(100) }),
  async ({ draftIds }) => {
    const user = requireUser();
    const { locals } = getRequestEvent();
    let discarded = 0;
    // ponytail: loop the single-draft path — the ownership guard and R2 blob
    // purge live there; N is small and schema-bounded. Batch SQL when it matters.
    for (const draftId of draftIds) {
      try {
        await discardDraft(locals.db, outboundEnv(), draftId, user.id);
        discarded++;
      } catch {
        // skip missing/foreign ids; the rest still delete
      }
    }
    return { discarded };
  },
);

export const detachDraftAttachment = command(
  z.object({ draftId: z.string().min(1), r2Key: z.string().min(1) }),
  async ({ draftId, r2Key }) => {
    const user = requireUser();
    const { locals } = getRequestEvent();
    const attachments = await removeDraftAttachment(locals.db, outboundEnv(), draftId, user.id, r2Key);
    return { attachments };
  },
);

export const sendDraftById = command(
  z.object({
    draftId: z.string().min(1),
    sendAt: z.number().nullish(),
    undoSeconds: z.number().int().min(0).max(300).nullish(),
  }),
  async ({ draftId, sendAt, undoSeconds }) => {
    const user = requireUser();
    const { locals } = getRequestEvent();
    const res = await sendDraft(locals.db, outboundEnv(), await contentKey(), user.id, {
      draftId,
      sendAt: sendAt ?? null,
      undoSeconds: undoSeconds ?? undefined,
    });
    // Bridge: drain in-process (queue consumer isn't running). Skip future sends.
    const undo = undoSeconds ?? 10;
    if (!sendAt || sendAt <= Date.now() + undo * 1000) {
      deliverInBackground(res.submissionId, undo);
    }
    return res;
  },
);

export const undoDraftById = command(
  z.object({ submissionId: z.string().min(1) }),
  async ({ submissionId }) => {
    const user = requireUser();
    const { locals } = getRequestEvent();
    const draft = await undoDraftSend(locals.db, outboundEnv(), await contentKey(), user.id, submissionId);
    return { restored: draft !== null, draft };
  },
);
