import { drizzle } from "drizzle-orm/d1";
import * as schema from "./lib/server/db/schema";
import { handleEmail, type InboundJob } from "./lib/server/mail/inbound-worker";
import { handleQueue } from "./lib/server/mail/queue-consumer";
import { handleOutboundQueue } from "./lib/server/mail/outbound-consumer";
import { runScheduledSweeps } from "./lib/server/mail/cron";
import type { OutboundEnv, OutboundJob } from "./lib/server/mail/outbound";

/**
 * STANDALONE mail Worker (`doota-mail`) — the runtime entry the app Worker
 * (`doota`) deliberately does NOT provide. The app only PRODUCES to the queues;
 * this Worker owns every asynchronous mail handler:
 *
 *   - email()     : Cloudflare Email Routing catch-all. `MAIL_IN_WORKER_NAME`
 *                   (used by domains.remote.ts to point the routing rule) MUST
 *                   equal this Worker's name (`doota-mail`).
 *   - queue()     : both mail queues land here; dispatched by queue NAME.
 *   - scheduled() : the 5-min cron sweep (due scheduled sends + stale-draft GC).
 *
 * Config: wrangler.mail.jsonc. Secrets it needs (set with
 * `wrangler secret put <NAME> -c wrangler.mail.jsonc`): MAIL_DEK,
 * MAIL_SEARCH_KEY.
 */

const OUTBOUND_QUEUE = "doota-mail-outbound";

export interface MailWorkerEnv {
  DB: D1Database;
  MAIL_RAW: R2Bucket;
  MAIL_QUEUE: Queue<InboundJob>;
  MAIL_OUT_QUEUE: Queue<OutboundJob>;
  MAIL_DEK: string;
  MAIL_SEARCH_KEY: string;
  EMAIL_SENDER?: SendEmail;
}

export default {
  // Inbound catch-all: bucket-first, accept-and-enqueue (see inbound-worker.ts).
  async email(message, env, ctx): Promise<void> {
    ctx.waitUntil(handleEmail(message, env));
  },

  // One handler for both queues; a queue can only bind to one consumer Worker,
  // so we dispatch on the queue name. Inbound is the default branch.
  async queue(batch, env): Promise<void> {
    if (batch.queue === OUTBOUND_QUEUE) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handleOutboundQueue(batch as any, env);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleQueue(batch as any, env);
  },

  // Maintenance sweeps (mirror of the secret-gated /api/cron backup endpoint).
  async scheduled(_controller, env, ctx): Promise<void> {
    const db = drizzle(env.DB, { schema });
    const outbound: OutboundEnv = {
      MAIL_DEK: env.MAIL_DEK,
      MAIL_SEARCH_KEY: env.MAIL_SEARCH_KEY,
      MAIL_RAW: env.MAIL_RAW,
      MAIL_OUT_QUEUE: env.MAIL_OUT_QUEUE,
    };
    ctx.waitUntil(runScheduledSweeps(db, outbound));
  },
} satisfies ExportedHandler<MailWorkerEnv, InboundJob | OutboundJob>;
