// SPDX-License-Identifier: Apache-2.0
import { redirect } from "@sveltejs/kit";
import { getAuthz } from "$lib/server/authz.js";
import { cachedSendIdentities } from "$lib/server/mail-cache.js";

export const load = async ({ locals, platform }) => {
  const user = locals.user;
  if (!user) redirect(302, "/login");

  // Warm the KV caches on app entry (fire-and-forget — costs this page nothing):
  // the RPCs the shell fires next (thread list, unread count) hit a warm authz
  // snapshot, and the FIRST composer open reads identities from KV instead of
  // running its 5 D1 queries. Already-warm entry = 2 cheap KV reads.
  platform?.ctx?.waitUntil?.(Promise.allSettled([getAuthz(), cachedSendIdentities()]));
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
    // Set by hooks.server.ts when this member's org now requires 2FA and they're
    // still inside the grace window — drives the nudge banner (docs/2fa.md).
    enroll2faBy: locals.enroll2faBy ?? null,
  };
};
