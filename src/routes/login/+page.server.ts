import { redirect } from "@sveltejs/kit";
import { onboardingHome } from "$lib/server/onboarding.js";

export const load = async ({ locals, url }) => {
  // Signed-in users have no business on an unauthenticated page. (Incomplete
  // onboarding is already bounced to /onboarding by hooks; this covers the
  // fully-onboarded case, which hooks lets through.)
  if (locals.user) {
    redirect(302, locals.onboarding ? "/onboarding" : onboardingHome(locals.user.role));
  }
  return { notice: url.searchParams.get("notice") };
};
