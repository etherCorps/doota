import { redirect } from "@sveltejs/kit";
import { onboardingHome } from "$lib/server/onboarding.js";

// Unauthenticated recovery page. Signed-in users reset via the in-app dialog
// (emailed code + current password), not this forgot-then-email-link flow.
export const load = async ({ locals }) => {
  if (locals.user) {
    redirect(302, locals.onboarding ? "/onboarding" : onboardingHome(locals.user.role));
  }
  return {};
};
