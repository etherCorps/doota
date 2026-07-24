// SPDX-License-Identifier: Apache-2.0
import { redirect } from "@sveltejs/kit";

export const load = async ({ locals }) => {
  const user = locals.user;
  if (!user) redirect(302, "/login");
  // superadmin is external, has no mailbox → no /app.
  // if (user.role === "superadmin") redirect(302, "/admin");
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role ?? "member",
      image: user.image ?? null,
    },
  };
};
