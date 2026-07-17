import { ORIGIN } from "$app/env/public";
import { sendMail } from "./mailer";
import type { Auth } from "./auth";

type AuthContext = Awaited<Auth["$context"]>;

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Reuses better-auth's verification table with a namespaced identifier —
 * no extra table needed.
 */
export async function sendRecoveryEmailVerification(
  ctx: AuthContext,
  userId: string,
  recoveryEmail: string,
  from?: { name: string; email: string },
) {
  const token = crypto.randomUUID();
  await ctx.internalAdapter.createVerificationValue({
    identifier: `recovery-email:${token}`,
    value: JSON.stringify({ userId, email: recoveryEmail }),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });
  await sendMail({
    to: recoveryEmail,
    from,
    subject: "Verify your Doota recovery email",
    text: `Confirm this address as your Doota account recovery email: ${ORIGIN}/verify-recovery-email?token=${token}\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
  });
}

/** Consumes a verification token; returns true if verification succeeded. */
export async function verifyRecoveryEmailToken(
  ctx: AuthContext,
  token: string,
): Promise<boolean> {
  const record = await ctx.internalAdapter.consumeVerificationValue(
    `recovery-email:${token}`,
  );
  if (!record) return false;
  const { userId, email } = JSON.parse(record.value) as {
    userId: string;
    email: string;
  };
  const user = (await ctx.internalAdapter.findUserById(userId)) as
    | ({ recoveryEmail?: string | null } & Record<string, unknown>)
    | null;
  // Stale token: the recovery address changed after this link was sent.
  if (!user || user.recoveryEmail !== email) return false;
  await ctx.internalAdapter.updateUser(userId, {
    recoveryEmailVerified: true,
    recoveryEmailVerifiedAt: Date.now(),
  });
  return true;
}
