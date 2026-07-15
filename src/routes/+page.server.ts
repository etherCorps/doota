import { redirect } from "@sveltejs/kit";
import { user as userTable } from "$lib/server/db/schema.js";

export const load = async ({ locals }) => {
  if (locals.user) {
    // superadmin has no mailbox; everyone else starts in /app.
    redirect(302, locals.user.role === "superadmin" ? "/admin" : "/app");
  }
  // Fresh deployment with no accounts → bootstrap the super-admin.
  const count = await locals.db.$count(userTable);
  redirect(302, count === 0 ? "/create-admin" : "/login");
};
