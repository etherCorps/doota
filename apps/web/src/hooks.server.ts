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
} from "$lib/server/onboarding.js";
import { initLogLevel } from "@doota/mail-core/log";

const handleBetterAuth: Handle = async ({ event, resolve }) => {
  if (building) return resolve(event);

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
      // Security mandate: an admin/superadmin whose session says 2FA is off can
      // be signed in with bare credentials — even if already onboarded, they go
      // back through the secure-account step before anything else is reachable.
      if (user.onboardedAt && !hasSecurityDebt(user)) {
        // Fast path: finished. Don't let them wander back into the flow.
        if (inOnboarding) redirect(302, onboardingHome(user.role));
      } else {
        const status = await getOnboardingStatus(db, user);
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

  return svelteKitHandler({ event, resolve, auth, building });
};

export const handle: Handle = handleBetterAuth;
