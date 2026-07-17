# Flows

## Bootstrap: first super-admin — EMAIL-FREE genesis

At genesis **no domain is onboarded**, so Cloudflare Email Routing/Sending don't
exist yet — there is no path to deliver mail. So genesis must not depend on
email. **The trust root is deploy access (possession of instance secrets), not
an email round-trip.** Two surfaces, same trust model, both gated on
`userCount === 0`:

**CLI (the guaranteed floor — works with no web layer and no mail):**
`pnpm reset-admin <external-email> <password> [--name "…"]`. When no super-admin
exists it runs in **genesis** mode: creates the super-admin, links the password,
and **enrolls TOTP** (mirrors better-auth's own storage — an encrypted secret +
backup codes). It prints the `otpauth://` URI + backup codes to scan. No mail.
The same command is the reset/recovery escape hatch once the account exists.

**Optional web `/setup` wizard:** renders ONLY when `userCount === 0` **AND** the
one-time `SETUP_TOKEN` (env) is presented (`/setup?token=…`). `setup.remote.ts`
re-checks both server-side. It creates the super-admin + password (TOTP is added
later via the onboarding secure-account step). No verification mail is sent. Once
any user exists the wizard locks out permanently.

In both paths the super-admin is created with an **external** email
(`isServedDomain` rejects served-domain addresses) stored **unverified**
(`email_verified = false`). If password linking fails the just-created user is
deleted so the `userCount` guard can't wedge the bootstrap on retry.

Every later account is provisioned by an admin/super-admin through the
organization flow below.

## Deferred super-admin email verification

The super-admin's external email is intentionally **unverified at genesis**.
Verifying it is an optional, super-admin-triggered action
(`requestSuperadminEmailVerification`, surfaced on `/admin/settings`) that only
becomes available once **at least one domain is `active`** — i.e. there is a
working sending path to actually deliver the mail. Until then:

- password reset by email no-ops for the super-admin (`sendResetPassword` only
  targets `user.email` when `emailVerified` is true), and
- the **CLI `reset-admin` is the recovery floor** — recovery never depends on an
  unverified/undeliverable path.

## Onboarding gate (`hooks.server.ts` + `onboarding.ts`)

Once signed in, a user cannot reach anything until onboarding is complete. The
gate lives in `hooks.server.ts`:

- If `user.onboardedAt` is set → **fast path**, no per-request work; only block
  wandering back into `/onboarding`.
- Otherwise `getOnboardingStatus(db, user)` derives the remaining steps **reading
  the gating flags fresh from D1** (never the 5-minute session cookie cache):
  - `superadmin` → **secure account** only (2FA / passkey). No email step — email
    verification is deferred (see above), so genesis needs no mail path.
  - `admin` → verify **recovery email** + **secure account**
  - `member` → verify **recovery email**
  - anyone provisioned with a temp password → **set password**
    (`mustChangePassword`)
- If complete → `markOnboarded` stamps `onboardedAt` **on that same request**,
  then the session is refetched with `disableCookieCache: true` so the signed
  cookie reflects it immediately and later requests take the fast path.
- If not complete → `locals.onboarding` is populated and any non-`/onboarding`
  path redirects to `/onboarding`.

`/api/auth/*` and `/verify-recovery-email` are bypass paths — they are how a user
*completes* onboarding, so they stay reachable regardless of state. The
`/onboarding` route has **no sidebar**; it renders the checklist and the relevant
step cards.

## Domain onboarding via Cloudflare (super-admin only)

`/admin/domains`. Super-admin only; uses the instance token (`CF_ACCOUNT_ID` +
`CF_API_TOKEN`, a scoped Bearer token). `domains.remote.ts` → `server/cloudflare.ts`.

**Pick, don't type.** `listCloudflareZones` lists every zone on the operator's
CF account (flagging which are already onboarded) so they choose a domain instead
of typing it. A manual field remains for a domain **not yet on Cloudflare**. An
optional **sending subdomain** (outbound DKIM host, e.g. `send.acme.com`) can be
supplied at onboard time; it must sit within the domain.

`onboardDomain`:

1. Create the org for the domain (super-admin becomes owner) if it doesn't exist.
2. `zoneCreate`: if the domain is **already a zone on the account → reuse it**
   (straight to wiring, no error — this is the "already configured on Cloudflare"
   case). Brand-new → `POST /zones`, returns pending status + assigned
   **nameservers**, surfaced to the operator. The request is **not** blocked on
   activation — it's async D1 state.
3. Once the zone is `active` (checked on onboard, or by the **Refresh** button →
   `refreshDomain` poll), wire mail **idempotently**: enable Email Routing, write
   MX + SPF (inbound), onboard the sending domain/subdomain (DKIM + DMARC +
   cf-bounce), and point the catch-all rule at the mail-in Worker
   (`MAIL_IN_WORKER_NAME`). Every call is check-then-create / tolerates "already
   exists".

**DNS records** to populate (Email Sending DKIM/DMARC/return-path) are fetched
live per domain via `domainDnsRecords` and shown on the screen — never persisted.
For a Cloudflare-hosted zone they're created automatically; the list is there for
operators whose DNS lives elsewhere.

Subdomain **mailbox routing** (inbound `*@mail.acme.com`) is not built — Email
Routing catch-all is zone-level (apex). The optional subdomain above is
outbound-sending only.

