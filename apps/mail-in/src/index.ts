// SPDX-License-Identifier: Apache-2.0
import { handleEmail, type InboundJob, type MailEnv } from "@doota/mail-core/inbound-worker";
import { handleQueue } from "@doota/mail-core/queue-consumer";
import { initLogLevel } from "@doota/mail-core/log";

/**
 * Inbound mail Worker (`doota-mail`). Owns the two handlers the app Worker does
 * not: the Email Routing catch-all and the inbound-queue consumer. Kept under
 * the ORIGINAL name so the Cloudflare Email Routing rule (wired by
 * domains.remote.ts → MAIL_IN_WORKER_NAME) keeps pointing here after the split.
 *
 * Outbound sending + the cron sweep live in the sibling `doota-mail-jobs`
 * Worker (../mail-jobs) — a queue binds to exactly one consumer, so the two
 * queues are split across the two Workers.
 *
 * Config: wrangler.jsonc. Secrets: MAIL_DEK, MAIL_SEARCH_KEY (put via
 * `wrangler secret put <NAME>` from this dir; .dev.vars for local).
 * Vars: LOG_LEVEL (optional, debug|info|warn|error, default info).
 */
export default {
  // Bucket-first, accept-and-enqueue (see inbound-worker.ts). Awaited (not
  // waitUntil): the work is fast (R2 put + queue send) and MUST finish before we
  // accept — a failed enqueue then rejects the message so Email Routing retries,
  // instead of silently dropping mail we already told the sender we took.
  async email(message, env): Promise<void> {
    initLogLevel(env);
    await handleEmail(message, env);
  },
  // Only the inbound queue lands here now.
  async queue(batch, env): Promise<void> {
    initLogLevel(env);
    // ponytail: cast matches the app's existing consumer wiring; the handler
    // narrows the batch itself.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleQueue(batch as any, env);
  },
} satisfies ExportedHandler<MailEnv, InboundJob>;
