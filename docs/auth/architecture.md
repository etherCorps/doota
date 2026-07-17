# Architecture

## Data model (Better Auth `user`, via `additionalFields`)

| Field | Type | Notes |
|-------|------|-------|
| `recoveryEmail` | `string \| null` | External address. Rejected at write time if it is on any served domain. |
| `recoveryEmailVerified` | `boolean` (default `false`) | `input: false` — cannot be set by a client, only by the verify flow. |
| `recoveryEmailVerifiedAt` | `number \| null` | `input: false`. |
| `mustChangePassword` | `boolean` (default `false`) | `input: false`. Set when an admin provisions the account with a temp password; forces the set-password onboarding step. Cleared on change. |
| `onboardedAt` | `number \| null` | `input: false`. Stamped once every onboarding step is done; used as the request-hook fast path. |
| `role` | `string` | From the `admin` plugin: `member` \| `admin` \| `superadmin`. |

Recovery-email verification and the login-time password-reset code both **reuse
the existing `verification` table** with namespaced identifiers
(`recovery-email:<token>`, `pwreset:<id>`, `pwreset-throttle:<id>`) — no new
table. Setting or changing `recoveryEmail` flips `recoveryEmailVerified` back to
`false` (enforced in `databaseHooks.user.update.before`) and sends a fresh
confirm link.

## Organizations (org == domain)

The `organization` plugin models **one organization per mail domain**
(`organization.domain`, unique). Membership lives in the `member` table
(`organizationId`, `userId`, org role `owner` \| `admin` \| `member`).

- Only a `superadmin` may create orgs (`allowUserToCreateOrganization`); they
  become the org **owner** (`creatorRole: "owner"`).
- `server/org-domains.ts` is the single source of truth for "which domains does
  this deployment serve", a module-scoped cache (30 s TTL + explicit invalidate
  on org create/update/delete). `isServedDomain()` / `orgForDomain()` drive
  login-domain validation, recovery-address rejection, and (future) inbound
  routing.
- **Cloudflare is the source of truth for mail wiring.** D1 stores only the
  `domain`, `zoneId`, the org mapping and a `status` enum (`pending_zone |
  pending_nameservers | wiring | active | error`). DNS records, routing rules,
  Email Routing state and DKIM status are **never persisted** — fetched live from
  the CF API for admin/settings screens only. `server/cloudflare.ts` is the ONLY
  caller of that API and is never invoked on the inbound-mail hot path or login
  validation (those read the cached `domain→org→zone` map).
- Domain onboarding (`domains.remote.ts`) is **super-admin only** and the only
  writer of CF state: idempotent `zoneCreate` / `pollZoneStatus` / `wireMail`
  (enable routing, MX+SPF, DKIM/DMARC/cf-bounce, catch-all → mail-in Worker).

## Onboarding state (`server/onboarding.ts`)

`getOnboardingStatus(db, user)` is the single derivation of remaining steps,
consumed by both the request hook (the gate) and the `/onboarding` load (client
checklist via `locals.onboarding`). `markOnboarded` stamps `onboardedAt`;
`onboardingHome(role)` sends `superadmin` → `/admin`, everyone else → `/app`.
See [flows.md](flows.md#onboarding-gate-hooksserverts--onboardingts).

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
  1. action === 'send' AND owns/granted        → allow   (send is a mailbox
                                                           capability, not a role)
  2. superadmin (any read/manage)              → allow
  3. org-admin over target's organizationId    → allow   (actor.orgAdminOf)
  4. owner of the target                       → allow
  else                                         → deny
```

`can()` is a **pure decision function** — the caller resolves the facts
(`actorOrgAdminOf(db, userId)` for the actor's owner/admin org memberships, the
target's org) and passes them in, keeping this the one auditable place with no
hidden I/O. It is wired into the provisioning path (`provisionUser`,
`pauseUser`, `removeUser` in `manage-users.remote.ts`); other auth-gated routes
still rely on role/redirect guards.

## Plugins (`auth.ts`)

`admin` (roles) · `organization` (org == domain) · `multiSession` (switching
accounts across domains) · `lastLoginMethod` · `twoFactor` (TOTP + backup codes)
· `passkey` (WebAuthn) · `sveltekitCookies` (**must be last**). The original
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
| `MAIL_DOMAIN` | yes | The system no-reply domain; part of `isServedDomain()` alongside registered org domains. |
| `SETUP_TOKEN` | no | One-time gate for the `/setup` genesis wizard. Unset → web wizard disabled (use the CLI). |
| `CF_ACCOUNT_ID` | no | Cloudflare account id for domain onboarding. |
| `CF_API_TOKEN` | no | Cloudflare **scoped API Token** (Bearer). NOT the Global API Key; no account email. Treat like the encryption DEK — Worker secret only. |
| `MAIL_IN_WORKER_NAME` | no | Name of the deployed mail-in Worker the catch-all routing rule targets. |
