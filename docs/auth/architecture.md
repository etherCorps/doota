# Architecture

## Data model (Better Auth `user`, via `additionalFields`)

| Field | Type | Notes |
|-------|------|-------|
| `recoveryEmail` | `string \| null` | External address. Rejected at write time if it is on the Doota mail domain. |
| `recoveryEmailVerified` | `boolean` (default `false`) | `input: false` — cannot be set by a client, only by the verify flow. |
| `recoveryEmailVerifiedAt` | `number \| null` | `input: false`. |
| `role` | `string` | From the `admin` plugin: `member` \| `admin` \| `superadmin`. |

Recovery-email verification **reuses the existing `verification` table** with a
namespaced identifier `recovery-email:<token>` — no new table. Setting or
changing `recoveryEmail` flips `recoveryEmailVerified` back to `false` (enforced
in the `databaseHooks.user.update.before` hook) and sends a fresh confirm link.

## Roles

`member` (default) · `admin` · `superadmin`. Defined through the `admin`
plugin's access-control API in `auth.ts` (`createAccessControl` + `roles`).

- **First user on a fresh deployment → `superadmin`**, set in
  `databaseHooks.user.create.before` (`db.$count(user) === 0`).
- Subsequent users default to `member` (`admin({ defaultRole: "member" })`).
- **Sending is a mailbox capability, not a role.** `superadmin` can read/manage
  everything but is *not* granted send-as-others. See `can()` below.

## Authorization: `can()`

`src/lib/server/can.ts` is the single chokepoint. Every permission decision
should route through it so there is one place to audit and log.

```
can(user, action, target):
  1. superadmin AND action !== 'send'        → allow
  2. action === 'send' AND owns/granted       → allow
  3. (team-admin over owner's team)            → TODO, marked ponytail:
  4. owner of the target                       → allow
  else                                         → deny
```

Teams are not built yet; the team-scoped branch is a marked stub. `can()` is
currently defined but **not yet wired into routes** — that wiring is outstanding
work (see the scope gaps in [security-decisions.md](security-decisions.md)).

## Plugins (`auth.ts`)

`admin` (roles) · `lastLoginMethod` · `twoFactor` (TOTP + backup codes) ·
`passkey` (WebAuthn) · `sveltekitCookies` (**must be last**). The original
`magicLink` plugin was removed — an emailed login code to the Doota address is
the exact circular problem this design forbids.

## The auth singleton

`createAuth(db)` memoises the Better Auth instance at module scope
(`auth ??= buildAuth(db)`). On a warm Worker isolate this reuses the **first
request's** D1 binding for later requests. Stable in practice on D1, but a known
sharp edge — see item 6 in [security-decisions.md](security-decisions.md).

## Environment

| Var | Public | Purpose |
|-----|--------|---------|
| `BETTER_AUTH_SECRET` | no | Session/token signing. |
| `ORIGIN` | yes | Base URL. **Must match the dev server's port** or `/api/auth/*` 404s (Better Auth's `svelteKitHandler` gates on request origin). |
| `MAIL_DOMAIN` | yes | The Doota mail domain; drives `isDootaAddress()`. |
