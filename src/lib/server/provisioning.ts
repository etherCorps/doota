import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { getRequestEvent } from "$app/server";
import { ORIGIN } from "$app/env/public";
import * as schema from "./db/schema";
import { getDiceBearURL } from "$lib/utils/dice-bear.js";
import { tryCatch } from "$lib/utils/try-catch.js";
import { can, type Actor } from "./can";
import { isServedDomain, senderAddress } from "./org-domains";
import { sendMail } from "./mailer";
import { renderEmail } from "./email";
import { tokenStore, setUserAuthFlags } from "./auth/escape-hatches.js";

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
  actor: Actor,
  input: ProvisionInput,
): Promise<{ success: boolean; message: string }> {
  const { locals, request } = getRequestEvent();
  const db = locals.db;
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
  // admin.createUser is atomic (user + credential account in one call), so the
  // old create/link/rollback dance is gone. recoveryEmail (input:true) rides in
  // `data` so the user.create hook re-validates it; mustChangePassword is
  // input:false, so it's stamped separately below.
  const { error: createError, data: created } = await tryCatch(
    locals.auth.api.createUser({
      body: {
        email,
        password,
        name: input.name,
        role: input.role, // instance role: member | admin
        data: {
          recoveryEmail,
          image: getDiceBearURL({ seed: email }),
        },
      },
      headers: request.headers,
    }),
  );
  if (createError || !created?.user) {
    return {
      success: false,
      message: "Could not create the account — that email may already be in use.",
    };
  }
  const userId = created.user.id;

  await setUserAuthFlags(userId, { mustChangePassword: true });

  const { error: memberError } = await tryCatch(
    locals.auth.api.addMember({
      body: {
        userId,
        organizationId: org.id,
        role: input.role === "admin" ? "admin" : "member",
      },
      headers: request.headers,
    }),
  );
  if (memberError) {
    return {
      success: false,
      message: "Account created but could not be added to the organization.",
    };
  }

  // One invite mail: temp password + recovery-verification link (same namespaced
  // token the verify-recovery-email route consumes).
  const token = crypto.randomUUID();
  await tokenStore.issue(
    `recovery-email:${token}`,
    JSON.stringify({ userId, email: recoveryEmail }),
    RECOVERY_TOKEN_TTL_MS,
  );

  // Branded from the org they're joining (its own domain when sending is live).
  const from = await senderAddress(db, org.domain);
  const mail = renderEmail("invite", {
    from,
    mailbox: email,
    tempPassword: password,
    loginLink: `${ORIGIN}/login`,
    recoveryLink: `${ORIGIN}/verify-recovery-email?token=${token}`,
  });
  await tryCatch(
    sendMail({ to: recoveryEmail, from, subject: mail.subject, text: mail.text, html: mail.html }),
  );

  return {
    success: true,
    message: `Invite sent to ${recoveryEmail}.`,
  };
}
