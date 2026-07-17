import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { ORIGIN } from "$app/env/public";
import * as schema from "./db/schema";
import { getDiceBearURL } from "$lib/utils/dice-bear.js";
import { tryCatch } from "$lib/utils/try-catch.js";
import { can, type Actor } from "./can";
import { isServedDomain } from "./org-domains";
import { sendMail } from "./mailer";
import type { Auth } from "./auth";

type AuthContext = Awaited<Auth["$context"]>;
type Db = DrizzleD1Database<typeof schema>;

const RECOVERY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h — matches invite lifetime

export type ProvisionInput = {
  name: string;
  /** Local part only; the org's domain is appended server-side. */
  email: string;
  recoveryEmail: string;
  role: "member" | "admin";
  organizationId: string;
};

/** Org ids where the actor is owner/admin — the orgs they may provision into. */
export async function actorOrgAdminOf(
  db: Db,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ orgId: schema.member.organizationId, role: schema.member.role })
    .from(schema.member)
    .where(eq(schema.member.userId, userId));
  return rows
    .filter((r) => r.role === "owner" || r.role === "admin")
    .map((r) => r.orgId);
}

// ponytail: emails a one-time temp password to the admin-vetted external
// recovery address (classic invite). mustChangePassword forces a reset at first
// login, so the temp value never survives onboarding. Upgrade to a set-password
// magic link if plaintext-in-mail ever becomes unacceptable for this deployment.
function tempPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes))
    .replace(/[+/=]/g, "")
    .slice(0, 16);
}

/**
 * Create a member/admin under the organization that owns their email's domain,
 * then mail an invite (temp password + recovery-verification link) to their
 * external recovery address. Authorization runs through can() — superadmin or an
 * admin of the target org only.
 */
export async function provisionUser(
  ctx: AuthContext,
  db: Db,
  actor: Actor,
  input: ProvisionInput,
): Promise<{ success: boolean; message: string }> {
  const username = input.email.trim().toLowerCase();
  const recoveryEmail = input.recoveryEmail.trim().toLowerCase();

  // Membership is chosen up front: the org pins the domain, so the admin only
  // supplies the local part.
  const org = await db.query.organization.findFirst({
    where: eq(schema.organization.id, input.organizationId),
    columns: { id: true, domain: true, status: true },
  });
  if (!org?.domain) {
    return { success: false, message: "Organization not found." };
  }
  // Per-domain accounts may only be created once the domain is active — a
  // working sending path exists, so the invite mail can actually be delivered.
  if (org.status !== "active") {
    return {
      success: false,
      message: "This domain isn't active yet. Finish onboarding it before adding users.",
    };
  }
  const email = `${username}@${org.domain}`;

  // Recovery address must be external — a served-domain recovery recreates the
  // "can't read your mailbox until you're logged in" deadlock.
  if (await isServedDomain(db, recoveryEmail)) {
    return {
      success: false,
      message: "Recovery email must be an external address, not a hosted one.",
    };
  }

  const orgAdminOf = await actorOrgAdminOf(db, actor.id);
  const allowed = can(
    { id: actor.id, role: actor.role, orgAdminOf },
    "manage",
    { type: "user", ownerId: "", organizationId: org.id },
  );
  if (!allowed) {
    return {
      success: false,
      message: "You don't have permission to add users to this domain.",
    };
  }

  const password = tempPassword();
  const { error: createError, data: createdUser } = await tryCatch(
    ctx.internalAdapter.createUser({
      email,
      name: input.name,
      role: input.role,
      recoveryEmail,
      mustChangePassword: true,
      image: getDiceBearURL({ seed: email }),
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );
  if (createError || !createdUser) {
    return {
      success: false,
      message: "Could not create the account — that email may already be in use.",
    };
  }

  // Password lives on the credential account. On failure roll the user back so a
  // retry isn't blocked by an orphaned, passwordless account.
  const { error: linkError } = await tryCatch(
    ctx.internalAdapter.linkAccount({
      providerId: "credential",
      accountId: createdUser.id,
      userId: createdUser.id,
      password: await ctx.password.hash(password),
    }),
  );
  if (linkError) {
    await tryCatch(ctx.internalAdapter.deleteUser(createdUser.id));
    return {
      success: false,
      message: "Could not set the initial password. Please try again.",
    };
  }

  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: org.id,
    userId: createdUser.id,
    role: input.role === "admin" ? "admin" : "member",
    createdAt: new Date(),
  });

  // One invite mail: temp password + recovery-verification link (same namespaced
  // token the verify-recovery-email route consumes).
  const token = crypto.randomUUID();
  await ctx.internalAdapter.createVerificationValue({
    identifier: `recovery-email:${token}`,
    value: JSON.stringify({ userId: createdUser.id, email: recoveryEmail }),
    expiresAt: new Date(Date.now() + RECOVERY_TOKEN_TTL_MS),
  });

  await tryCatch(
    sendMail({
      to: recoveryEmail,
      subject: "You've been invited to Doota",
      text:
        `You have a new Doota ${input.role} account.\n\n` +
        `Sign in at ${ORIGIN}/login\n` +
        `  Email:    ${email}\n` +
        `  Password: ${password}\n\n` +
        `You'll be asked to set your own password and finish setup after signing in.\n` +
        `Confirm this recovery address: ${ORIGIN}/verify-recovery-email?token=${token}\n` +
        `This invite expires in 24 hours.`,
    }),
  );

  return {
    success: true,
    message: `Invite sent to ${recoveryEmail}.`,
  };
}
