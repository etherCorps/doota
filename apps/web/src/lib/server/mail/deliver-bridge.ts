import { getRequestEvent } from "$app/server";
import { deliverSubmissionNow, type OutboundConsumerEnv } from "@doota/mail-core/outbound-consumer";

/**
 * TEMPORARY synchronous delivery bridge. The outbound queue's consumer lives in
 * the standalone doota-mail Worker, which isn't running under `vite dev`, so
 * composer sends would sit `queued` forever. This kicks the consumer in-process
 * (background, via waitUntil) after the undo window, using the app Worker's own
 * env — the SAME EMAIL_SENDER binding invites already send through.
 *
 * ponytail: bridge, not the real path. Idempotent with the queue (recipients
 * already `sent` are skipped), so enabling the doota-mail consumer later is a
 * no-op and this call can be removed. Only immediate sends are bridged; future
 * scheduled sends are left for the queue/cron.
 */
export function deliverInBackground(submissionId: string, undoSeconds: number): void {
  const ev = getRequestEvent();
  const env = ev.platform?.env;
  // No EMAIL_SENDER (pure-local without the remote binding) → nothing can send;
  // leave it queued rather than throwing.
  if (!env?.EMAIL_SENDER || !env?.DB || !env?.MAIL_RAW || !env?.MAIL_OUT_QUEUE) return;

  const consumerEnv: OutboundConsumerEnv = {
    DB: env.DB,
    MAIL_RAW: env.MAIL_RAW,
    MAIL_DEK: env.MAIL_DEK,
    MAIL_SEARCH_KEY: env.MAIL_SEARCH_KEY,
    EMAIL_SENDER: env.EMAIL_SENDER,
    MAIL_OUT_QUEUE: env.MAIL_OUT_QUEUE,
    MAIL_EVENTS: env.MAIL_EVENTS,
  };

  console.log(`[mailer:bridge] queued ${submissionId} — delivering in ${undoSeconds}s (undo window)`);
  const run = (async () => {
    // Respect the undo window: the consumer re-holds (no-op) if it runs early.
    if (undoSeconds > 0) await new Promise((r) => setTimeout(r, undoSeconds * 1000));
    console.log(`[mailer:bridge] draining ${submissionId}`);
    try {
      await deliverSubmissionNow(consumerEnv, submissionId);
      console.log(`[mailer:bridge] done ${submissionId}`);
    } catch (err) {
      console.error(`[mailer:bridge] delivery failed ${submissionId}`, err);
    }
  })();

  const ctx = ev.platform?.ctx;
  if (ctx) ctx.waitUntil(run);
  else void run;
}
