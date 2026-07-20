import { json, error, type RequestHandler } from "@sveltejs/kit";
import { bearerFromHeaders } from "$lib/server/auth/api-key.js";
import { runScheduledSweeps } from "$lib/server/mail/cron.js";
import type { OutboundEnv } from "$lib/server/mail/outbound.js";

/**
 * Cron target. The 5-min Cloudflare cron trigger has no fetch context under
 * adapter-cloudflare, so wire it to hit this endpoint (scheduled() → fetch, or an
 * external scheduler) with `Authorization: Bearer $CRON_SECRET`. Runs the shared
 * maintenance sweeps. Secret-gated so it isn't publicly callable.
 */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
  const env = platform?.env;
  const secret = env?.CRON_SECRET;
  if (!secret) error(503, "Cron is not configured (CRON_SECRET unset).");
  if (bearerFromHeaders(request.headers) !== secret) error(401, "Bad cron secret");

  if (!env?.MAIL_DEK || !env?.MAIL_SEARCH_KEY || !env?.MAIL_RAW || !env?.MAIL_OUT_QUEUE) {
    error(500, "Outbound mail is not configured.");
  }
  const outbound: OutboundEnv = {
    MAIL_DEK: env.MAIL_DEK,
    MAIL_SEARCH_KEY: env.MAIL_SEARCH_KEY,
    MAIL_RAW: env.MAIL_RAW,
    MAIL_OUT_QUEUE: env.MAIL_OUT_QUEUE,
  };
  const result = await runScheduledSweeps(locals.db, outbound);
  return json(result);
};
