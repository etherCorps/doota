// SPDX-License-Identifier: Apache-2.0
import { command, form, query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, count, eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { Email } from "$lib/shared/model/utils.zod.schema.js";
import { tryCatch } from "$lib/utils/try-catch.js";
import { can, type Actor } from "@doota/db/can";
import { provisionUser } from "$lib/server/provisioning.js";
import { getAuthz, invalidateAuthz } from "$lib/server/authz.js";
import { invalidateUserMailCache } from "$lib/server/mail-cache.js";
import { purgeUserMemberships } from "$lib/server/auth/escape-hatches.js";

const ADMIN_ROLES = ["admin", "superadmin"];

/** Actor must be an instance admin/superadmin, else 403. Returns the actor. */
function requireAdmin(): Actor {
  const { locals } = getRequestEvent();
  const user = locals.user;
  if (!user) error(401, "Not authenticated");
  if (!ADMIN_ROLES.includes(user.role ?? "")) error(403, "Admins only");
  return { id: user.id, role: user.role };
}

/** Actor must manage the target's org (superadmin actor always passes can()). */
async function assertManagesOrg(actor: Actor, targetUserId: string) {
  const { locals } = getRequestEvent();
  const membership = await locals.db.query.member.findFirst({
    where: eq(schema.member.userId, targetUserId),
    columns: { organizationId: true },
  });
  const { orgAdminOf } = await getAuthz();
  const allowed = can({ id: actor.id, role: actor.role, orgAdminOf }, "manage", {
    type: "user",
    ownerId: targetUserId,
    organizationId: membership?.organizationId,
  });
  if (!allowed) error(403, "You don't manage this user's domain");
}

/** Can the actor manage this specific target user? (own account / superadmin excluded) */
async function assertCanManage(actor: Actor, targetUserId: string) {
  const { locals } = getRequestEvent();
  const target = await locals.db.query.user.findFirst({
    where: eq(schema.user.id, targetUserId),
    columns: { id: true, role: true },
  });
  if (!target) error(404, "User not found");
  if (target.id === actor.id) error(403, "You can't do that to your own account");
  if (target.role === "superadmin") error(403, "The super-admin can't be modified here");
  await assertManagesOrg(actor, targetUserId);
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
  host: z.string().optional(),
});

export const createUser = form(createSchema, async (input) => {
  const actor = requireAdmin();
  return provisionUser(actor, input);
});

export const pauseUser = command(z.string(), async (userId) => {
  const actor = requireAdmin();
  await assertCanManage(actor, userId);
  const { locals, request } = getRequestEvent();

  const target = await locals.db.query.user.findFirst({
    where: eq(schema.user.id, userId),
    columns: { banned: true },
  });
  const paused = !target?.banned;
  if (paused) {
    await locals.auth.api.banUser({ body: { userId }, headers: request.headers });
    // Cut live access immediately (the ban check would otherwise only bite after
    // the 5-min session cookie cache expires).
    await tryCatch(
      locals.auth.api.revokeUserSessions({ body: { userId }, headers: request.headers }),
    );
  } else {
    await locals.auth.api.unbanUser({ body: { userId }, headers: request.headers });
  }
  return { paused };
});

