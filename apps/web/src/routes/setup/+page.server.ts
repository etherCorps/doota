// SPDX-License-Identifier: Apache-2.0
import { redirect } from "@sveltejs/kit";
import { onboardingHome } from "$lib/server/onboarding.js";
import { user as userTable } from "@doota/db/schema";
import { SETUP_TOKEN } from "$app/env/private";

/**
 * Renders the genesis wizard ONLY when the user count is zero AND the one-time
 * SETUP_TOKEN is presented (?token=). Locks itself out permanently once a user
 * exists. When SETUP_TOKEN is unset, the wizard is disabled — use the CLI.
 */
export const load = async ({ locals, url }) => {
  if (locals.user) {
    redirect(302, locals.onboarding ? "/onboarding" : onboardingHome(locals.user.role));
  }

  const count = await locals.db.$count(userTable);
  if (count > 0) {
    redirect(
      303,
      "/login?notice=" +
        encodeURIComponent("Setup already completed — an admin already exists."),
    );
  }

  if (!SETUP_TOKEN) {
    return { locked: true as const, reason: "no-token" as const };
  }
  const token = url.searchParams.get("token") ?? "";
  if (token !== SETUP_TOKEN) {
    return { locked: true as const, reason: "bad-token" as const };
  }

  return { locked: false as const, token };
};
