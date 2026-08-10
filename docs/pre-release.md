# Pre-release / deploy runbook (operator)

Operator track — the checklist to run **before** the first real-user release and
on every subsequent production deploy. The Cloudflare-Workers monorepo:
`apps/web`, `apps/mail-in`, `apps/mail-jobs` (deployed Workers), plus
`apps/landing` / `apps/docs` (static) and `apps/native` (the Tauri client, built
separately — not a Worker). Written 2026-08-02.

Two kinds of item live here:

- **One-time hardening** — done once before release, then it stays done.
- **Every-deploy** — part of the normal deploy sequence forever.

---

## 0. One-time hardening (before first release)

### 0.1 Remove the R2 plaintext-tolerance patch — **fail closed** — ✅ DONE

`unpackBlob` in `packages/mail-core/src/crypto.ts` is now **encrypted-only**: the
`if (blob[0] !== BLOB_V1) return blob` passthrough is gone, so any non-`BLOB_V1`
blob is rejected by `decryptBytes` (fail closed). A reader can no longer accept a
plaintext or attacker-swapped-to-plaintext blob — the zero-access-at-rest
guarantee holds. `crypto-blob.test.ts` now asserts a plaintext blob is *rejected*.

**Operator step that MUST accompany this:** any blob written before at-rest
encryption is now unreadable. Either launch fresh (wipe R2 content prefixes
`raw/`, `attachments/`, `outbound/`, body-cache) or run the re-encrypt backfill
BEFORE deploying this build. On the doota staging stack the pre-encryption test
messages will 500 on open until wiped/re-encrypted — expected.

### 0.2 Accepted gap — draft-staged attachments are stored raw in R2

**Decision (2026-08-08): accept, do NOT treat as a release-blocker.** Draft-staged
attachments stay plaintext (raw) in R2 while a draft is open. It is transient
(deleted when the draft closes), re-encrypted the moment the draft hits outbound
(`copyToOutbound`), and off the hot path. The only remaining obligation is the
claim caveat below — the encryption-at-rest wording must footnote drafts.

<details><summary>Original blocker framing (superseded)</summary>

Encrypted-at-rest today: inbound RFC822 raw, outbound JSON body, staged inbound
attachments, **API-send attachments** (`resolveApiAttachments` → `putEncryptedBlob`).
**Not** encrypted: **draft-staged attachments** (a file attached while composing,
before send). It is transient (lives only while the draft is open), re-encrypted
the moment the draft hits outbound (`copyToOutbound` encrypts), and off the hot
path — but it is the **last plaintext content path**.

Do **not** ship the flat claim "all mail content is encrypted at rest" while this
gap exists — either close it (encrypt `stageDraftAttachment`, decrypt in
`readDraftAttachment`, thread the `ck`) or footnote the claim.

</details>

### 0.3 Secrets & vars present in every environment

Encrypted secrets survive deploys (unlike plaintext dashboard vars). Set once per
Worker env that needs them.

**Secrets** (`wrangler secret put <NAME> --env <env>` per Worker):

| Secret | Used by | Purpose |
| --- | --- | --- |
| `MAIL_DEK` | web, mail-in, mail-jobs | AES-256-GCM data-encryption key for content + R2 blobs (`importKey`). **Losing it = all stored mail is unreadable — back it up out-of-band.** |
| `MAIL_SEARCH_KEY` | web, mail-in, mail-jobs | HMAC key for blind search tokens **and** signed resource/image tokens. |
| `VAPID_PRIVATE_KEY` | mail-jobs, mail-in | Web-push signing key (ES256). Never a plaintext var. |
| `BETTER_AUTH_SECRET` | web | Session/token signing (≥32 chars in prod). |
| `APP_CLOUDFLARE_API_TOKEN` | web | Scoped CF API token (Bearer) for domain onboarding. Treat like `MAIL_DEK`. |

**App config vars** (`apps/web/src/env.ts` validates these at boot):

