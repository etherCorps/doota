// SPDX-License-Identifier: Apache-2.0
import { redirect } from "@sveltejs/kit";

const ADMIN_ROLES = ["admin", "superadmin"];

export const load = async ({ locals }) => {
  const user = locals.user;
  if (!user) redirect(302, "/login");
  if (!ADMIN_ROLES.includes(user.role ?? "")) redirect(302, "/app");
  return {
    user: {
      name: user.name,
      email: user.email,
      role: user.role ?? "member",
      image: user.image ?? null,
    },
  };
};
