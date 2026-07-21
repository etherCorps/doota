import { json, error, type RequestHandler } from "@sveltejs/kit";
import { bearerFromHeaders } from "$lib/server/auth/api-key.js";
import { runScheduledSweeps } from "@doota/mail-core/cron";
import type { OutboundEnv } from "@doota/mail-core/outbound";

/**
 * Cron BACKUP endpoint. The primary schedule is the `doota-mail` Worker's native
 * scheduled() handler (wrangler.mail.jsonc). This secret-gated endpoint runs the
 * SAME maintenance sweeps and exists as a manual/external-scheduler fallback
 * (`Authorization: Bearer $CRON_SECRET`), e.g. to force a sweep without waiting
 * for the 5-min tick. Not publicly callable.
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
