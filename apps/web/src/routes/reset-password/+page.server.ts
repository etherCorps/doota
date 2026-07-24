// SPDX-License-Identifier: Apache-2.0
import { redirect } from "@sveltejs/kit";
import { onboardingHome } from "$lib/server/onboarding.js";

// Token-link reset for logged-OUT users. Signed-in users use the in-app dialog.
export const load = async ({ locals }) => {
  if (locals.user) {
    redirect(302, locals.onboarding ? "/onboarding" : onboardingHome(locals.user.role));
  }
  return {};
};
