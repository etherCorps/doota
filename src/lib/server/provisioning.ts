import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { getRequestEvent } from "$app/server";
import { ORIGIN } from "$app/env/public";
import * as schema from "./db/schema";
import { getDiceBearURL } from "$lib/utils/dice-bear.js";
import { tryCatch } from "$lib/utils/try-catch.js";
import { can, type Actor } from "./can";
import { isServedDomain, senderAddress } from "./org-domains";
import { sendMail, sendMailBackground } from "./mailer";
import { renderEmail } from "./email";
import { setUserAuthFlags } from "./auth/escape-hatches.js";
import { ensurePersonalMailbox } from "./mail/mailbox.js";

type Db = DrizzleD1Database<typeof schema>;

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

  // The address moves off the implied user.email into a mailbox row — the single
  // source of truth for "what address is this person". Idempotent, so a retried
  // provision converges. Failure here is non-fatal to the invite (the mailbox is
  // reconcilable), but log it.
  const { error: mailboxError } = await tryCatch(
    ensurePersonalMailbox(db, {
      orgId: org.id,
      userId,
      address: email,
      displayName: input.name,
    }),
  );
  if (mailboxError) console.error("[provision] personal mailbox failed", mailboxError);

  // One invite mail: temp password only. No recovery-verification link — the
  // invite is delivered ONLY to the external recovery address, so a successful
  // first login (with these creds) is itself proof of control, and the
  // session-create hook auto-verifies the recovery email then.
  const from = await senderAddress(db, org.domain);
  const mail = renderEmail("invite", {
    from,
    mailbox: email,
    tempPassword: password,
    loginLink: `${ORIGIN}/login?email=${email}&password=${password}`,
  });
  await tryCatch(
    sendMailBackground({ to: recoveryEmail, from, subject: mail.subject, text: mail.text, html: mail.html }),
  );

  return {
    success: true,
    message: `Invite sent to ${recoveryEmail}.`,
  };
}
