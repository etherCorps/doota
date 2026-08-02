// SPDX-License-Identifier: Apache-2.0
import { redirect } from "@sveltejs/kit";

// Developer (programmatic send) is a service-mailbox feature. If the account
// layout decided this user can't reach one, a direct hit here bounces to Profile.
export const load = async ({ parent }) => {
  const { canDeveloper } = await parent();
  if (!canDeveloper) redirect(302, "/account/profile");
};
