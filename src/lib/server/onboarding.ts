import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./db/schema";

export type OnboardingStepId =
  | "verify-email"
  | "verify-recovery"
  | "secure-account"
  | "set-password";

export type OnboardingStep = {
  id: OnboardingStepId;
  title: string;
  description: string;
  done: boolean;
};

export type OnboardingStatus = {
  steps: OnboardingStep[];
  complete: boolean;
  /** First not-yet-done step, or null when finished. */
  nextStep: OnboardingStepId | null;
};

type SessionUser = {
  id: string;
  role?: string | null;
  onboardedAt?: number | null;
};

const HOME_BY_ROLE: Record<string, string> = { superadmin: "/admin" };
export function onboardingHome(role?: string | null): string {
  return HOME_BY_ROLE[role ?? ""] ?? "/app";
}

const DONE: OnboardingStatus = { steps: [], complete: true, nextStep: null };

/**
 * Derives what onboarding is left for a user. Requirements differ by role:
 *   superadmin → verify primary email + secure account (2FA/passkey)
 *   admin      → verify recovery email + secure account
 *   member     → verify recovery email
 * Anyone provisioned with a temp password also has a set-password step.
 *
 * Reads the gating flags FRESH from D1 (never the 5-minute session cookie cache),
 * so a just-completed step isn't reported stale and bounce the user in a loop.
 * Callers that already know `user.onboardedAt` is set should skip this (fast path).
 */
export async function getOnboardingStatus(
  db: DrizzleD1Database<typeof schema>,
  user: SessionUser,
): Promise<OnboardingStatus> {
  if (user.onboardedAt) return DONE;

  const role = user.role ?? "member";
  const isElevated = role === "admin" || role === "superadmin";

  const [fresh, passkeys] = await Promise.all([
    db.query.user.findFirst({
      where: eq(schema.user.id, user.id),
      columns: {
        emailVerified: true,
        twoFactorEnabled: true,
        recoveryEmail: true,
        recoveryEmailVerified: true,
        mustChangePassword: true,
      },
    }),
    db.$count(schema.passkey, eq(schema.passkey.userId, user.id)),
  ]);

  const secured = !!fresh?.twoFactorEnabled || passkeys > 0;
  const steps: OnboardingStep[] = [];

  if (role === "superadmin") {
    steps.push({
      id: "verify-email",
      title: "Verify your email",
      description: "Confirm the external address you sign in with.",
      done: !!fresh?.emailVerified,
    });
  } else {
    steps.push({
      id: "verify-recovery",
      title: "Verify a recovery email",
      description:
        "An external address to reset your password — your Doota inbox can't receive reset links.",
      done: !!fresh?.recoveryEmail && !!fresh?.recoveryEmailVerified,
    });
  }

  if (fresh?.mustChangePassword) {
    steps.push({
      id: "set-password",
      title: "Set your password",
      description: "Replace the temporary password you were given.",
      done: false,
    });
  }

  if (isElevated) {
    steps.push({
      id: "secure-account",
      title: "Secure your account",
      description:
        "Admin accounts require two-factor authentication or a passkey.",
      done: secured,
    });
  }

  const complete = steps.every((s) => s.done);
  const nextStep = steps.find((s) => !s.done)?.id ?? null;
  return { steps, complete, nextStep };
}

/** Stamps onboardedAt so future requests take the fast path. Idempotent. */
export async function markOnboarded(
  db: DrizzleD1Database<typeof schema>,
  userId: string,
): Promise<void> {
  await db
    .update(schema.user)
    .set({ onboardedAt: Date.now() })
    .where(eq(schema.user.id, userId));
}
