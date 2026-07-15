# Flows

## Bootstrap: first admin

`create-admin` (route + `create-admin.remote.ts`) exists only for the very first
account. It refuses once any user exists (`db.$count(user) > 0`).

1. Validate: recovery email must be external (`isDootaAddress` guard, and the
   create hook re-checks).
2. `internalAdapter.createUser(...)` — the create hook makes this first user
   `superadmin`.
3. `internalAdapter.linkAccount(...)` sets the hashed password on a `credential`
   account. **If linking fails, the just-created user is deleted** so the
   `userCount` guard can't wedge the bootstrap on retry.
4. Send the recovery-email verification link.

Later accounts are meant to be created by an authenticated admin (that flow is
not built yet — see scope gaps).

## Login Flow A — password + TOTP

1. Submit Doota email + password.
2. If the account has `twoFactorEnabled`, Better Auth returns
   `{ twoFactorRedirect: true }` instead of a session.
3. Submit the 6-digit TOTP code **or** a backup code → session issued.
4. TOTP is mandatory for `admin`/`superadmin` (enforced in `hooks.server.ts`);
   optional for `member`.

## Login Flow B — passkey

1. Trigger passkey login → WebAuthn assertion → session.
2. **No TOTP step after a passkey.** A passkey is already two factors (device +
   biometric/PIN); stacking TOTP is redundant.
3. Passkey enrollment requires an existing session, so a new user logs in via
   Flow A first, then adds a passkey on `/account/security`.

## Enrollment enforcement (`hooks.server.ts`)

For `admin`/`superadmin` on any non-`/api/auth`, non-`/account/security` path,
the hook checks — **reading `twoFactorEnabled` fresh from D1, not from the
cached session** — whether the user has TOTP or at least one passkey. If neither,
it redirects to `/account/security`. Reading fresh avoids a redirect loop caused
by the 5-minute session cookie cache still reporting a just-enrolled admin as
unprotected.

## Forgot password → external recovery email

1. User enters their **Doota email** (never asked which recovery address).
2. `requestPasswordReset` always returns the same generic 200 —
   *"If this email exists… check your email for the reset link"* — regardless of
   whether the account exists or the recovery email is verified. No enumeration.
3. Rate limited to 3 / 60 s.
4. `sendResetPassword` (override in `auth.ts`) sends the link **to the verified
   `recoveryEmail`, never `user.email`**, and only when
   `recoveryEmailVerified === true`. The send is **backgrounded** (`waitUntil`)
   so a mail failure can't turn the generic 200 into a 500 and mail latency
   can't be used to probe account existence.

## Reset password

- Link points at `/api/auth/reset-password/<token>` → redirects to the
  `/reset-password` page with `?token=` (or `?error=INVALID_TOKEN`).
- Token expires in 10 minutes; single-use.
- **Resets the password only.** `revokeSessionsOnPasswordReset` clears sessions
  but 2FA is untouched — a compromised recovery inbox must not equal a full 2FA
  bypass. Lost authenticator is recovered with **backup codes**, not this link.
- Password length (8–128) is enforced server-side by Better Auth and mirrored in
  the client zod schema.

## Recovery email: set & verify

- `setRecoveryEmail` (`recovery-email.remote.ts`, requires a session):
  rejects Doota-domain addresses, sets `recoveryEmailVerified = false`, sends a
  confirm link. Throttled to **one email per user per minute** (the Better Auth
  rate limiter only covers its own endpoints, so this throttle is implemented
  here against the `verification` table).
- `verify-recovery-email?token=` consumes the token (single-use, 1-hour expiry).
  A token is rejected if the user's `recoveryEmail` changed after it was issued
  (stale link), then flips `recoveryEmailVerified = true`.

## Escape hatches (all three exist)

1. **Backup codes** — the lost-authenticator path, generated at TOTP enrollment.
2. **Admin-initiated reset** — planned, not yet built.
3. **CLI** — `pnpm reset-admin <email> <new-password> [--remote] [--clear-2fa]`
   resets a superadmin with **no email/network dependency** (the mail system
   being down is exactly when the superadmin is locked out). See
   `scripts/reset-admin.mjs`.
