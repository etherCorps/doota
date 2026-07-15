import { redirect } from "@sveltejs/kit";

// Oversight is a super-admin-only, read-only view across all orgs.
export const load = async ({ locals }) => {
  if (locals.user?.role !== "superadmin") redirect(302, "/admin");
  return {};
};
