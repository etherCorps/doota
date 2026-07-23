import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { domainOf, senderAddress } from "@doota/db/org-domains";
import type { Auth } from "./auth.js";
import { stampOnboarded } from "./auth/escape-hatches.js";
import { renderEmail } from "./email/index.js";
import { sendMailBackground } from "./mailer.js";

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
  twoFactorEnabled?: boolean | null;
};

/** Elevated accounts must hold BOTH factors (TOTP + passkey). */
export function isElevatedRole(role?: string | null): boolean {
  return role === "admin" || role === "superadmin";
}

/**
 * True when an elevated account's session says TOTP 2FA is off — the state that
 * lets bare credentials sign in with no second factor. Cheap (session field
 * only); used by hooks to reopen onboarding even after onboardedAt is stamped.
 */
export function hasSecurityDebt(user: SessionUser): boolean {
  return isElevatedRole(user.role) && !user.twoFactorEnabled;
}

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
  // Onboarded users normally skip re-derivation — EXCEPT an elevated account
  // with security debt: the 2FA+passkey mandate reopens secure-account for them.
  if (user.onboardedAt && !hasSecurityDebt(user)) return DONE;

  const role = user.role ?? "member";
  const isElevated = isElevatedRole(role);

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

  // BOTH factors are mandatory for elevated roles. Passkey-only is not enough:
  // password sign-in never consults passkeys, so an admin with a passkey but no
  // TOTP could be logged in with bare credentials — that exact hole shipped once.
  const secured = !!fresh?.twoFactorEnabled && passkeys > 0;
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
        "Admin accounts require both two-factor authentication and a passkey.",
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

/**
 * Completion notifications, fired ONCE when an account turns active (first
 * markOnboarded): the new user always gets a welcome as the first mail in
 * their inbox — sent from the org's no-reply sender (senderAddress default).
 * When an invite chain exists, the inviter additionally gets "member joined".
 * Best-effort: a mail failure never blocks the request.
 */
export async function notifyOnboardingComplete(
  db: DrizzleD1Database<typeof schema>,
  userId: string,
): Promise<void> {
  const u = await db.query.user.findFirst({
    where: eq(schema.user.id, userId),
    columns: { name: true, email: true, invitedByUserId: true },
  });
  if (!u) return;

  const from = await senderAddress(db, domainOf(u.email));
  const memberName = u.name || u.email;

  const w = renderEmail("welcome", { from, name: memberName, mailbox: u.email });
  sendMailBackground({ to: u.email, from, subject: w.subject, text: w.text, html: w.html });

  if (!u.invitedByUserId) return; // self-onboarded — no inviter to notify
  const inviter = await db.query.user.findFirst({
    where: eq(schema.user.id, u.invitedByUserId),
    columns: { email: true },
  });
  if (inviter?.email) {
    const j = renderEmail("member-joined", { from, memberName, memberEmail: u.email });
    sendMailBackground({ to: inviter.email, from, subject: j.subject, text: j.text, html: j.html });
  }
}
