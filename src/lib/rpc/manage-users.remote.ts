import { command, form, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as schema from "$lib/server/db/schema.js";
import { Email } from "$lib/shared/model/utils.zod.schema.js";
import { tryCatch } from "$lib/utils/try-catch.js";
import { can, type Actor } from "$lib/server/can.js";
import { actorOrgAdminOf, provisionUser } from "$lib/server/provisioning.js";

const ADMIN_ROLES = ["admin", "superadmin"];

/** Actor must be an instance admin/superadmin, else 403. Returns the actor. */
function requireAdmin(): Actor {
  const { locals } = getRequestEvent();
  const user = locals.user;
  if (!user) error(401, "Not authenticated");
  if (!ADMIN_ROLES.includes(user.role ?? "")) error(403, "Admins only");
  return { id: user.id, role: user.role };
}

/** Can the actor manage this specific target user? (own account / superadmin excluded elsewhere) */
async function assertCanManage(actor: Actor, targetUserId: string) {
  const { locals } = getRequestEvent();
  const target = await locals.db.query.user.findFirst({
    where: eq(schema.user.id, targetUserId),
    columns: { id: true, role: true },
  });
  if (!target) error(404, "User not found");
  if (target.id === actor.id) error(403, "You can't do that to your own account");
  if (target.role === "superadmin") error(403, "The super-admin can't be modified here");

  const membership = await locals.db.query.member.findFirst({
    where: eq(schema.member.userId, targetUserId),
    columns: { organizationId: true },
  });
  const orgAdminOf = await actorOrgAdminOf(locals.db, actor.id);
  const allowed = can({ id: actor.id, role: actor.role, orgAdminOf }, "manage", {
    type: "user",
    ownerId: target.id,
    organizationId: membership?.organizationId,
  });
  if (!allowed) error(403, "You don't manage this user's domain");
}

const createSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(30),
  email: z
    .string()
    .regex(
      /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i,
      "Letters, digits, dot, dash or underscore only",
    ),
  recoveryEmail: Email,
  role: z.enum(["member", "admin"]),
  organizationId: z.string().min(1),
});

export const createUser = form(createSchema, async (input) => {
  const actor = requireAdmin();
  const { locals } = getRequestEvent();
  const ctx = await locals.auth.$context;
  return provisionUser(ctx, locals.db, actor, input);
});

export const pauseUser = command(z.string(), async (userId) => {
  const actor = requireAdmin();
  await assertCanManage(actor, userId);
  const { locals } = getRequestEvent();

  const target = await locals.db.query.user.findFirst({
    where: eq(schema.user.id, userId),
    columns: { banned: true },
  });
  const paused = !target?.banned;
  await locals.db
    .update(schema.user)
    .set({ banned: paused })
    .where(eq(schema.user.id, userId));
  // Cut live access immediately when pausing (the ban check would otherwise
  // only bite after the 5-min session cookie cache expires).
  if (paused) {
    await tryCatch(
      locals.db.delete(schema.session).where(eq(schema.session.userId, userId)),
    );
  }
  return { paused };
});

export const removeUser = command(z.string(), async (userId) => {
  const actor = requireAdmin();
  await assertCanManage(actor, userId);
  const { locals } = getRequestEvent();
  const ctx = await locals.auth.$context;
  // Don't trust FK cascade: D1 doesn't reliably enforce ON DELETE CASCADE at
  // runtime, so purge the rows the task cares about explicitly. Sessions first
  // (cuts live access), then org memberships, then the user + its
  // account/twoFactor/passkey rows via the adapter.
  await locals.db.delete(schema.session).where(eq(schema.session.userId, userId));
  await locals.db.delete(schema.member).where(eq(schema.member.userId, userId));
  await ctx.internalAdapter.deleteUser(userId);
  return { removed: true };
});
