# Doota — Auth Handoff

Current auth specification. Reflects what is **built**, not aspiration. Read this before
touching anything auth-adjacent.

Stack: SvelteKit (Svelte 5 runes) · Cloudflare Workers · D1 + Drizzle · Better Auth ·
remote functions (`.remote.ts`) for RPC.

---

## 0. The shape of the system

One deployment = one operator = one Cloudflare account, serving one or more
operator-owned domains.

**organization = one domain** (`org.domain` unique). This is the central identity: mail
routing, address validation, sender resolution, and every `org_id` in the mail schema hang
off it.

**No self-signup.** Accounts are admin-provisioned only. There is no public registration
path, by design — this is a self-hosted instance, not a SaaS.

---

## 1. Better Auth configuration

Plugins in use:

| Plugin | Purpose |
|---|---|
| `emailAndPassword` | Primary credential login |
| `twoFactor` (+ backup codes) | TOTP stacked on password login |
| `passkey` | Alternative login path (no TOTP stacked) |
| `admin` | Instance-level roles, ban/unban, admin-initiated reset |
| `organization` | Org = domain; membership and per-org roles |
| `multiSession` | Switching between accounts on different domains |
| `apiKey` | Programmatic bearer keys (external send via mail-out) |
| `lastLoginMethod` | Surfacing the user's previous login path |
| `openAPI` | Generated API surface |

Tables: `user`, `account`, `session`, `verification`, `organization`, `member`,
`invitation`, `passkey`, `twoFactor`, `rate_limit`.

**Rate limiting** is DB-backed and applied to sign-in, password reset, and 2FA.

**Session cookie cache** is 5 minutes, with forced-fresh reads on `?verified=1` and on
onboarding completion — the two moments where stale session state would visibly break the
flow.

---

## 2. Two role axes (do not conflate them)

**Instance role** (admin plugin): `member | admin | superadmin`
**Org membership role** (organization plugin): `owner | admin | member`, per-org

A user has exactly one instance role and zero-or-more org memberships. Superadmin is an
instance role; ownership of a given org is a membership fact. Superadmin is the OWNER of
every org it creates.

**Superadmin** has an EXTERNAL email, no mailbox, and `/admin` only.

---

## 3. Authorization — the single chokepoint `can()`

Every permission check routes through `can()`. It is a pure decision function: auditable,
and it logs denials.

Rules:

- **`send` is a mailbox capability, NOT a role.** Only the mailbox owner or an explicitly
  granted sender may send as an address. **Even superadmin cannot send-as-others.**
- superadmin → read/manage everything.
- org-admin → read/manage within orgs they administer (`orgAdminOf`).

`can()` is kept **team-agnostic but team-ready**: grants are shaped so that a nullable team
scope becomes an additive migration rather than a resolver rewrite. Teams-as-grouping is
explicitly out of v1.

Do not create a parallel permission path. New capabilities (e.g. mailbox access grants)
resolve through the existing `can()`.

---

## 4. The served-domain invariant

**The central design constraint.** Mailbox users cannot read their own inbox until they are
logged in — so any credential flow that depends on delivering mail to a served domain is a
circular lockout.

Therefore:

- Recovery emails and the superadmin login email **must be external**. Addresses on any
  served domain are **rejected** for these purposes.
- Password reset target **branches by role**:
  - superadmin → verified primary email
  - member/admin → **verified** external recovery email
  - never the Doota inbox; never an unverified address
- A recovery-email verification flow exists with namespaced tokens
  (`verify-recovery-email` route).

The domain→org cache (`org-domains.ts`, 30s TTL + explicit invalidation) drives inbound
routing, login validation, sender-address resolution, **and** this rejection. Any change to
domains or routing subdomains must invalidate it.

---

## 5. Genesis — email-free by design

At first deploy, no domain is onboarded, so Email Routing and Email Sending do not exist.
There is no path to deliver a verification mail. **The trust root at genesis is deploy
access — possession of the instance secrets — not an email round-trip.** Someone who can
deploy the Worker and read its secrets is more strongly authenticated than someone who can
click a link in a Gmail.

Implementation:

- First user on a fresh deploy auto-becomes **external superadmin** via a `user.create`
  hook guarded by `$count(user) === 0`.
