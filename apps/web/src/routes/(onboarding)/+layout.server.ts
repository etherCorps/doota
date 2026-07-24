// SPDX-License-Identifier: Apache-2.0
import { redirect } from "@sveltejs/kit";
import { onboardingHome } from "$lib/server/onboarding.js";

export const load = async ({ locals }) => {
  const user = locals.user;
  if (!user) redirect(302, "/login");
  // hooks set locals.onboarding ONLY while steps remain. Absent => finished,
  // so there's nothing to do here — send them to their home surface.
  if (!locals.onboarding) redirect(302, onboardingHome(user.role));
  return {
    user: { name: user.name, email: user.email, role: user.role ?? "member" },
    onboarding: locals.onboarding,
  };
};
