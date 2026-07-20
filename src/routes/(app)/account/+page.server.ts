import { redirect } from "@sveltejs/kit";

// /account → Profile is the landing sub-page.
export const load = async () => {
  redirect(302, "/account/profile");
};