| Var | Public | Purpose |
| --- | --- | --- |
| `ORIGIN` | yes | App base URL. **Must match the dev/served port** or `/api/auth/*` 404s. |
| `VAPID_PUBLIC_KEY` | yes | Web-push app-server key (client subscribes with it); also on mail-in/mail-jobs. Safe to expose. |
| `SETUP_TOKEN` | no | One-time gate for `/setup` genesis wizard. Unset → web wizard disabled (use the CLI). |
| `APP_CLOUDFLARE_ACCOUNT_ID` | no | CF account id for domain onboarding. |
| `MAIL_IN_WORKER_NAME` | no | Deployed mail-in Worker name the Email Routing catch-all targets (`domains.remote.ts`). |
| `CRON_SECRET` | no | Bearer secret for `POST /api/cron` (HTTP-triggered sweep). |
| `LOG_LEVEL` | no | `debug\|info\|warn\|error` (default `info`) for `@doota/mail-core/log`. |
| `DATABASE_URL` | no | Local D1 file for drizzle-kit (dev/studio only). |

Generate the VAPID keypair once: `node scripts/gen-vapid-keys.mjs` → set
`VAPID_PUBLIC_KEY` (var) + `VAPID_PRIVATE_KEY` (secret).

### 0.4 Move non-secret vars into wrangler configs

`keep_vars: true` is set on `apps/web`, `apps/mail-in`, `apps/mail-jobs` so a
deploy doesn't wipe dashboard-set plaintext vars. Clean end-state: declare every
non-secret var in each `wrangler.jsonc` `vars` block so config is reproducible.
Track remaining dashboard-only vars and migrate them in. See memory
`cloudflare-vars-deploy-wipe`.

### 0.45 Break-glass — clear an org's 2FA mandate

Org-wide 2FA enforcement (`docs/2fa.md`) can lock out an owner who enables it and
then loses their 2FA device. Recovery codes issued at enrollment are the first
line; if those are gone, an operator clears the mandate directly in D1:

```
wrangler d1 execute doota --remote --command "UPDATE org_mail_settings SET require_2fa = 0, require_2fa_from = NULL WHERE org_id = '<org-id>';"
```

Full procedure and rationale (including the API-key exemption): `docs/2fa.md`.

### 0.5 Infrastructure (IaC + provisioning prereqs)

Each Worker's `wrangler.jsonc` is the **declarative source of truth for bindings**
— D1, R2, KV, queues, DOs, `send_email`, routes. `wrangler deploy` reconciles
bindings but does **not** create the stateful resources they point at, and does
not touch Email Routing or Email Service.

**Workers and what they own** (single-purpose split — a queue binds one consumer):

| Worker | Config | Owns |
| --- | --- | --- |
| `doota` (web) | `apps/web/wrangler.jsonc` | App + `send_email`; **produces** to inbound/outbound queues; custom domain `mail.doota.dev`. |
| `doota-mail-inbound` | `apps/mail-in/wrangler.jsonc` | `email()` handler + **consumes** `doota-mail-inbound`. Name is load-bearing. |
| `doota-mail-jobs` | `apps/mail-jobs/wrangler.jsonc` | **Consumes** `doota-mail-outbound` + `doota-mail-events`; owns `MailEventHub` DO; cron `*/5`. |

**Resources to create once (deploy will NOT create these):**

```
wrangler d1 create doota                     # id → all three configs' database_id
wrangler r2 bucket create doota-mail-raw     # binding MAIL_RAW in all three
wrangler kv namespace create AUTH_KV         # id → web + mail-in AUTH_KV
wrangler queues create doota-mail-inbound
wrangler queues create doota-mail-outbound
wrangler queues create doota-mail-events
```

**Wired in the dashboard (not in any wrangler file):**

