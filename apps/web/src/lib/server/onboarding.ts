// SPDX-License-Identifier: Apache-2.0
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

export type OrgTwoFactorGate =
  | { kind: "none" }
  | { kind: "grace"; deadline: number } // required, but the grace window is open
  | { kind: "block" }; // deadline passed, TOTP still off → block interactive access

/**
 * Org-wide 2FA mandate check (Phase C), evaluated per request in the guard for
 * users who have NOT enrolled TOTP. Resolves the user's active org (the session
 * value, else their first mailbox's org, else their first membership) and reads
 * its mandate. `block` past the grace deadline; `grace` before it (the UI nudges
 * but access continues). Cheap: only called when twoFactorEnabled is false, and
 * a no-op the moment the user enrolls. API keys never reach here (they bypass
 * the interactive guard), so they're exempt by construction.
 */
export async function orgTwoFactorGate(
  db: DrizzleD1Database<typeof schema>,
  user: SessionUser,
  activeOrganizationId?: string | null,
): Promise<OrgTwoFactorGate> {
  if (user.twoFactorEnabled) return { kind: "none" };

  let orgId = activeOrganizationId ?? null;
  if (!orgId) {
    const access = await db.query.mailboxAccess.findFirst({
      where: eq(schema.mailboxAccess.userId, user.id),
      columns: { mailboxId: true },
    });
    if (access) {
      const box = await db.query.mailbox.findFirst({
        where: eq(schema.mailbox.id, access.mailboxId),
        columns: { orgId: true },
      });
      orgId = box?.orgId ?? null;
    }
  }
  if (!orgId) {
    const membership = await db.query.member.findFirst({
      where: eq(schema.member.userId, user.id),
      columns: { organizationId: true },
    });
    orgId = membership?.organizationId ?? null;
  }
  if (!orgId) return { kind: "none" };

  const settings = await db.query.orgMailSettings.findFirst({
    where: eq(schema.orgMailSettings.orgId, orgId),
    columns: { require2fa: true, require2faFrom: true },
  });
  if (!settings?.require2fa) return { kind: "none" };
  // The toggle always writes a future deadline; a missing one enforces now.
  const deadline = settings.require2faFrom?.getTime() ?? Date.now();
  return Date.now() >= deadline ? { kind: "block" } : { kind: "grace", deadline };
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
  /** Org-2FA mandate past its grace deadline (Phase C): a plain member must
   * enroll TOTP too, so reopen secure-account for them like an elevated debt. */
  mustEnroll2fa = false,
): Promise<OnboardingStatus> {
  // Onboarded users normally skip re-derivation — EXCEPT an account owing a
  // security factor: elevated (2FA+passkey) or org-mandated 2FA reopens it.
  const mustSecure = hasSecurityDebt(user) || mustEnroll2fa;
  if (user.onboardedAt && !mustSecure) return DONE;

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
  // An org-2FA member owes ONLY TOTP (the mandate is "require 2FA", not a passkey).
  const secured = !!fresh?.twoFactorEnabled && (isElevated ? passkeys > 0 : true);
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

  if (isElevated || mustEnroll2fa) {
    steps.push({
      id: "secure-account",
      title: "Secure your account",
      description: isElevated
        ? "Admin accounts require both two-factor authentication and a passkey."
        : "Your organization requires two-factor authentication.",
      done: secured,
    });
  }

  const complete = steps.every((step) => step.done);
  const nextStep = steps.find((step) => !step.done)?.id ?? null;
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

  // "Member joined" goes to the inviter — or, when no invite chain exists
  // (account created outside provisioning), to the superadmin running the
  // instance. Never to the new member themselves (superadmin self-onboarding).
  const inviter = u.invitedByUserId
    ? await db.query.user.findFirst({
        where: eq(schema.user.id, u.invitedByUserId),
        columns: { email: true },
      })
    : await db.query.user.findFirst({
        where: eq(schema.user.role, "superadmin"),
        columns: { email: true },
      });
  if (inviter?.email && inviter.email !== u.email) {
    const j = renderEmail("member-joined", { from, memberName, memberEmail: u.email });
    sendMailBackground({ to: inviter.email, from, subject: j.subject, text: j.text, html: j.html });
  }
}
