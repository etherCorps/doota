// SPDX-License-Identifier: Apache-2.0
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { handleOutboundQueue, type OutboundConsumerEnv } from "@doota/mail-core/outbound-consumer";
import { handleMailEventsQueue } from "@doota/mail-core/events-consumer";
import { runScheduledSweeps } from "@doota/mail-core/cron";
import { type OutboundEnv, type OutboundJob } from "@doota/mail-core/outbound";
import { initLogLevel } from "@doota/mail-core/log";

/**
 * Outbound + maintenance Worker (`doota-mail-jobs`). Split out of the inbound
 * Worker so send delivery and the cron sweep scale/deploy independently of the
 * Email Routing catch-all. Owns:
 *   - queue()     : the outbound queue consumer (provider send + retries).
 *   - scheduled() : the 5-min sweep (due scheduled sends + stale-draft GC).
 *
 * Config: wrangler.jsonc. Secrets: MAIL_DEK, MAIL_SEARCH_KEY. Needs the
 * EMAIL_SENDER (Cloudflare Email Service) binding for delivery.
 * Vars: LOG_LEVEL (optional, debug|info|warn|error, default info).
 */
// Per-user mail event hub (one DO instance per user). Lives in THIS script;
// the web Worker reaches it via a cross-script binding (script_name).
export { MailEventHub } from "@doota/mail-core/events-hub";

export default {
  async queue(batch, env): Promise<void> {
    initLogLevel(env);
    // Two consumed queues, routed by name: outbound sends + Email Service
    // event subscriptions (delivery lifecycle).
    if (batch.queue === "doota-mail-events") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handleMailEventsQueue(batch as any, env);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleOutboundQueue(batch as any, env);
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    initLogLevel(env);
    const db = drizzle(env.DB, { schema });
    const outbound: OutboundEnv = {
      MAIL_DEK: env.MAIL_DEK,
      MAIL_SEARCH_KEY: env.MAIL_SEARCH_KEY,
      MAIL_RAW: env.MAIL_RAW,
      MAIL_OUT_QUEUE: env.MAIL_OUT_QUEUE,
    };
    ctx.waitUntil(runScheduledSweeps(db, outbound));
  },
} satisfies ExportedHandler<OutboundConsumerEnv, OutboundJob>;
