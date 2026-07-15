import { redirect, type Handle } from "@sveltejs/kit";
import { building } from "$app/env";
import { createAuth } from "$lib/server/auth.js";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "$lib/server/db/schema.js";
import {
  getOnboardingStatus,
  markOnboarded,
  onboardingHome,
} from "$lib/server/onboarding.js";

const handleBetterAuth: Handle = async ({ event, resolve }) => {
  if (building) return resolve(event);

  const env = event.platform?.env;
  if (!env?.DB) {
    throw new Error(
      'D1 binding "DB" is missing. Run dev via `npm run dev` (platformProxy) after applying local migrations.',
    );
  }

  const db = drizzle(env.DB, { schema });

  const auth = createAuth(db);

  event.locals.db = db;
  event.locals.auth = auth;

  const session = await auth.api.getSession({ headers: event.request.headers });

  if (session) {
    event.locals.session = session.session;
    event.locals.user = session.user;

    const { user } = session;
    const p = event.url.pathname;
    // Better-auth's own routes and the recovery-link page must stay reachable
    // regardless of onboarding state (they're how a user COMPLETES onboarding).
    const bypass = p.startsWith("/api/auth") || p.startsWith("/verify-recovery-email");
    const inOnboarding = p.startsWith("/onboarding");

    if (!bypass) {
      if (user.onboardedAt) {
        // Fast path: finished. Don't let them wander back into the flow.
        if (inOnboarding) redirect(302, onboardingHome(user.role));
      } else {
        const status = await getOnboardingStatus(db, user);
        if (status.complete) {
          await markOnboarded(db, user.id);
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