- A public `setup` route handles genesis; it is inert once a user exists.
- The CLI setup / `reset-admin` command is the **guaranteed floor** — it must work with no
  web layer and no mail. It is both the bootstrap and the recovery hatch.
- The superadmin's external email is stored **unverified** at genesis. No mail is sent.
- Email verification is **deferred**: auto-sent once a domain goes `active` and a sending
  path exists.

Escape hatches, in order: backup codes (lost 2FA) → admin-initiated reset → CLI
`reset-admin` (no email dependency).

**Encryption keys (DEK, SEARCH_KEY) stay decoupled from credentials.** A password reset
never touches key material.

---

## 6. Role-based onboarding gate (`onboarding.ts`)

Steps are derived, use fresh D1 reads, and gate everything until complete:

- **superadmin** → onboard a domain + secure account (2FA/passkey). Email verification is
  auto-sent once a domain becomes `active`.
- **admin** → verify recovery email + secure account (+ set password if temporary).
- **member** → verify recovery email (+ set password if temporary).

---

## 7. User provisioning (`provisioning.ts`)

Admin supplies the **local part only** — the org pins the domain. The domain must be
`active`.

Flow is atomic: `admin.createUser` → `addMember` → set `mustChangePassword` → email the
invite (temporary password + recovery-verify link) to the **external recovery address**.

> **Open reconciliation (mailbox task):** provisioning assigns each user a local part, so
> every user has an *implied* address. But a mailbox must be a separate entity from `user`,
> because shared mailboxes (`support@`) have many users and no single owner. Resolution:
> provisioning should create a **personal `mailbox` row + a `mailbox_access` grant**
> alongside the user. There must be exactly one source of truth for "what address is this
> person."

---

## 8. Login paths

- **A:** email + password → TOTP
- **B:** passkey (no TOTP stacked)

**Pause-login = `banUser` AND revoke live sessions.** Banning alone leaves an active
session working — both are required.

**multiSession** covers switching between accounts on different domains. Known quirks:
`maxSessions` off-by-one, and orphaned sessions on revoke.

**Superadmin "view all orgs"** is an aggregate query **gated by ownership**, not a
non-member override.

---

## 9. The auth boundary (post-refactor — binding)

Better Auth internal-adapter usage was refactored away. `internalAdapter` is undocumented
internal API, it **bypasses the `databaseHooks`/plugin pipeline** (so side effects silently
don't fire), and it bypasses `can()`.

All auth/user/org/permission access now goes through the boundary module
(`src/lib/server/auth/`). Three sanctioned paths:

1. **Auth mutations → `auth.api.*`** via the boundary. Runs the full hook pipeline; works
   without an HTTP context, including from the CLI.
2. **Cross-cutting side effects → `databaseHooks` or a small plugin.** Adapter access from
   `ctx` *inside* plugin/hook code is legitimate; app code doing it is the smell.
3. **Reads joining auth tables with app tables → Drizzle**, confined to repository
   functions inside the boundary.

**Rule: writes to Better Auth-owned tables go only through Better Auth. Reads may be
Drizzle, but only from the boundary.**

Anything genuinely unsupported becomes ONE named, commented, tested escape-hatch function
in the boundary — one audited exception instead of twenty invisible ones.

A lint guard (`no-restricted-imports`) blocks `$context`, `internalAdapter`, and auth-schema
imports outside `src/lib/server/auth/`. Do not weaken it.

---

## 10. Routes

- `(admin)` — dashboard, orgs list, per-org (members / DNS / subdomains / settings),
  oversight. superadmin/admin gated.
- `(app)` — member workspace + account security (2FA, passkey, sessions).
- `(onboarding)` — the gated flow.
- Public — login, forgot/reset password, `setup` (genesis), `verify-recovery-email`.

`/app` ↔ `/admin` is plain navigation, role-gated.

---

## 11. Standing invariants

1. Login and recovery addresses on any served domain are **rejected**, everywhere.
2. Encryption keys stay decoupled from credentials, and never live in D1.
3. The Cloudflare API is **never** called on the inbound hot path or on login validation —
   those read only the cached D1 domain→org map.
4. Pause-login means ban **and** session revocation.
5. Genesis never depends on mail.
6. D1 has no transactions — idempotency comes from unique indexes and upserts.
7. `send` is a capability, never a role.
