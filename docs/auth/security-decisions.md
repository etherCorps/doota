# Security decisions

## Invariants — do NOT "simplify" these

1. **`sendResetPassword` targets `recoveryEmail`, not `user.email`.** Better
   Auth's default sends to `user.email` — the Doota inbox the user can't reach.
   The override in `auth.ts` sends to the verified external `recoveryEmail`, or
   no-ops. This is the single most important line in the whole design.
2. **Reset scope = password only.** 2FA is never cleared or bypassed by the
   reset link. Lost authenticator → backup codes. Rationale: a compromised
   recovery inbox must not equal a full 2FA bypass.
3. **Encryption is decoupled from credentials.** At-rest encryption uses an
   instance key in a Worker secret — never derived from a password or session.
   Auth changes must never touch or re-derive an encryption key.
4. **Generic, rate-limited responses** on forgot-password and recovery lookups.
   Never reveal whether an account or recovery address exists.
5. **Never send login codes or reset links to an `@MAIL_DOMAIN` address.**
   Enforced by `isDootaAddress()` at every write and send point.
6. **No TOTP step after a passkey login.**

## Hardening applied

These were found in an audit of the flows and fixed.

### Fixed bugs

1. **Stale-session 2FA redirect loop.** The enrollment check in
   `hooks.server.ts` read `twoFactorEnabled` from the session, which the
   5-minute cookie cache kept stale — so a just-enrolled admin got bounced back
   to `/account/security` for up to 5 minutes. **Fix:** the hook now reads the
   flag fresh from D1 (alongside the passkey count it already queries).

2. **Reset-password 500 leak / timing side-channel.** Better Auth `await`s
   `sendResetPassword`; a mail failure would surface as a 500 (not the generic
   200), and mail latency differed per account state. **Fix:** the reset mail is
   sent in the background (`sendMailBackground` → `ctx.waitUntil`), so the
   endpoint returns immediately with a uniform response regardless of mail
   outcome. See `src/lib/server/mailer.ts`.

3. **create-admin orphan on partial failure.** If `createUser` succeeded but
   `linkAccount` failed, a passwordless superadmin was left behind and the
   `userCount` guard blocked all retries. **Fix:** on link failure the created
   user is deleted before returning the error.

### Hardening

4. **Timing side-channel (partial).** Backgrounding the reset mail (fix 2)
   removes the mail-latency signal. A small residual difference remains between
   "account not found" and "account found" because Better Auth's own code
   creates a reset token only for real accounts — that path is inside the
   library and not ours to change. Low severity.

5. **Rate limits.** `auth.ts` `rateLimit.customRules` now tightens:
   `/request-password-reset` (3/60 s), `/sign-in/email` (5/60 s),
   `/two-factor/*` (5/60 s — on top of Better Auth's own failed-attempt
   lockout). `setRecoveryEmail` is a remote function outside the Better Auth
   limiter, so it has its own per-user 1/minute throttle.

## Known sharp edges (accepted for now)

6. **`createAuth` singleton captures the first request's `db`.** Module-scoped
   memoisation reuses the first request's D1 binding on a warm isolate. Stable in
   practice on D1; revisit if binding staleness ever bites.

## Scope gaps (per the spec's Definition of Done — not yet built)

- **Admin-create-member** flow (only first-user bootstrap exists).
- **Admin-initiated reset** for a member with no working recovery path.
- **`can()` wired into every auth-gated route** — the helper exists but nothing
  calls it yet.
- **Require a verified recovery email before an admin/superadmin is "fully
  active"** — the hook enforces TOTP/passkey but not recovery-email verification.
