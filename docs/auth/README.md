# Doota authentication

Doota is self-hosted: **one deployment = one company = one mail domain**
(`user@domain.tld`). The fact that shapes the whole auth design:

> A user's login identity **is** their Doota mailbox, which they cannot read
> until they are logged in.

So any recovery that emails the Doota address is circular and forbidden.
Recovery goes to a **different, external** address.

## Stack

SvelteKit · Cloudflare Workers · D1 · Drizzle · Better Auth (`emailAndPassword`,
`twoFactor`, `passkey`, `admin`).

## Docs in this directory

| File | What it covers |
|------|----------------|
| [architecture.md](architecture.md) | Data model, roles, plugins, the singleton, key files |
| [flows.md](flows.md) | Login A/B, forgot/reset password, recovery-email set & verify, admin bootstrap |
| [security-decisions.md](security-decisions.md) | The invariants that must not be "simplified", and the hardening applied |
| [testing-and-cleanup.md](testing-and-cleanup.md) | How to test auth locally, and the **mandatory** post-test data cleanup |

## Map of the code

| Path | Role |
|------|------|
| `src/lib/server/auth.ts` | Better Auth config — the core. Recovery-email override, roles, hooks, rate limits |
| `src/hooks.server.ts` | Mounts auth, loads session, forces 2FA/passkey for admins |
| `src/lib/server/can.ts` | `can()` — the single authorization chokepoint |
| `src/lib/server/mailer.ts` | System mailer (`no-reply@domain`) + background send |
| `src/lib/server/recovery-email.ts` | Set / verify the external recovery email |
| `src/lib/rpc/create-admin.remote.ts` | First-user bootstrap |
| `src/lib/rpc/recovery-email.remote.ts` | Logged-in user sets their recovery email |
| `src/lib/client/auth-client.ts` | Better Auth browser client |
| `scripts/reset-admin.mjs` | Email-free superadmin recovery CLI (`pnpm reset-admin`) |
| Routes | `login/`, `forgot-password/`, `reset-password/`, `verify-recovery-email/`, `(app)/account/security/` |
