import { command, query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as schema from "$lib/server/db/schema.js";
import { resolveSender } from "$lib/server/mail/resolver.js";
import {
  createApiKey,
  revokeApiKey,
  listApiKeys,
  apiKeyOwner,
} from "$lib/server/auth/api-key.js";

/**
 * Programmatic send keys — a user manages their OWN keys here. A key acts as its
 * owning user: creation validates the (optional) mailbox scope through the SAME
 * resolveSender()/can() send check the interactive path uses, so a key can never
 * be minted for a mailbox the user can't send as. The plaintext secret is
 * returned exactly once, at creation.
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

export const createApiKeyForUser = command(
  z.object({
    name: z.string().trim().max(80).optional(),
    // null/absent → any mailbox the user can send as; else scoped to this one.
    mailboxId: z.string().min(1).nullish(),
  }),
  async ({ name, mailboxId }) => {
    const user = requireUser();
    const { locals } = getRequestEvent();

    let orgId: string;
    if (mailboxId) {
      // Validates send capability + resolves the mailbox's org.
      const sender = await resolveSender(locals.db, user.id, mailboxId);
      orgId = sender.orgId;
    } else {
      const membership = await locals.db.query.member.findFirst({
        where: eq(schema.member.userId, user.id),
        columns: { organizationId: true },
      });
      if (!membership) error(400, "You have no organization to issue a key for.");
      orgId = membership.organizationId;
    }

    const created = await createApiKey(locals.db, {
      orgId,
      userId: user.id,
      mailboxId: mailboxId ?? null,
      name: name?.trim() || undefined,
    });
    // `key` is the plaintext secret — shown ONCE, never retrievable again.
    return { id: created.id, key: created.key, prefix: created.prefix };
  },
);

export const revokeApiKeyById = command(z.object({ keyId: z.string().min(1) }), async ({ keyId }) => {
  const user = requireUser();
  const { locals } = getRequestEvent();
  const owner = await apiKeyOwner(locals.db, keyId);
  if (!owner) error(404, "Key not found");
  if (owner !== user.id) error(403, "Not your key");
  await revokeApiKey(locals.db, keyId);
  return { ok: true as const };
});
