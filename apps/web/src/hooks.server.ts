// SPDX-License-Identifier: Apache-2.0
import { redirect, type Handle } from "@sveltejs/kit";
import { building } from "$app/env";
import { createAuth } from "$lib/server/auth.js";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import {
  getOnboardingStatus,
  hasSecurityDebt,
  markOnboarded,
  notifyOnboardingComplete,
  onboardingHome,
  orgTwoFactorGate,
} from "$lib/server/onboarding.js";
import { initLogLevel } from "@doota/mail-core/log";

const handleBetterAuth: Handle = async ({ event, resolve }) => {
  if (building) return resolve(event);

  // The better-auth admin plugin's HTTP routes (/api/auth/admin/*: set-role,
  // impersonate-user, ban, remove, etc.) are NOT used by the app — every
  // privileged action goes through org-scoped, server-side auth.api.* in the RPC
  // layer. Left reachable over HTTP, a logged-in instance admin could self-promote
  // to superadmin or impersonate members across orgs (the plugin gates only on the
  // instance role, bypassing our org scoping). Block the raw routes at the edge;
  // server-side auth.api.* calls don't pass through this handler, so provisioning
  // and the app's own admin actions keep working.
  if (event.url.pathname.startsWith("/api/auth/admin/")) {
    return new Response("Not found", { status: 404 });
  }

  const env = event.platform?.env;
  if (!env?.DB) {
    throw new Error(
      'D1 binding "DB" is missing. Run dev via `npm run dev` (platformProxy) after applying local migrations.',
    );
  }

  initLogLevel(env);
  const db = drizzle(env.DB, { schema });

  const auth = createAuth(db, env.AUTH_KV);

  event.locals.db = db;
  event.locals.auth = auth;

  let session = await auth.api.getSession({ headers: event.request.headers });

  if (session) {
    event.locals.session = session.session;
    event.locals.user = session.user;

    // A just-completed mail verification wrote fresh flags to D1, but the 5-min
    // session cookie cache still holds the stale user. `?verified=1` (set on every
    // verification landing) forces one uncached read + cookie rewrite so the new
    // emailVerified / recoveryEmailVerified is live immediately, for all users.
    // ponytail: harmless if spoofed — costs the caller one extra own-session read.
    if (event.url.searchParams.has("verified")) {
      const fresh = await auth.api.getSession({
        headers: event.request.headers,
        query: { disableCookieCache: true },
      });
      if (fresh) {
        session = fresh;
        event.locals.session = fresh.session;
        event.locals.user = fresh.user;
      }
    }

    const { user } = session;
    const p = event.url.pathname;
    // Better-auth's own routes and the recovery-link page must stay reachable
    // regardless of onboarding state (they're how a user COMPLETES onboarding).
    const bypass = p.startsWith("/api/auth") || p.startsWith("/verify-recovery-email");
    const inOnboarding = p.startsWith("/onboarding");

    if (!bypass) {
      // Org-wide 2FA mandate (Phase C): a member of a require_2fa org past the
      // grace deadline must enroll TOTP too. Only checked when 2FA is off — free
      // for everyone already enrolled. `grace` sets a soft flag for a UI nudge;
      // `block` reopens onboarding just like an elevated security debt.
      const orgGate = user.twoFactorEnabled
        ? ({ kind: "none" } as const)
        : await orgTwoFactorGate(db, user, session.session.activeOrganizationId);
      if (orgGate.kind === "grace") event.locals.enroll2faBy = orgGate.deadline;
      const mustEnroll2fa = orgGate.kind === "block";

      // Security mandate: an admin/superadmin whose session says 2FA is off can
      // be signed in with bare credentials — even if already onboarded, they go
      // back through the secure-account step before anything else is reachable.
      if (user.onboardedAt && !hasSecurityDebt(user) && !mustEnroll2fa) {
        // Fast path: finished. Don't let them wander back into the flow.
        if (inOnboarding) redirect(302, onboardingHome(user.role));
      } else {
        const status = await getOnboardingStatus(db, user, mustEnroll2fa);
        if (status.complete) {
          await markOnboarded(auth, user.id);
          // First completion only (the 2FA-reopen path re-enters here with
          // onboardedAt already stamped — no duplicate mails).
          if (!user.onboardedAt) {
            await notifyOnboardingComplete(db, user.id).catch((e) =>
              console.error("[onboarding] completion mails failed", e),
            );
          }
          // Rewrite the session cookie cache so onboardedAt is reflected NOW.
          // Without this the cache (~5 min) still reports onboardedAt = null and
          // every request re-derives status; refetching fresh makes the server
          // authoritative and lets subsequent requests take the fast path.
          const refreshed = await auth.api.getSession({
            headers: event.request.headers,
            query: { disableCookieCache: true },
          });
          if (refreshed) {
            event.locals.session = refreshed.session;
            event.locals.user = refreshed.user;
          }
          if (inOnboarding) redirect(302, onboardingHome(user.role));
        } else {
          event.locals.onboarding = status;
          // Nothing else is reachable until onboarding is done.
          if (!inOnboarding) redirect(302, "/onboarding");
        }
      }
    }
  }

  return svelteKitHandler({
    event,
    // Attach transport-security headers to every resolved response. HSTS closes
    // the SSL-strip downgrade path (paired with Secure cookies in auth.ts);
    // nosniff blocks content-type confusion. No global X-Frame-Options — the app
    // frames its own mail/attachment views same-origin (those routes set their
    // own frame-ancestors CSP).
    resolve: async (innerEvent) => {
      const response = await resolve(innerEvent);
      response.headers.set(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains; preload",
      );
      response.headers.set("X-Content-Type-Options", "nosniff");
      return response;
    },
    auth,
    building,
  });
};

export const handle: Handle = handleBetterAuth;