export const getMemberDetail = query(
  z.object({ userId: z.string().min(1), organizationId: z.string().min(1) }),
  async ({ userId, organizationId }) => {
    const actor = requireAdmin();
    const { locals } = getRequestEvent();
    const target = await locals.db.query.user.findFirst({
      where: eq(schema.user.id, userId),
      columns: {
        id: true,
        role: true,
        name: true,
        email: true,
        recoveryEmail: true,
        recoveryEmailVerified: true,
        emailVerified: true,
        twoFactorEnabled: true,
        createdAt: true,
        banned: true,
        onboardedAt: true,
        mustChangePassword: true,
        invitedByUserId: true,
      },
    });
    if (!target) error(404, "User not found");
    // Viewing (unlike mutating) allows self + superadmin targets, but the actor
    // must still manage the target's org.
    await assertManagesOrg(actor, userId);

    const memberRow = await locals.db.query.member.findFirst({
      where: and(
        eq(schema.member.userId, userId),
        eq(schema.member.organizationId, organizationId),
      ),
      columns: { id: true, role: true, createdAt: true },
    });
    if (!memberRow) error(404, "Not a member of this organization");

    const [sessionTally] = await locals.db
      .select({ sessionCount: count() })
      .from(schema.session)
      .where(eq(schema.session.userId, userId));

    let inviterName: string | null = null;
    if (target.invitedByUserId) {
      const inviter = await locals.db.query.user.findFirst({
        where: eq(schema.user.id, target.invitedByUserId),
        columns: { name: true },
      });
      inviterName = inviter?.name ?? null;
    }

    return {
      name: target.name,
      email: target.email,
      recoveryEmail: target.recoveryEmail,
      recoveryEmailVerified: !!target.recoveryEmailVerified,
      twoFactorEnabled: !!target.twoFactorEnabled,
      createdAt: target.createdAt,
      banned: !!target.banned,
      onboardedAt: target.onboardedAt,
      mustChangePassword: !!target.mustChangePassword,
      role: memberRow.role,
      memberRowId: memberRow.id,
      memberSince: memberRow.createdAt,
      sessionCount: sessionTally?.sessionCount ?? 0,
      inviterName,
      // Same status rules as the members-table load — the sheet header renders
      // this after mutations so it never shows the stale table-row status.
      status: target.banned
        ? "paused"
        : target.onboardedAt || target.recoveryEmailVerified || target.emailVerified
          ? "active"
          : "pending",
      editable: target.id !== actor.id && target.role !== "superadmin",
    };
  },
);

export const updateMemberProfile = command(
  z.object({
    userId: z.string().min(1),
    name: z.string().min(2, "Name must be at least 2 characters").max(30),
    recoveryEmail: Email,
  }),
  async ({ userId, name, recoveryEmail }) => {
    const actor = requireAdmin();
    await assertCanManage(actor, userId);
    const { locals, request } = getRequestEvent();
    const current = await locals.db.query.user.findFirst({
      where: eq(schema.user.id, userId),
      columns: { recoveryEmail: true },
    });
    const data: Record<string, unknown> = { name };
    if (recoveryEmail !== current?.recoveryEmail) {
      // An edited recovery address must re-verify — it's where invites/resets land.
      data.recoveryEmail = recoveryEmail;
      data.recoveryEmailVerified = false;
      data.recoveryEmailVerifiedAt = null;
    }
    await locals.auth.api.adminUpdateUser({ body: { userId, data }, headers: request.headers });
    await invalidateAuthz(userId);
    return { updated: true };
  },
);

export const changeMemberRole = command(
  z.object({
    userId: z.string().min(1),
    memberRowId: z.string().min(1),
    organizationId: z.string().min(1),
    role: z.enum(["member", "admin"]),
  }),
  async ({ userId, memberRowId, organizationId, role }) => {
    const actor = requireAdmin();
    await assertCanManage(actor, userId);
    const { locals, request } = getRequestEvent();
    const memberRow = await locals.db.query.member.findFirst({
      where: eq(schema.member.id, memberRowId),
      columns: { role: true },
    });
    if (!memberRow) error(404, "Member not found");
    if (memberRow.role === "owner") error(403, "The owner role can't be changed here");
    await locals.auth.api.updateMemberRole({
      body: { role, memberId: memberRowId, organizationId },
      headers: request.headers,
    });
    await invalidateAuthz(userId);
    return { role };
  },
);

export const revokeMemberSessions = command(z.string(), async (userId) => {
  const actor = requireAdmin();
  await assertCanManage(actor, userId);
  const { locals, request } = getRequestEvent();
  await locals.auth.api.revokeUserSessions({ body: { userId }, headers: request.headers });
  return { revoked: true };
});

export const removeUser = command(z.string(), async (userId) => {
  const actor = requireAdmin();
  await assertCanManage(actor, userId);
  const { locals, request } = getRequestEvent();
  // admin.removeUser deletes the user + its sessions/accounts/2FA/passkey, but
  // NOT the org plugin's member rows (and D1 cascade is unreliable) — purge those
  // first, then remove the user.
  await purgeUserMemberships(userId);
  await locals.auth.api.removeUser({ body: { userId }, headers: request.headers });
  // Deleted from D1 → deleted from KV: no cached snapshot may outlive the row.
  await invalidateAuthz(userId);
  await invalidateUserMailCache(userId);
  return { removed: true };
});
