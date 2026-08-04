// SPDX-License-Identifier: Apache-2.0
import { redirect } from "@sveltejs/kit";
import { onboardingHome } from "$lib/server/onboarding.js";
import { MAX_DEVICE_SESSIONS } from "$lib/auth-limits.js";

export const load = async ({ locals, url, request }) => {
  // Signed-in users have no business on an unauthenticated page. (Incomplete
  // onboarding is already bounced to /onboarding by hooks; this covers the
  // fully-onboarded case, which hooks lets through.) Exception: ?add — the
  // multiSession "Add account" flow signs a SECOND account in from a live
  // session, so the form must render.
  if (locals.user && !url.searchParams.has("add")) {
    redirect(302, locals.onboarding ? "/onboarding" : onboardingHome(locals.user.role));
  }
  // At the device-session cap, another sign-in would NOT be tracked by
  // multiSession (silent data-loss-shaped failure) — block the form and say why.
  if (locals.user) {
    const sessions = await locals.auth.api.listDeviceSessions({ headers: request.headers });
    if (sessions.length >= MAX_DEVICE_SESSIONS) {
      return { notice: null, addLimit: true as const };
    }
  }
  return { notice: url.searchParams.get("notice"), addLimit: false as const };
};
