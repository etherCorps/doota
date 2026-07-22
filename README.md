<div align="center">

# Doota

**Your email, finally yours.**

An email app you run yourself — where every conversation reads like a chat, on
your own address, on infrastructure only you control.

`Coming soon · building in the open`

</div>

---

## What is Doota?

Doota (say _DOO-tah_ — it means **messenger**) is a self-hosted email app that
runs entirely on your own [Cloudflare](https://cloudflare.com) account. No mail
server to babysit, no company sitting in the middle of your inbox. Mail arrives
through Cloudflare Email Routing, gets threaded into a WhatsApp-style
conversation, and is stored encrypted — with the raw message always kept whole
as the source of truth.

It still speaks plain email underneath, so you can write to anyone on Gmail or
Outlook, and they can write back.

## Features

- **Threads, not folders** — every conversation is one simple timeline of
  messages, interoperable with any mail client.
- **Runs on your own account** — Cloudflare Workers, D1, R2, KV, and Queues do
  the work. One deployment, one operator.
- **Private by default** — subjects and bodies encrypted at rest; routing
  metadata stays queryable so threading works without decryption.
- **Undo & scheduled send** — a first-class submission object tracks every
  message (queued → sent → delivered → bounced), with delivery ticks and
  send-later.
- **Hide-my-email aliases** — generate throwaway addresses on your domain, map
  them to a mailbox, disable them anytime.
- **Passwords or passkeys** — WebAuthn sign-in out of the box.
- **Open source, end to end** — read it, run it, change it. No subscriptions,
  no per-seat pricing, no lock-in.

## Tech stack

| Layer    | Choice                                                                    |
| -------- | ------------------------------------------------------------------------- |
| Frontend | [SvelteKit](https://svelte.dev) + [Tailwind CSS](https://tailwindcss.com) |
| Runtime  | Cloudflare Workers (`@sveltejs/adapter-cloudflare`)                        |
| Storage  | D1 (SQLite) · R2 (raw messages) · KV (cache) · Queues (mail-out)           |
| Mail     | Cloudflare Email Routing (inbound) + provider seam (outbound)             |
| Auth     | [better-auth](https://better-auth.com) with passkeys                      |
| Data     | [Drizzle ORM](https://orm.drizzle.team) + drizzle-kit migrations          |

## Getting started

Requires Node 22+, [pnpm](https://pnpm.io), and a Cloudflare account.

```sh
pnpm install
cp .env.example .env      # then fill in the values (see below)
pnpm db:migrate:local     # apply D1 migrations to the local database
pnpm dev                  # http://localhost:5173
```

Create the first admin (genesis) with the CLI:

```sh
pnpm reset-admin
```

### Environment

See `.env.example` for the full list. The essentials:

- `ORIGIN` — your app's URL (must match the dev port, or auth routes 404).
- `BETTER_AUTH_SECRET` — 32+ chars, high entropy.
- `APP_CLOUDFLARE_ACCOUNT_ID` / `APP_CLOUDFLARE_API_TOKEN` — a **scoped** API
  token (not the Global API Key), stored as a Worker secret in production.
- `MAIL_IN_WORKER_NAME` — the deployed mail-in Worker the catch-all rule targets.
- `LOG_LEVEL` — optional mail-pipeline log level (`debug`/`info`/`warn`/`error`,
  default `info`); set per Worker (web, mail-in, mail-jobs) as a plain var.

### Deploy

```sh
pnpm db:migrate:remote    # migrate the production D1 database
pnpm deploy               # build + wrangler deploy
```

## Repository layout

- `src/` — the Doota app (SvelteKit + Workers).
- `drizzle/` — database migrations.
- `landing/` — the standalone marketing site (its own SvelteKit project; `pnpm --dir landing dev`).

## Useful scripts

| Script             | Does                                      |
| ------------------ | ----------------------------------------- |
| `pnpm check`       | auth-boundary check + `svelte-check`      |
| `pnpm test`        | run the Vitest suite                      |
| `pnpm db:studio`   | open Drizzle Studio                       |
| `pnpm auth:schema` | regenerate the better-auth Drizzle schema |
| `pnpm gen`         | regenerate Cloudflare binding types       |

## Status

Doota is under development and moving fast. Star the repo to follow along until launch.

## License & credits

An independent open-source project by **[Ethercorps](https://github.com/ethercorps)**.

Not affiliated with, endorsed by, or sponsored by Cloudflare. Cloudflare,
Workers, R2, and D1 are trademarks of Cloudflare, Inc.

© 2026 Ethercorps
