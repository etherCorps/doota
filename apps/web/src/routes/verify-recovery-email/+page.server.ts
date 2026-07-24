// SPDX-License-Identifier: Apache-2.0
import { verifyRecoveryEmailToken } from "$lib/server/recovery-email.js";

export const load = async ({ url, locals, request }) => {
  const token = url.searchParams.get("token");
  const verified = token ? await verifyRecoveryEmailToken(token) : false;
  // Just wrote recoveryEmailVerified to D1 — force an uncached read so the cookie
  // cache rewrites now, instead of reporting the stale flag for up to 5 minutes.
  // Only when a session exists (the invite link can be opened while logged out).
  if (verified && locals.user) {
    await locals.auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
  }
  return { verified };
};
