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
5. **Never send login codes or reset links to a served-domain address.**
   Enforced by `isServedDomain()` (every registered org domain) at every write
   and send point. Outbound mail always originates from an onboarded active
   domain (`senderAddress()`); there is no system fallback domain.
6. **No TOTP step after a passkey login.**
7. **The in-app password change requires code *and* current password.** The
   authenticated dialog (`reset-password.remote.ts`) proves both a mailed code
   and the current password via `changePassword` before the change lands —
   neither alone is enough.
8. **Provisioned accounts get a temp password + `mustChangePassword`.** The
   onboarding gate forces the reset before the account can do anything, so the
   emailed temp value never survives onboarding. (`ponytail:` note in
   `provisionUser` — swap for a set-password magic link if plaintext-in-mail is
   ever unacceptable.)
9. **Super-admin genesis is email-free; the trust root is deploy access.** At
   genesis no domain is onboarded, so no mail can be delivered (the bootstrap
   paradox). The super-admin is created with an **unverified** external email and
   **no mail is sent**. Genesis is gated by possession of instance secrets: the
   CLI (`reset-admin`) or the `/setup` wizard's one-time `SETUP_TOKEN` — both
   also require `userCount === 0` and lock out afterward. Never reintroduce an
   email step into genesis.
10. **Super-admin email verification is deferred and its reset is gated on it.**
    Recovery must never depend on an unverified/undeliverable path: the CLI is
    the floor. `sendResetPassword` only targets the super-admin's `user.email`
    once `emailVerified` is true, and the verify action itself is only offered
    after a domain is `active` (a working sending path exists).
11. **Cloudflare credential is a scoped API Token; CF is never on the hot path.**
    `APP_CLOUDFLARE_ACCOUNT_ID` + `APP_CLOUDFLARE_API_TOKEN` (Bearer, not the Global API Key, no account
    email), stored as a Worker secret like the encryption DEK. The CF API is
    called ONLY from `server/cloudflare.ts` during super-admin domain onboarding
    — never on inbound mail or login, which read the cached domain→org→zone map.
    Every CF write is idempotent (check-then-create / tolerate "already exists").

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

3. **Genesis orphan on partial failure** (`setup.remote.ts`). If `createUser` succeeded but
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

- **Admin-initiated reset** for a member with no working recovery path.
- **`can()` wired into every auth-gated route** — it now gates provisioning
  (`provisionUser`, `pauseUser`, `removeUser`); other routes still use
  role/redirect guards.

### Now built (previously gaps)

- **Admin-create-member/admin** — org-centric provisioning + invite mail
  (`server/provisioning.ts`, `manage-users.remote.ts`,
  `/admin/organizations/[orgId]`).
- **Verified recovery / primary email required to be "fully active"** — enforced
  by the onboarding gate (`hooks.server.ts` + `server/onboarding.ts`), which also
  requires 2FA/passkey for elevated roles and a password change for provisioned
  accounts before any route is reachable.
- **Self-service authenticated password change** — the code + current-password
  dialog (`reset-password.remote.ts`, `server/password-reset.ts`).
