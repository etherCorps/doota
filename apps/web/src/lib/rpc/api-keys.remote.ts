// SPDX-License-Identifier: Apache-2.0
import { command, query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { revokeApiKey, listApiKeys, apiKeyOwner } from "$lib/server/auth/api-key.js";

/**
 * Read-only view of a user's OWN legacy keys. New keys are no longer minted
 * per-user: programmatic send is a service-mailbox concern (a leaked key hurts
 * the whole domain's reputation), so keys are issued by org admins against
 * service mailboxes (see mailbox.remote.ts). Users may still list and revoke
 * their existing keys here.
 */

function requireUser() {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  return locals.user;
}

export const myApiKeys = query(async () => {
  const user = requireUser();
  const { locals } = getRequestEvent();
  return listApiKeys(locals.db, user.id);
});

export const revokeApiKeyById = command(z.object({ keyId: z.string().min(1) }), async ({ keyId }) => {
  const user = requireUser();
  const { locals } = getRequestEvent();
  const owner = await apiKeyOwner(locals.db, keyId);
  if (!owner) error(404, "Key not found");
  if (owner !== user.id) error(403, "Not your key");
  await revokeApiKey(locals.db, keyId);
  return { ok: true as const };
});