- **Email Routing** — catch-all rule on the receiving domain → Worker
  `doota-mail-inbound`. Set at runtime via `domains.remote.ts`
  (`MAIL_IN_WORKER_NAME`); confirm the rule points at that exact name.
- **Email Service event subscription** — on the sending domain → queue
  `doota-mail-events` (Dashboard → Email Service → Event subscriptions). Feeds
  delivered/bounced/complained back to `doota-mail-jobs`. Without it, only
  DSN-fallback bounce handling works.
- **DKIM / return-path** — set on the sending zone; the `send_email`
  (`EMAIL_SENDER`) binding uses it. Verify before real sends.
- **Custom domain** `mail.doota.dev` — declared in the web config `routes`, but
  the zone + DNS must exist.

**Cross-Worker wiring gotchas:**

- The **`MailEventHub` DO is defined in `doota-mail-jobs`** (`migrations`
  `new_sqlite_classes` tag) and bound **cross-script** from web + mail-in
  (`script_name: "doota-mail-jobs"`). **Deploy `doota-mail-jobs` first** so the
  class exists before the other two bind to it.
- **Deploy order:** `doota-mail-jobs` → `doota-mail-inbound` → `doota` (web).
- Migrations live at repo-root `../../drizzle` shared by all three; apply once
  against the shared D1 (§1.2), not per-Worker.

---

## 1. Every-deploy sequence

Run in order.

### 1.1 Verify gates

```
pnpm --filter @doota/mail-core exec tsc --noEmit
cd apps/web && npx vitest run src/test/     # FULL suite, not touched-file — cross-file regressions
npx svelte-check --threshold error          # pre-existing vite.config.ts error is ignorable
```

Run the **full** vitest suite, never touched-file only — cross-file regressions
slip through otherwise (memory `run-full-test-suite-before-push`).

### 1.2 Apply migrations

Migrations run through **`0033`** (34 files, `0000`–`0033`). Apply remote in order:

```
wrangler d1 migrations apply doota --remote
```

Split add/drop across two migration files when a rename would otherwise trigger
drizzle-kit's interactive prompt (see 0026 add / 0027 drop; 0032/0033 add
send-log + templates).

**`0055_message_search_porter` empties the search index (one-way).** It DROPs
`message_search` to switch it to the Porter stemming tokenizer, so it comes back
**empty**. New mail re-indexes at ingest; **mail that existed before the deploy is
not searchable** (no backfill). Acceptable pre-launch (little/no existing mail).
If a backfill is ever needed, reindex by re-running `plaintextIndex().index()`
over the decrypted `subject_enc` / `body_stripped_enc` columns.

### 1.3 Bump caches when render/logic changes

- **`RENDER_CACHE_VERSION`** (`apps/web/src/lib/server/render-cache.ts`, currently
  **`"13"`**) — bump whenever body-render or sanitize/strip logic changes. It keys
  the body cache, the ETag, and the attachment cache, so a bump forces every
  client + edge copy to re-fetch the patched render. **Bump it in the same commit**
  as any render-logic change, or users keep seeing the old render.
- **PWA precache / service-worker version** — the `$service-worker` `version`
  invalidates old precached build files on the next load; a normal build bumps it.
  Confirm the SW updated after deploy.

### 1.4 Deploy

Deploy in order — **`doota-mail-jobs` → `doota-mail-inbound` → `doota` (web)** — so
the `MailEventHub` DO class exists before the other two cross-script-bind to it
(§0.5). Root helpers: `pnpm deploy:workers` (both mail Workers), `pnpm deploy:all`.
Secrets and `keep_vars` vars survive; confirm no plaintext var got dropped.

The `apps/native` Tauri client is built + released on its own track
(`pnpm --filter doota-mail tauri build` for desktop bundles; mobile via the Tauri
CLI) — not part of the Worker deploy.

### 1.5 Post-deploy smoke (live)

