import { ORIGIN } from "$app/env/public";
import { sendMail } from "./mailer";
import { renderEmail } from "./email";
import { tokenStore, setUserAuthFlags } from "./auth/escape-hatches.js";
import { getUserForRecovery } from "./auth/repository.js";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Reuses better-auth's verification table with a namespaced identifier (via the
 * boundary token store) — no extra table needed.
 */
export async function sendRecoveryEmailVerification(
  userId: string,
  recoveryEmail: string,
  from?: { name: string; email: string },
) {
  const token = crypto.randomUUID();
  await tokenStore.issue(
    `recovery-email:${token}`,
    JSON.stringify({ userId, email: recoveryEmail }),
    TOKEN_TTL_MS,
  );
  const verifyLink = `${ORIGIN}/verify-recovery-email?token=${token}`;
  const mail = renderEmail("recovery-verify", { from, verifyLink });
  await sendMail({ to: recoveryEmail, from, subject: mail.subject, text: mail.text, html: mail.html });
}

/** Consumes a verification token; returns true if verification succeeded. */
export async function verifyRecoveryEmailToken(token: string): Promise<boolean> {
  const record = await tokenStore.consume(`recovery-email:${token}`);
  if (!record) return false;
  const { userId, email } = JSON.parse(record.value) as {
    userId: string;
    email: string;
  };
  const user = await getUserForRecovery(userId);
  // Stale token: the recovery address changed after this link was sent.
  if (!user || user.recoveryEmail !== email) return false;
  await setUserAuthFlags(userId, {
    recoveryEmailVerified: true,
    recoveryEmailVerifiedAt: Date.now(),
  });
  return true;
}
