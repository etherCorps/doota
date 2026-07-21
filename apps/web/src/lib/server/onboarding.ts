import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import type { Auth } from "./auth.js";
import { stampOnboarded } from "./auth/escape-hatches.js";

export type OnboardingStepId =
  | "verify-email"
  | "verify-recovery"
  | "secure-account"
  | "set-password"
  | "onboard-domain";

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

  // The super-admin onboards the first mail domain here: at genesis no domain is
  // configured, so there is no sending path for any mail (the bootstrap paradox).
  // "Done" the moment a domain exists — a pending zone (nameservers not yet
  // delegated) still counts, so they can continue and finish DNS later rather
  // than being walled out of /admin while nameservers propagate. Once that domain
  // flips active, wireAndActivate auto-sends their email-verification mail.
  if (role === "superadmin") {
    const domains = await db.$count(schema.organization);
    steps.push({
      id: "onboard-domain",
      title: "Onboard a mail domain",
      description:
        "Connect a Cloudflare domain so Doota can send and receive mail.",
      done: domains > 0,
    });
  }

  // The external super-admin does NOT verify email at onboarding: their email
  // verification is auto-sent once a domain is active (see above), and is a
  // non-blocking, deferred action — their trust root is deploy access, and 2FA /
  // passkey below is the real gate. So the super-admin never has a verify step.
  if (role !== "superadmin") {
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
export async function markOnboarded(auth: Auth, userId: string): Promise<void> {
  await stampOnboarded(auth, userId);
}