- Receive a real inbound (Gmail, Outlook, Apple) → renders, threads correctly.
- A marketing template (Mailchimp/Amazon) renders as an HTML frame, not text.
- Send + reply → wire threading intact, quoted parent stripped.
- Attachment upload → view → download round-trips (encrypted at rest).
- `POST /api/send` with a `dk_` key → 202 + send-log row.
- Dark mode + web-push notification fire; the bell shows the new-mail row.

---

## 2. Re-materialize runbook (operator, on render-logic change)

When the **derivation logic** changes (`isRichHtml`, forward-aware quote
stripping, `htmlKind`/`hasRemoteImages`/attachment-`inline` computation), existing
D1 rows keep their *old* derived flags until re-fetched. To back-fill live data
without waiting:

**Shape (recommended):** a one-off handler in `apps/mail-jobs` that walks every
`message`, reads its encrypted raw from R2 (`getDecryptedBlob`), re-runs the
derivation (`rawObjectToHtml` + the strip/classify path), and re-writes the
derived flags + body cache (`packBlob`). Reuses existing bindings + `MAIL_DEK`; no
new creds. Trigger via `wrangler ... --remote` or the guarded `POST /api/cron`
route (`CRON_SECRET`), then remove the trigger.

**When to build it:** not now — build the handler the **first time a render-logic
change ships to live data**, and bump `RENDER_CACHE_VERSION` alongside so
un-re-materialized rows still render correctly on demand. Until then this is a
documented step, not code.

---

## 3. Local development

```
pnpm db:migrate:local     # apply migrations to local D1 (wrangler d1 … --local)
pnpm dev                  # web dev server on :5173 (Vite + wrangler platformProxy)
```

- Bindings are simulated by wrangler's platform proxy; secrets read from
  `apps/*/.dev.vars` (`MAIL_DEK`, `MAIL_SEARCH_KEY`, `VAPID_*`). Test values live
  there for local runs.
- **`ORIGIN` must match the dev port** (Better Auth gates `/api/auth/*` on it).
  For another port, drop a temporary `.env.local` and delete it after (see
  `auth/testing-and-cleanup.md`).
- Genesis for local testing: `pnpm reset-admin <external-email> <password>`
  (email-free; enrolls TOTP, prints `otpauth://` + backup codes).
- Mail Workers: `pnpm dev:mail-in` / `pnpm dev:mail-jobs`. Inspect D1:
  `pnpm wrangler d1 execute doota --local --command "…"`. Studio:
  `pnpm --filter doota db:studio`.
- **Clean up test users** after auth tests — a leftover user wedges the
  `userCount === 0` genesis guard (memory `cleanup-test-users-after-testing`).

---

## 4. Quick checklist

- [ ] 0.1 Removed `unpackBlob` plaintext tolerance (fail closed) + flipped test
- [ ] 0.2 Draft-attachment plaintext gap closed **or** "encrypted at rest" claim footnoted
- [ ] 0.3 Secrets set per env: `MAIL_DEK`, `MAIL_SEARCH_KEY`, `VAPID_PRIVATE_KEY`, `BETTER_AUTH_SECRET`, `APP_CLOUDFLARE_API_TOKEN`; vars: `ORIGIN`, `VAPID_PUBLIC_KEY`, `MAIL_IN_WORKER_NAME`, etc.
- [ ] 0.4 Non-secret vars declared in wrangler configs
- [ ] 0.5 Infra created: D1 / R2 / KV / 3 queues; Email Routing catch-all → mail-inbound; Email Service subscription → mail-events; DKIM; custom domain
- [ ] 1.1 tsc + full vitest + svelte-check green
- [ ] 1.2 `d1 migrations apply --remote` (through `0033`)
- [ ] 1.3 `RENDER_CACHE_VERSION` bumped if render logic changed; SW version rolled
- [ ] 1.4 Workers deployed in order (jobs → inbound → web); no plaintext var dropped
- [ ] 1.5 Live smoke: inbound / template / send-reply / attachment / API send / dark / push