**Storage:** D1 holds only `domain`, `zone_id`, the org mapping, and a `status`
enum (`pending_zone | pending_nameservers | wiring | active | error`). DNS/DKIM/
routing state is **never persisted** — fetched live from CF for settings screens.
The CF API is **never** touched on the inbound-mail hot path or login validation
(those read the cached `domain→org→zone` map).

## Admin provisions a member / admin (org-centric)

Admins work **through an organization**: `/admin/organizations` → pick an org →
manage its members. An org is one mail domain; picking the org pins the domain,
so the admin supplies only the **local part** of the new mailbox. Provisioning is
**only allowed once the domain is `active`** (a working sending path exists, so
the invite mail can be delivered).

`createUser` (`manage-users.remote.ts`) → `provisionUser`
(`server/provisioning.ts`):

1. Authorize through `can()` — super-admin, or an admin/owner of the target org
   (`actorOrgAdminOf`). Otherwise refused.
2. Resolve the org by id; build `email = <username>@<org.domain>`.
3. Recovery email must be **external** (`isServedDomain` guard).
4. Create the user (`role`, `recoveryEmail`, `mustChangePassword: true`), link a
   **random temp password**; on link failure the user is rolled back.
5. Insert the `member` row (org membership role `admin` or `member`).
6. Mail one invite to the **external recovery address**: login email + temp
   password + a recovery-verification link (the same `recovery-email:<token>`
   the verify route consumes).

The invited user then signs in with the temp password → the onboarding gate
forces **set password** + **verify recovery** (+ **secure account** for an
admin). See `provisionUser`'s `ponytail:` note on the emailed temp password.

Member management also exposes **pause** (`pauseUser` — sets `banned` and deletes
the user's `session` rows so access is cut immediately, not after the cache
window) and **remove** (`removeUser` — `deleteUser`, FK-cascades member/session/
account). Both re-check `can()` and refuse to act on yourself or a super-admin.

## Login Flow A — password + TOTP

1. Submit Doota email + password.
2. If the account has `twoFactorEnabled`, Better Auth returns
   `{ twoFactorRedirect: true }` instead of a session.
3. Submit the 6-digit TOTP code **or** a backup code → session issued.
4. TOTP is mandatory for `admin`/`superadmin` (via the secure-account onboarding
   step); optional for `member`.

## Login Flow B — passkey

1. Trigger passkey login → WebAuthn assertion → session.
2. **No TOTP step after a passkey.** A passkey is already two factors (device +
   biometric/PIN); stacking TOTP is redundant.
3. Passkey enrollment requires an existing session, so a new user logs in via
   Flow A first, then adds a passkey (onboarding secure-account card or
   `/account/security`).

## Forgot password → external recovery email (logged-OUT)

1. User enters their **Doota email** (never asked which recovery address).
2. `requestPasswordReset` always returns the same generic 200 — no enumeration.
3. Rate limited to 3 / 60 s.
4. `sendResetPassword` (override in `auth.ts`) sends the link **to the verified
   `recoveryEmail`, never `user.email`** (for a member), or the external primary
   for a super-admin, and only when the target is verified & external. The send
   is **backgrounded** (`waitUntil`) so a mail failure can't turn the generic 200
   into a 500 and mail latency can't be used to probe account existence.
5. The `/forgot-password` and `/reset-password` routes redirect authenticated
   users away — those are the logged-out flow only.

## Reset password — logged-OUT (token link)

- Link points at `/api/auth/reset-password/<token>` → redirects to the
  `/reset-password` page with `?token=` (or `?error=INVALID_TOKEN`).
- Token expires in 10 minutes; single-use.
- **Resets the password only.** `revokeSessionsOnPasswordReset` clears sessions
  but 2FA is untouched — a compromised recovery inbox must not equal a full 2FA
  bypass. Lost authenticator is recovered with **backup codes**, not this link.

## Change password — logged-IN (in-app dialog)

Authenticated users change their password through a popup, not the token flow
(`account/security` → `change-password-dialog.svelte`). It requires **both** an
emailed code **and** the current password:

1. `requestPasswordResetCode` (`reset-password.remote.ts` → `password-reset.ts`)
   mails a 6-digit code to the reset target (super-admin → external primary;
   others → verified recovery). Throttled 1 / 60 s; one active code per user
   (10-min TTL); reuses the `verification` table (`pwreset:<id>`).
2. `confirmPasswordReset` requires the code **and** `currentPassword`, then goes
   through `auth.api.changePassword({ revokeOtherSessions: true })` so the
   current password is actually proven before the change lands.

## Recovery email: set & verify

- `setRecoveryEmail` (`recovery-email.remote.ts`, requires a session):
  rejects served-domain addresses, sets `recoveryEmailVerified = false`, sends a
  confirm link. Throttled to **one email per user per minute**.
- `verify-recovery-email?token=` consumes the token (single-use, 1-hour expiry;
  24-hour for provisioning invites). A token is rejected if the user's
  `recoveryEmail` changed after it was issued (stale link), then flips
  `recoveryEmailVerified = true`.

## Escape hatches

1. **Backup codes** — the lost-authenticator path, generated at TOTP enrollment.
2. **In-app change-password dialog** — self-service, code + current password.
3. **Admin-initiated reset** for a member with no working recovery path — not
   yet built.
4. **CLI** — `pnpm reset-admin <email> <new-password> [--remote] [--clear-2fa]`
   resets a superadmin with **no email/network dependency**. See
   `scripts/reset-admin.mjs`.
