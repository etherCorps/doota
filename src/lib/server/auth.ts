import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { sveltekitCookies } from "better-auth/svelte-kit";
import {
  admin,
  lastLoginMethod,
  twoFactor,
  organization,
  multiSession,
  openAPI
} from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";
import { APIError } from "better-auth/api";
import { passkey } from "@better-auth/passkey";
import { getRequestEvent } from "$app/server";
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import { sendMailBackground } from "./mailer";
import { isServedDomain, invalidateDomainCache, senderAddress, domainOf } from "./org-domains";
import { BETTER_AUTH_SECRET } from "$app/env/private";
import { ORIGIN } from "$app/env/public";
import { renderEmail } from "./email";
import { kvSecondaryStorage } from "./auth/kv-secondary-storage.js";

// Instance roles (admin plugin). Separate from org membership roles
// (owner/admin/member), which the organization plugin manages per-membership.
const ac = createAccessControl(defaultStatements);
export const roles = {
  member: ac.newRole({}),
  admin: ac.newRole(adminAc.statements),
  superadmin: ac.newRole(adminAc.statements),
};

type UserRecovery = {
  recoveryEmail?: string | null;
  recoveryEmailVerified?: boolean;
};

/**
 * Reject an address that lands on any domain this deployment serves. Recovery
 * addresses and the external super-admin's login email must be EXTERNAL — a
 * served-domain address recreates the circular "can't read your own mailbox
 * until you're logged in" problem. No-op when db is absent (schema generation).
 */
async function assertNotServedDomain(
  db: DrizzleD1Database<typeof schema> | undefined,
  email: unknown,
  label: string,
) {
  if (!db || typeof email !== "string" || !email) return;
  if (await isServedDomain(db, email)) {
    throw new APIError("BAD_REQUEST", {
      message: `${label} must be an external address, not on a domain this server hosts.`,
    });
  }
}

