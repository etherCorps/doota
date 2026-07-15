/**
 * Single authorization chokepoint — route EVERY permission decision
 * through can() so there is one place to audit and log.
 *
 * can() is a pure decision function: the caller looks up the facts (the actor's
 * instance role, which orgs they administer, the target's org) and passes them
 * in. That keeps this the one auditable place with no hidden I/O.
 *
 * Model:
 *   - Instance role (member | admin | superadmin) comes from the admin plugin.
 *   - Org membership role (owner | admin | member) is per-organization; the
 *     caller resolves the actor's owner/admin memberships into `orgAdminOf`.
 *   - superadmin is the platform operator: read/manage anything, but NOT
 *     send-as-others (sending is a mailbox capability, never granted by role).
 */

export type Action = "read" | "manage" | "send";

export type Target = {
  /** e.g. "mailbox" | "user" | "settings" */
  type: string;
  /** user id that owns the target */
  ownerId: string;
  /** organization the target belongs to (its domain's org) */
  organizationId?: string;
  /** user ids explicitly granted sender rights (shared mailboxes) */
  grantedSenderIds?: string[];
};

export type Actor = {
  id: string;
  /** instance role: member | admin | superadmin */
  role?: string | null;
  /** ids of orgs where this actor is owner or admin (org membership role) */
  orgAdminOf?: string[];
};

export function can(user: Actor, action: Action, target: Target): boolean {
  const allowed = decide(user, action, target);
  if (!allowed) {
    console.log("[can:deny]", {
      userId: user.id,
      role: user.role,
      action,
      target: { type: target.type, ownerId: target.ownerId, organizationId: target.organizationId },
    });
  }
  return allowed;
}

function decide(user: Actor, action: Action, target: Target): boolean {
  const isOwner = user.id === target.ownerId;

  // Sending is a mailbox capability, not a role — even superadmin can't send as
  // someone else. Only the mailbox owner or an explicitly granted sender.
  if (action === "send") {
    return isOwner || (target.grantedSenderIds?.includes(user.id) ?? false);
  }

  // superadmin: platform operator — read/manage everything.
  if (user.role === "superadmin") return true;

  // org-admin over the target's organization → read/manage within that org.
  if (
    target.organizationId &&
    user.orgAdminOf?.includes(target.organizationId)
  ) {
    return true;
  }

  return isOwner;
}
