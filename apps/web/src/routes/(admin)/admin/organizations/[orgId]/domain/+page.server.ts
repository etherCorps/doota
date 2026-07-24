// SPDX-License-Identifier: Apache-2.0
import { error } from "@sveltejs/kit";

// The tab is hidden for non-superadmins, but the URL is guessable — every
// remote function this page calls is superadmin-gated, so gate the page too.
export const load = async ({ locals }) => {
  if (locals.user?.role !== "superadmin") {
    error(403, "Domain management is super-admin only");
  }
};
