import { redirect } from "@sveltejs/kit";
import { onboardingHome } from "$lib/server/onboarding.js";
import { user as userTable } from "$lib/server/db/schema.js";

export const load = async ({ locals }) => {
  // Signed-in users have no business on an unauthenticated page.
  if (locals.user) {
    redirect(302, locals.onboarding ? "/onboarding" : onboardingHome(locals.user.role));
  }

  // Bootstrap is one-shot: the first user becomes the super-admin. Once anyone
  // exists, this page is closed — send would-be creators to login with a notice.
  const count = await locals.db.$count(userTable);
  if (count > 0) {
    redirect(
      303,
      "/login?notice=" +
        encodeURIComponent("Not allowed to create admin — an admin already exists."),
    );
  }

  return {
    title: "Create Admin",
    description: "Create an admin account for the application.",
  };
};
