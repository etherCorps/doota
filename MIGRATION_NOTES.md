# Auth boundary migration

Eliminates Better Auth internal-adapter / `$context` sprawl behind a single
boundary. App code no longer touches Better Auth internals or writes Better
Auth-owned tables directly.

## Boundary module — `src/lib/server/auth/`

- **`escape-hatches.ts`** — the ONLY place allowed to use `$context` /
  `internalAdapter` or write auth-owned tables. Every function documents why the
  sanctioned paths (`auth.api` / `databaseHooks`) can't express it.
- **`repository.ts`** — reads that touch auth tables (currently
  `getUserForRecovery`; grows as read sites relocate).

Guard: `scripts/check-auth-boundary.mjs` (run in `pnpm check`) fails the build if
anything outside `src/lib/server/auth/` uses `$context`, `internalAdapter`, or a
direct `.insert/.update/.delete(schema.…)` auth-table write.

## What moved where

### Bucket 1 — escape hatches (writes with no `auth.api` path)

| Was | Now |
|-----|-----|
| `setup.remote.ts` genesis createUser/linkAccount/deleteUser | `createGenesisSuperadmin()` |
| `recovery-email.ts` / `.remote.ts` / `password-reset.ts` verification-table tokens, codes, throttles | `tokenStore.*` + `throttleAllows()` |
| `recovery-email.ts` `recoveryEmailVerified`, `onboarding.remote.ts` `mustChangePassword`, `onboarding.ts` `onboardedAt` | `setUserAuthFlags()` / `stampOnboarded()` |
| `domains.remote.ts` `setStatus` (org `status`/`zoneId`) | `setOrgLifecycle()` |

### Bucket 2 — `auth.api.*` mutations

| Was | Now |
|-----|-----|
| `provisioning.ts` `internalAdapter.createUser` + `linkAccount` (+ rollback) | `auth.api.createUser` (admin, atomic) |
| `provisioning.ts` `db.insert(member)` | `auth.api.addMember` |
| `manage-users.remote.ts` `db.update(user).banned` + `db.delete(session)` | `auth.api.banUser` + `auth.api.revokeUserSessions` |
| `manage-users.remote.ts` `internalAdapter.deleteUser` (+ manual session/member purge) | `auth.api.removeUser` (+ `purgeUserMemberships` escape hatch) |
| `recovery-email.remote.ts` `internalAdapter.updateUser(recoveryEmail)` | `auth.api.updateUser` (self; hook resets verified flags) |
| `domains.remote.ts` `db.update(org){name,logo}` | `auth.api.updateOrganization` |

## Escape hatches and why

- **`createGenesisSuperadmin`** — first-run: no admin session to authorize
  `admin.createUser`, and `disableSignUp` blocks `signUpEmail`. The
  `user.create` hook still forces role=superadmin.
- **`tokenStore` / `throttleAllows`** — Better Auth exposes no `auth.api` to mint
  arbitrary verification values; recovery links, pwreset codes, and send
  throttles reuse its `verification` table under namespaced identifiers.
- **`setUserAuthFlags` / `stampOnboarded`** — no `auth.api` to set custom
  `input:false` user flags by id (`recoveryEmailVerified`, `mustChangePassword`,
  `onboardedAt`). `stampOnboarded` takes `db` explicitly because it runs from
  `hooks.server` before a request event is retrievable.
- **`setOrgLifecycle`** — org `status`/`zoneId` are `input:false`, so
  `updateOrganization` refuses them.
- **`purgeUserMemberships`** — `admin.removeUser` doesn't cascade the org
  plugin's `member` table and D1 cascade is unreliable; `removeMember`'s
  id/email key is version-fragile, so delete-by-userId is the robust purge.

`scripts/reset-admin.mjs` (break-glass CLI) is a separate, intentional exception:
it runs outside the Worker runtime with no bindings, so it uses raw wrangler SQL
and cannot route through the boundary. Left as-is (the guaranteed recovery floor).

## Behavior differences found

- **F1 (fixed):** the old `setStatus` raw-updated `organization.status` without
  `invalidateDomainCache()` — the org plugin's `afterUpdateOrganization` hook was
  bypassed, so `isServedDomain`/`orgForDomain` caches stayed stale (up to the
  5-min TTL) after a domain went active. `setOrgLifecycle` now invalidates the
  cache, matching the hook. Behavior change = a fix; flagged, not silent.
- **F3 (benign double-check):** provisioning now creates users via
  `auth.api.createUser`, so `databaseHooks.user.create.before` fires — the
  served-domain recovery check runs there AND in provisioning's own up-front
  check. Redundant, harmless. The first-user→superadmin branch also runs but is
  never first here.
- **F2 (verify at runtime):** confirm `auth.api.removeUser` deletes
  `account`/`twoFactor`/`passkey` rows on D1 (member rows handled by
  `purgeUserMemberships`). Pending end-to-end check (see below).

## Pending

- **Bucket 3 — read relocation.** Auth-table *reads* (org/member/user/passkey
  joins in route `+page.server.ts` loads, `org-domains.ts`, `provisioning.ts`)
  still use Drizzle in place. The migration spec permits Drizzle for reads but
  prefers them confined to the repository layer. The enforced invariant (no
  writes / no internals outside the boundary) already holds; relocating reads is
  cosmetic and not yet done.
- **End-to-end verification** of: CLI genesis/reset-admin, `/setup` zero-user
  gate, pause-login (ban + session revoke), multiSession cross-domain switch,
  org creation during onboarding, and F2 above. Requires a running app + test
  superadmin (clean up test users from local D1 afterward).
