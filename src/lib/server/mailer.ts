import { getRequestEvent } from "$app/server";

type MailFrom = { name: string; email: string; logo?: string | null };
type Mail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Sender from an onboarded active domain (see `senderAddress`). Required to
   *  actually send — there is no system fallback domain. */
  from?: MailFrom;
};

/**
 * Mailer via the EMAIL_SENDER binding. Every mail must originate from an
 * onboarded domain whose sending path is live (`senderAddress`) — there is no
 * fallback domain. If none is active yet (fresh deploy) `from` is undefined and
 * the send is skipped. Falls back to console.log in local dev (no binding).
 */
export async function sendMail({ to, subject, text, html, from }: Mail) {
  const sender = getRequestEvent().platform?.env.EMAIL_SENDER;
  if (!sender) {
    console.log("[mailer:dev]", { to, from, subject, text });
    return;
  }
  if (!from) {
    console.warn("[mailer] no active sending domain — mail skipped", { to, subject });
    return;
  }
  await sender.send({
    to,
    from,
    subject,
    text,
    html: html ?? `<p>${text}</p>`,
  });
}

/**
 * Send without blocking the response. Two reasons this matters for
 * password reset: (1) a mail failure must not turn the generic 200 into a
 * 500, and (2) not awaiting the send keeps the endpoint's latency uniform
 * whether or not a mail actually goes out — so response timing can't be
 * used to probe which accounts exist. Uses the Worker's waitUntil to finish
 * delivery after the response; falls back to a caught fire-and-forget in dev.
 */
export function sendMailBackground(mail: Mail) {
  const promise = sendMail(mail).catch((err) =>
    console.error("[mailer] background send failed", err),
  );
  const ctx = getRequestEvent().platform?.ctx;
  if (ctx) ctx.waitUntil(promise);
  return Promise.resolve()
}
