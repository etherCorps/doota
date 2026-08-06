<!-- SPDX-License-Identifier: Apache-2.0 -->
# Org-wide two-factor enforcement (Phase C)

Status: **shipped.** Written from a code walkthrough 2026-08-06; file:line
references point at `apps/web/src/` unless noted.

An org owner or admin can **require two-factor authentication for everyone in the
organization**. Once enabled, every human member must have TOTP enrolled to reach
the app — but not instantly: enabling starts a **7-day grace period** so existing
members are prompted first and only blocked if they let the deadline pass.

Audience: operators and org admins. The toggle lives in **Admin → Organizations →
(org) → Settings**, the "Two-factor authentication" card.

---

## 1. What it does

- **Enable** (owner/admin) → the org's `require_2fa` flag is set and a grace
  deadline `require_2fa_from = now + 7 days` is stamped
  (`setOrgRequire2fa`, `domains.remote.ts`).
- **During grace** → a member without 2FA is *prompted* (a dismissible banner in
  the app) but not blocked. They can still work.
- **After the deadline** → a member without 2FA is *blocked* at the request guard
  and dropped back into onboarding's secure-account step until they enrol.
- **Already enrolled** → nothing changes. The gate is only evaluated for members
  whose 2FA is off, so it is free for everyone who already has it.
- **Disable** → clears both `require_2fa` and the deadline; no one is blocked.

The authorization on the toggle is owner/admin (superadmin included); the RPC
enforces it (`orgAdminOf` / `role === "superadmin"`), so the settings card can
render unconditionally — the call 403s for anyone else.

---

## 2. Enforcement is at the server guard, not the UI

The block is **not** a UI convenience — it is enforced in `hooks.server.ts` on
**every request** (`orgTwoFactorGate`). For a signed-in member whose session says
2FA is off, the guard reads the org's `require_2fa` / `require_2fa_from`:

- inside the window → `event.locals.enroll2faBy = <deadline ms>` (drives the
  banner) and the request proceeds;
- past the window → onboarding reopens at the secure-account step, exactly like an
  elevated security debt, so no in-app route is reachable until TOTP is enrolled.

Because it runs in the request guard, hiding or hacking the client banner does not
bypass it. The banner is a courtesy; the guard is the control.

---

## 3. API keys are exempt — and why

Bearer API keys (`dk_…`, service mailboxes — see `docs/service-accounts.md`) are
**exempt by construction**. They authenticate on `POST /api/send` with a hashed
bearer token; they never traverse the interactive session guard where the 2FA
gate lives, so there is nothing to prompt or block.

This is deliberate, not an oversight:

- **A bearer credential has no interactive step.** Two-factor authentication
  protects a human *login* — a password plus a second factor a person holds. An
  API key is a single long-lived secret presented by a machine. There is no login
  screen and no human to prompt for a code, so a second factor is meaningless on
  that path. The key *is* the credential; you rotate or revoke it, you don't 2FA
  it.
- **A service key has no owning user to enrol.** Keys belong to a service mailbox
  (`mailbox.isService = true`), not to a person. There is no user account behind
  it whose TOTP could be checked. Enforcing 2FA on it would break every
  integration the moment an org enabled the mandate, with no way for the "user" to
  ever satisfy it.

If you want to constrain what a key can do, that's the key's grants and
revocation, not the org 2FA mandate.

---

## 4. Break-glass — clear the mandate

**Scenario:** an owner enables org-wide 2FA, then loses their own 2FA device
before anyone can recover it — the mandate can now lock out the very person who'd
turn it off.

**First line of recovery is the recovery codes.** TOTP enrollment issues one-time
recovery codes at setup; a member who kept them can sign in with a recovery code
and enrol a new authenticator. Point the user there before touching the database.

**If that isn't possible**, an operator with D1 access clears the mandate
directly. This disables the requirement org-wide and drops the deadline, so the
guard stops blocking anyone in that org:

```
wrangler d1 execute <DB> --remote --command "UPDATE org_mail_settings SET require_2fa = 0, require_2fa_from = NULL WHERE org_id = '<org-id>';"
```

Substitute the D1 database name (`doota`) and the affected `org_id`. After this the
org has no 2FA mandate; re-enable it from the settings card once the owner has a
working authenticator again.
