# Deploying Doota

This folder is the deployment tooling for the whole project. It describes the
three Workers Doota runs on and everything they need — databases, queues,
storage, secrets — as one [Alchemy](https://alchemy.run) stack, so you can go
from a fresh clone to a running mail server with two commands.

If you just want to deploy, read [Your first deploy](#your-first-deploy) and
stop there. The rest explains how it behaves and how to operate it over time.

## What gets deployed

Doota is three Cloudflare Workers sharing one set of resources:

| Worker | What it does |
| --- | --- |
| `doota` (web) | The SvelteKit app — UI, API, auth |
| `doota-mail-inbound` (mail-in) | Receives email (Email Routing catch-all) and consumes the inbound queue |
| `doota-mail-jobs` (mail-jobs) | Sends email (outbound queue consumer), runs the 5-minute cron sweep, hosts the `MailEventHub` Durable Object |

Shared between them: a D1 database, a KV namespace (auth/session cache), an R2
bucket (raw mail, encrypted), three queues (inbound / outbound / delivery
events), and the Cloudflare Email Service sender binding.

You don't create any of this by hand. The stack (`alchemy.run.ts`) declares
all of it; deploying reconciles reality against the declaration and only
touches what changed.

Files in this folder:

| File | Role |
| --- | --- |
| `alchemy.run.ts` | The stack — resources, workers, bindings, outputs |
| `env.ts` | Reads `infra/.env`, validates the VAPID pair, turns `ORIGINS` into custom domains |
| `secrets.ts` | Mint-once secret machinery (see [Secrets](#secrets-you-probably-dont-need-to-set-any)) |
| `.env.example` | Documented template for your local `infra/.env` |

## Prerequisites

- A Cloudflare account (free tier works; Email Routing needs a zone on it
  eventually, but not for a test deploy).
- Node ≥ 22.18 and pnpm. Older Node 22.x also works — the scripts in this
  package add the `--experimental-strip-types` flag alchemy needs there.
- `pnpm install` run at the repo root AND in this folder (`pnpm -C infra install` — standalone lockfile).

## Your first deploy

From the repo root:

```sh
cd infra
pnpm alchemy login    # opens the browser, sign in to Cloudflare; saved to ~/.alchemy
cd ..
pnpm infra:deploy     # builds the web app, then deploys the stack
```

The only value you must invent first is `SETUP_TOKEN` (min 8 chars — it's how
you'll create the first admin at `/setup`): put it in `infra/.env`. Every
other secret mints itself — see
[Secrets](#secrets-you-probably-dont-need-to-set-any). When the deploy
finishes it prints the stack outputs; `webUrl` is your running app:

```
webUrl: https://doota-dev-yourname.your-account.workers.dev
```

Your deploy landed on **your own stage** (more below), with its own empty
database — the full schema is applied automatically during the deploy. Open
`<webUrl>/setup` with your `SETUP_TOKEN` to create the first admin.

To preview what a deploy *would* do without changing anything:

```sh
pnpm infra:plan
```

## Stages: why your deploy can't break anything

Every deploy targets a **stage**. Unless you say otherwise, that's
`dev_<your-username>` — and on EVERY stage, every physical resource name
gets the stage as a suffix: the worker is `doota-dev-yourname`, the bucket
`doota-mail-raw-dev-yourname`, and so on, each with its own empty
D1/KV/R2/queues. Two developers deploy at the same time and never collide,
and the stack is structurally incapable of touching anything deployed
manually under the bare names (`doota`, `doota-mail-inbound`, …) — those
belong to the wrangler flow and stay untouched forever.

The production instance is just a stage named `prod` (`doota-prod`, …) —
it's what CI deploys.

```sh
pnpm -C infra run plan                       # preview, your stage
pnpm -C infra run deploy -- --stage staging  # a named shared stage
pnpm -C infra run deploy -- --stage prod     # the production stage (CI does this)
pnpm -C infra run destroy -- --stage <name>  # tear a stage down
```

Never deploy `--stage production` — the stack hard-rejects it. That retired
stage's state (from an early bare-name deploy) claims the manually-managed
bare workers, and reusing it would rename/delete them.

## Secrets: you probably don't need to set any

The app needs several secrets (a content-encryption key, an HMAC key, an auth
signing secret, a web-push keypair). The stack follows one rule for all of
them:

> **If you provide a value, it's used and never touched. If you don't, one is
> minted on the first deploy and stored in the stack's state store — and every
> later deploy, from your machine or from CI, reuses that exact value.**

So a fresh deployment genuinely needs zero secret setup. Nothing is written
to disk; the state store (in Cloudflare) is the source of truth. Each deploy
prints a `secretSources` output telling you, per secret, whether the bound
value came from `env` or `state`.

What's minted vs. what you must provide:

| Variable | If you don't set it |
| --- | --- |
| `MAIL_DEK` | Minted. Encrypts **all stored mail** — losing the stack state loses the mail. Don't destroy a stage whose mail you care about |
| `MAIL_SEARCH_KEY` | Minted (search/token HMAC key) |
| `BETTER_AUTH_SECRET` | Minted (session signing) |
| `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` | Minted **as a pair** (it's a real P-256 keypair — providing only one half is an error) |
| `SETUP_TOKEN` | **Deploy fails.** Required from the deployer (min 8 chars) — you must know it to open `/setup` and create the first admin |
| `CRON_SECRET`, `APP_CLOUDFLARE_ACCOUNT_ID`, `APP_CLOUDFLARE_API_TOKEN` | Not minted — the features that use them stay off |

Why the two mail keys are special: mail content is encrypted under
`MAIL_DEK`. Whatever key the first deploy establishes, all later deploys must
keep — a different key makes existing mail unreadable. That's exactly what
the mint-once rule guarantees, and why **overriding a secret after data
exists under the minted one is a destructive act**. The stack warns loudly if
a production deploy is about to bind a minted `MAIL_DEK`.

## Configuration (env vars)

Config, unlike secrets, is **re-read from the environment on every deploy**:
change a value → the next deploy rebinds it; remove it → the binding is
removed.

Where to put values:

- **Locally**: `cp .env.example .env` in this folder (gitignored), fill in
  what you need. Shell-exported vars override the file.
- **CI**: GitHub repository secrets/variables — see [CI](#ci-auto-deploy-from-github).

**Required from the deployer** — the stack deploys without these, but each
absence disables something essential; set all four for a working mail
instance: `ORIGINS`, `SETUP_TOKEN`, `APP_CLOUDFLARE_ACCOUNT_ID`,
`APP_CLOUDFLARE_API_TOKEN`.

- **`ORIGINS`** — the app's serving origins: comma-separated **full URLs
  with protocol**. The first entry is the canonical app URL; every entry is
  attached to the web Worker as a Cloudflare custom domain (zones must
  already exist in your account) and trusted by auth as an allowed host.
  Example: `ORIGINS=https://mail.example.com, https://mail.other.org`.
  Leave it unset and the app serves on workers.dev, deriving its URL from
  the worker's own address automatically.
- **`SETUP_TOKEN`** — gate for the one-time `/setup` genesis wizard. Pick any
  string, deploy, open `<webUrl>/setup`, present the token.
- **`APP_CLOUDFLARE_ACCOUNT_ID` / `APP_CLOUDFLARE_API_TOKEN`** — the app's
  *runtime* Cloudflare token. See [Two Cloudflare tokens](#two-cloudflare-tokens).
- **`UNSUBSCRIBE_URL`**, **`LOG_LEVEL`** — see `.env.example`.

Things you never configure because the stack wires them: worker names
(e.g. the web app learns the mail-in worker's name via `MAIL_IN_WORKER_NAME`,
injected from the deployed resource itself), all queue/DO/bucket bindings,
and D1 migrations — pending files in `../drizzle` are applied on every
deploy, including the very first one on a fresh stage. Authoring migrations
stays a dev-time step (`pnpm db:generate` at the root); deploys only execute
committed `.sql` files, never generate schema.

## Two Cloudflare tokens

Doota needs two **different** API tokens, because deploying the system and
running it require different powers. Never reuse one for the other, and never
use the Global API Key for either.

1. **Deploy token — `CLOUDFLARE_API_TOKEN`** (CI secret / your OAuth login
   locally). Used only at deploy time by Alchemy to create and update
   workers, database, storage, and queues. Permissions in
   [CI](#ci-auto-deploy-from-github) below. It never reaches the running app.

2. **App runtime token — `APP_CLOUDFLARE_API_TOKEN`** (worker secret, set via
   this stack's env). Used by the *running web app* when an org onboards a
   mail domain: it creates/looks up zones, writes DNS records (verification
   TXT, routing MX/SPF), enables Email Routing and its catch-all, and
   registers the Email Sending subdomain. Because it onboards domains that
   don't exist yet at token-creation time, it needs **account-wide zone
   scope** ("All zones"), with:
   - Account → **Zone: Edit** (the app can create zones for new domains)
   - All zones → **Zone: Read**, **DNS: Edit**, **Email Routing Rules: Edit**
   - Plus the Email Sending permission group for the sending-subdomain API
     (dashboard label varies — currently under Email Service/Sending)

   Leave it unset and the app still runs — domain onboarding is simply
   disabled until you add it.

## CI: auto-deploy from GitHub

`.github/workflows/deploy.yml` deploys `--stage production` on every push to
`main` (a merged PR is a push to main). To enable it on your fork/repo, set
two repository **secrets**:

- `CLOUDFLARE_API_TOKEN` — a custom scoped token (create at dash.cloudflare.com
  → My Profile → API Tokens). Account permissions: **Workers Scripts: Edit,
  D1: Edit, Workers KV Storage: Edit, Workers R2 Storage: Edit, Queues: Edit,
  Secrets Store: Edit** (Alchemy's state store encrypts through it),
  **Account Settings: Read**. Plus, for each zone used in `ORIGINS`:
  **Workers Routes: Edit, DNS: Edit, Zone: Read** (skip if workers.dev-only).
- `CLOUDFLARE_ACCOUNT_ID` — your account id

No `alchemy login` in CI: GitHub Actions sets `CI`, which switches alchemy to
these environment-variable credentials.

Optionally add the config/secret variables from the sections above (as repo
secrets or variables — the workflow forwards them). Anything you leave unset
follows the same rules as local deploys: minted once into state, or
feature-off.

CI has no `.env` file and needs none — the state store is what makes the
minted secrets stable across runs.

There's also a manual trigger (Actions → Deploy → Run workflow) with an
**adopt** checkbox, used only for the scenario below.

## Coexisting with a wrangler deployment

An existing wrangler-managed deployment (bare names: `doota`,
`doota-mail-inbound`, `doota-mail-jobs`, D1 `doota`, bucket
`doota-mail-raw`, …) lives alongside the stack untouched — every stack
stage uses suffixed names, so the two can never collide. Migrating an
instance's DATA from the wrangler deployment onto a stage is a manual
export/import (D1 export/import + R2 object copy, with the live secrets
provided via env so the imported data stays decryptable); the stack
deliberately has no adopt-the-bare-names path.

## What this stack deliberately does NOT manage

- **Email Routing rules and the catch-all** — the *app* owns these at
  runtime: when an org adds a mail domain, the app wires the zone's routing
  through the Cloudflare API (that's what `APP_CLOUDFLARE_API_TOKEN` is for).
- **DNS zones** — a zone must already exist in the account before its
  hostname can be used in `ORIGINS`.
- **Email Service event subscriptions** (delivery/bounce events into the
  `doota-mail-events` queue) — configured once in the Cloudflare dashboard.

## Troubleshooting

- **`AuthError: No credentials configured`** — run `pnpm alchemy login` in
  this folder (or in CI, check the two repository secrets).
- **`Unknown file extension ".ts"`** — your Node is older than 22.18 *and*
  you invoked `alchemy` directly instead of via the pnpm scripts (which add
  the type-stripping flag).
- **Auth routes 404 after deploy** — the URL you're visiting must be in the
  app's `ORIGINS`. If you front the worker with another host, add that origin
  to `ORIGINS` (full URL, with protocol).
- **Deploy fails on a queue consumer** — a queue allows exactly one Worker
  consumer; if the queue already has one from another script, the deploy
  fails rather than silently stealing it.
- **Wrong/renamed stage cleanup** — `pnpm --filter @doota/infra destroy
  --stage <name>` removes that stage's resources. Never run it against
  `production`.
