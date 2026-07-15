import { getRequestEvent } from "$app/server";
import { MAIL_DOMAIN } from "$app/env/public";

type Mail = { to: string; subject: string; text: string; html?: string };

/**
 * System mailer (no-reply@MAIL_DOMAIN) via the EMAIL_SENDER binding.
 * Falls back to console.log in local dev where the binding is absent.
 */
export async function sendMail({ to, subject, text, html }: Mail) {
  const sender = getRequestEvent().platform?.env.EMAIL_SENDER;
  if (!sender) {
    console.log("[mailer:dev]", { to, subject, text });
    return;
  }
  await sender.send({
    to,
    from: { name: "Doota", email: `no-reply@${MAIL_DOMAIN}` },
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
}