function buildAuth(db?: DrizzleD1Database<typeof schema>, kv?: KVNamespace) {
  return betterAuth({
    // Cloudflare KV as a fast, edge-local read cache in front of D1. D1 stays the
    // source of truth (storeSessionInDatabase / verification.storeInDatabase
    // below): sessions + verification values are dual-written, reads hit KV first
    // and fall back to D1, and consume/revoke are enforced on D1. Absent (CLI
    // schema-gen has no binding) → plain database-only mode.
    secondaryStorage: kv ? kvSecondaryStorage(kv) : undefined,
    user: {
      modelName: "user",
      additionalFields: {
        // Recovery email is only meaningful for mailbox (member) users; the
        // external super-admin recovers via their external login email instead.
        recoveryEmail: { type: "string", required: false },
        recoveryEmailVerified: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false,
        },
        recoveryEmailVerifiedAt: {
          type: "number",
          required: false,
          input: false,
        },
        // Set by the provisioning admin; forces the set-password onboarding step.
        mustChangePassword: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false,
        },
        // Fast-path marker so the request hook can skip re-deriving status.
        onboardedAt: { type: "number", required: false, input: false },
      },
    },
    emailVerification: {
      // Only the external super-admin verifies their PRIMARY email (it's a real
      // external inbox). Mailbox users verify a recovery address instead — their
      // primary email is an unreadable Doota inbox — so we never send here for them.
      sendVerificationEmail: async ({ user, url }) => {
        // Superadmin primary-email verify: no specific org, so brand/send from
        // any active domain (same rule as the reset link below).
        const from = db ? await senderAddress(db) : undefined;
        const mail = renderEmail("verify-email", { from, verifyLink: url });
        sendMailBackground({
          to: user.email,
          from,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });
      },
      autoSignInAfterVerification: false,
    },
    appName: `Doota - ${ORIGIN.replace(/^https?:\/\//, "")}`,
    baseURL: ORIGIN,
    secret: BETTER_AUTH_SECRET,
    database: drizzleAdapter(db!, { provider: "sqlite", schema }),
    emailAndPassword: {
      enabled: true,
      // Accounts are provisioned by an admin, never self-signup.
      disableSignUp: true,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 10, // seconds
      /**
       * Reset target branches by role (spec invariant):
       *   - external super-admin → their external login `user.email`
       *   - mailbox/member user  → verified external `recoveryEmail`
       * Never `user.email` for a member (that's the unreadable Doota inbox),
       * and never a served-domain address for anyone. Silent no-op otherwise,
       * so the endpoint's response stays generic (no enumeration).
       */
      sendResetPassword: async ({ user, url }) => {
        const role = (user as typeof user & { role?: string | null }).role;
        let to: string | null = null;

        if (role === "superadmin") {
          // Only once the super-admin has VERIFIED their external email (a
          // deferred action, available after a domain has a working sending
          // path). Until then recovery is the email-free CLI (reset-admin) —
          // never an unverified, possibly-undeliverable address.
          const emailVerified = (user as typeof user & { emailVerified?: boolean }).emailVerified;
          if (emailVerified) to = user.email;
        } else {
          const { recoveryEmail, recoveryEmailVerified } = user as typeof user &
            UserRecovery;
          if (recoveryEmail && recoveryEmailVerified) to = recoveryEmail;
        }

        if (!to) return;
        // Defence in depth: never send a reset link to a served-domain inbox.
        if (db && (await isServedDomain(db, to))) return;

        // Brand from the user's own org domain (members) when it's active;
        // superadmin/system mail falls back to any active org domain.
        const fromDomain = role === "superadmin" ? undefined : domainOf(user.email);
        const from = db ? await senderAddress(db, fromDomain) : undefined;

        const mail = renderEmail("reset-link", { from, resetLink: url });
        sendMailBackground({
          to,
          from,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            await assertNotServedDomain(
              db,
              (user as UserRecovery).recoveryEmail,
              "Recovery email",
            );
            // First user on a fresh deployment becomes the external superadmin.
            const isFirst = db ? (await db.$count(schema.user)) === 0 : false;
            return {
              data: {
                ...user,
                role: isFirst ? "superadmin" : (user.role ?? "member"),
              },
            };
          },
        },
        update: {
          before: async (data) => {
            const recoveryEmail = (data as UserRecovery).recoveryEmail;
            if (recoveryEmail === undefined) return { data };
            await assertNotServedDomain(db, recoveryEmail, "Recovery email");
            // Changing the recovery address always re-requires verification.
            return {
              data: {
                ...data,
                recoveryEmailVerified: false,
                recoveryEmailVerifiedAt: null,
              },
            };
          },
        },
      },
      session: {
        create: {
          // A successful credential login proves the user controls the address
          // the temp password was delivered to — their EXTERNAL recovery email
          // (provisioning mails it there and nowhere else). So we verify the
          // recovery address on first login instead of sending a separate
          // confirmation link. Idempotent: once verified this is a no-op, and
          // superadmins have no recoveryEmail so they're never touched.
          after: async (session, context) => {
            if (!db || !context) return;
            const u = await db.query.user.findFirst({
              where: eq(schema.user.id, session.userId),
              columns: { recoveryEmail: true, recoveryEmailVerified: true },
            });
            if (u?.recoveryEmail && !u.recoveryEmailVerified) {
              await context.context.internalAdapter.updateUser(session.userId, {
                recoveryEmailVerified: true,
                recoveryEmailVerifiedAt: Date.now(),
              });
            }
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        // Tighter than the default bucket for credential/2FA guessing.
        // (2FA also has better-auth's own failed-attempt lockout on top.)
        "/request-password-reset": { window: 60, max: 3 },
        "/sign-in/email": { window: 60, max: 5 },
        "/two-factor/*": { window: 60, max: 5 },
      },
    },
    session: {
      cookieCache: { enabled: true, maxAge: 60 * 5 },
      // Keep D1 authoritative for sessions; KV is only a read cache in front of
      // it. Revocation (logout / password reset) deletes from D1 and KV, so a
      // revoked session can't outlive KV's propagation window in the DB of record.
      storeSessionInDatabase: true,
    },
    verification: {
      // Same: verification values (email-verify links, our namespaced recovery /
      // reset / throttle tokens) stay in D1 so single-use consume is enforced
      // there and tokenStore.peek's direct D1 read still sees them; KV just caches.
      storeInDatabase: true,
    },
    plugins: [
      admin({
        defaultRole: "member",
        adminRoles: ["admin", "superadmin"],
        ac,
        roles,
      }),
      // org == domain. Only the super-admin may create orgs; they become the
      // org OWNER (org membership role) automatically via creatorRole.
      organization({
        allowUserToCreateOrganization: async (user) =>
          (user as { role?: string | null }).role === "superadmin",
        creatorRole: "owner",
        schema: {
          organization: {
            additionalFields: {
              domain: {
                type: "string",
                required: true,
                input: true,
                unique: true,
              },
              zoneId: { type: "string", required: false, input: false },
              // Onboarding lifecycle. CF is the source of truth for the actual
              // DNS/DKIM/routing state; we only cache which stage we're at.
              status: {
                type: "string",
                required: false,
                input: false,
                defaultValue: "pending_zone",
              },
            },
          },
        },
        organizationHooks: {
          beforeCreateOrganization: async ({ organization: org }) => {
            const domain = String((org as { domain?: string }).domain ?? "")
              .trim()
              .toLowerCase();
            if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/.test(domain)) {
              throw new APIError("BAD_REQUEST", {
                message: "A valid organization domain is required.",
              });
            }
            return {
              data: {
                ...org,
                domain,
                name: org.name || domain,
                slug: org.slug || domain.replace(/\./g, "-"),
              },
            };
          },
          afterCreateOrganization: async () => invalidateDomainCache(),
          afterUpdateOrganization: async () => invalidateDomainCache(),
          afterDeleteOrganization: async () => invalidateDomainCache(),
        },
      }),
      // Switching between accounts on DIFFERENT domains — NOT the /app↔/admin
      // switch (that is plain navigation within a single account).
      multiSession(),
      lastLoginMethod(),
      twoFactor(),
      // No TOTP after passkey login: a passkey is already two factors.
      passkey(),
      openAPI(),
      sveltekitCookies(getRequestEvent),
    ], // sveltekitCookies must be last
  });
}

export type Auth = ReturnType<typeof buildAuth>;

let auth: Auth | undefined;

export function createAuth(db: DrizzleD1Database<typeof schema>, kv?: KVNamespace) {
  return (auth ??= buildAuth(db, kv));
}

/**
 * Do not use this export, it's only for better auth cli to generate schema.
 */
const authClientGen = buildAuth();
export default authClientGen;
