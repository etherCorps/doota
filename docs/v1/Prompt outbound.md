# Claude Code Prompt — Outbound pipeline (`mail-out`, submissions, bounces, rate limiting)

> Task 3 in the build order. Reference docs in repo: `AUTH_HANDOFF.md`,
> `ARCHITECTURE.md`, `SCOPE.md`.

## Context
Doota is a self-hosted, Cloudflare-native email app: SvelteKit (Svelte 5 runes) +
Cloudflare Workers + D1 + Drizzle + Better Auth. **organization = one domain**. Core
thesis: email rendered as a messaging app — a thread is a WhatsApp-style timeline of
bubbles.

Already built, NOT to be rebuilt:
- **Auth + organisation management** — `can()` chokepoint, served-domain invariant,
  email-free genesis, provisioning, domain onboarding (`domains.remote.ts` is the only
  Cloudflare writer), `org-domains.ts` cache, routing subdomains, subaddressing, BIMI.
- **Mailbox model + inbound pipeline** — `mailboxes`, `mailbox_access`, `aliases`,
  `threads`, `messages`, `deliveries`, `thread_states`, `labels`, `attachments`, FTS5
  blind-token search; the address resolver; the `mail-in` Worker; the inbound Queue
  consumer; the thread DTO and mailbox read paths.
- **`materializeDelivery()`** — the shared seam written during the inbound task that writes
  `messages` / `deliveries` / `thread_states`. **Reuse it. Do not duplicate that logic.**
- **`can()` already models `send` as a mailbox capability, not a role** — only the mailbox
  owner or an explicitly granted sender may send as an address. Even superadmin cannot
  send-as-others. Do not create a parallel permission path.
- **`mailer.ts` / `server/email/`** — existing transactional mail (invite, reset-code,
  reset-link, recovery-verify, verify-email, `_layout`), sending via a Cloudflare mail
  worker, from-address always on an `active` (DKIM-wired) domain.

## Read before writing — and STOP to report conflicts
Read `AUTH_HANDOFF.md`, `ARCHITECTURE.md`, `SCOPE.md`, the current Drizzle schema,
`can()`, `mailer.ts`, `org-domains.ts`, `MIGRATION_NOTES.md`, and everything produced by
the mailbox/inbound task (especially `materializeDelivery()` and the thread DTO).
EXTEND — do not rewrite. Produce a conflict list FIRST and STOP for review.

## RECONCILIATION TO RESOLVE FIRST (report your plan before coding)
`mailer.ts` already sends transactional mail through a Cloudflare mail worker. This task
introduces a `mail-out` Worker for user mail. **There must not be two independent send
paths.** Decide and report:
- Does `mailer.ts` migrate onto `mail-out` (recommended: one queue, one retry policy, one
  set of provider credentials, one place bounces are processed), or does it stay separate?
- If it migrates: transactional mail must NOT be delayed behind a user-mail backlog, and
  must NOT be subject to user-facing undo. Propose priority/bypass handling.
- Transactional mail must keep working throughout. Genesis and password reset must never
  depend on the user-mail queue being healthy.

## Hard constraints
- **Auth boundary:** all auth/user/org/permission access via `src/lib/server/auth/`. Never
  `$context`, `internalAdapter`, or auth-schema imports outside it — lint-guarded.
- **RPC pattern:** app-side surfaces use SvelteKit remote functions (`.remote.ts`).
- **Internal → app→mail-out is a Service Binding (RPC).** External/programmatic access uses
  bearer API keys (Better Auth `apiKey` plugin).
- The Cloudflare API must NEVER be called on a hot path.
- D1 has NO transactions — unique indexes and idempotent upserts only.
- Encrypt CONTENT only; routing/threading metadata cleartext. DEK/SEARCH_KEY never in D1.
- **Provider stays pluggable.** Cloudflare Email Service is primary and is **public beta** —
  a named dependency risk. Keep the Resend fallback behind the same seam. No provider
  specifics leak past the adapter interface.

## Part A — Submission schema (JMAP `EmailSubmission`-shaped)
Send state belongs on a **submission object, separate from the message** — `messages` are
immutable and shared, so send state cannot live there.

- `submissions` — id, org_id, message_id, mailbox_id (the sending identity),
  envelope_from, from_alias_id nullable, created_by_user_id, `send_at` (scheduled send),
  `undo_until`, status, attempts, last_error, provider, provider_message_id,
  idempotency_key (UNIQUE — the double-send guard), created_at.
- `submission_recipients` — (submission_id, address) UNIQUE; role (to|cc|bcc), per-recipient
  status, bounce_type (hard|soft) nullable, bounce_reason, provider_message_id,
  updated_at. **Per-recipient rows are required** — bounces are per-recipient and sends
  chunk at 50.
- `suppressions` — org_id, address (UNIQUE per org), reason, first_seen_at, last_seen_at.
  Hard bounces and complaints land here; sends to suppressed addresses are blocked before
  they reach the provider.
- `send_counters` (or reuse the existing DB-backed rate-limit pattern) — per-mailbox and
  per-instance windowed counters.

Status lifecycle (submission-level rolls up from recipients):
`draft_queued → queued → sending → sent → delivered → bounced(hard|soft) → complained`,
plus `canceled` (undo) and `failed` (gave up).

## Part B — `mail-out` Worker + outbound Queue
Standalone Worker, separate from the SvelteKit app.

1. **Enqueue** — a submission row is written first (status `queued`, idempotency_key set),
   then a job is enqueued. Writing the row before enqueueing is what makes redelivery safe.
2. **Undo window** — hold the job using the queue's delivery delay (default ~30s,
   configurable per instance). `undo_until` on the row is the source of truth for whether
   cancellation is still possible.
3. **Scheduled send** — `send_at` in the future uses the same delay mechanism, or a
   periodic sweep for delays beyond the queue's maximum. State which you chose and why.
4. **Consumer** — chunk recipients at **50 per provider call**; call the provider adapter;
   record `provider_message_id` per recipient; advance status.
5. **Retries/backoff** — retry soft failures with exponential backoff and a cap; hard
   failures do not retry. On give-up → `failed` with `last_error`.
6. **Double-send guard** — the unique `idempotency_key` plus per-recipient status means a
   redelivered job never re-sends to a recipient already marked sent. Prove this in a test.
7. **Preflight checks** before any provider call: `can()` grants the send capability for
   this mailbox; the from-address resolves to an `active` domain (DKIM-wired); alias sends
   resolve to an enabled alias owned by that mailbox; suppressed recipients are dropped
   (and recorded as dropped, not silently lost); rate limits pass.

## Part C — Internal short-circuit
Mail from a mailbox on this instance to an address on this instance **must not** go out to
SMTP and come back. Detect internal recipients via the existing address resolver and write
them directly with **`materializeDelivery()`**.

Mixed recipient lists are the normal case: split them — internal recipients materialize
immediately, external recipients go to the provider — under **one** submission, with
per-recipient status reflecting each path.

## Part D — The sender's own copy
Sending must place the message in the sender's own timeline:
- a `deliveries` row with role `from` for the sending mailbox;
- a `thread_states` row — a **new** outbound thread gets placement `sent`; a **reply** to an
  existing thread keeps that thread's current placement (do not yank an inbox thread into
  `sent`).
Both through `materializeDelivery()`.

## Part E — Outbound message construction
- **Re-quote on outbound** for Gmail/Outlook interop: Doota stores `body_stripped`, but
  replies leaving the instance must include conventional quoted history, or external clients
  lose context. Build the quoted block from the parent message.
- Set `In-Reply-To` and `References` correctly from the parent so external clients thread it.
- Generate a Message-ID owned by us; it is the dedupe key if the message comes back to us.
- **BCC stays envelope-only** — recipients in the BCC role must never appear in transmitted
  headers, matching the inbound invariant.
- Attachments assembled from R2.

## Part F — Bounce & complaint handling
Non-negotiable: without this, failures are invisible and domain reputation degrades silently.

- Cloudflare Email Service uses a **cf-bounce / return-path** subdomain (already wired
  during domain onboarding). **Verify against current Cloudflare documentation how bounce
  and complaint events are actually surfaced** — routed back as mail to the return-path,
  polled, or delivered by webhook — and implement against what is true today, not an
  assumption. Report what you find.
- Map provider events onto per-recipient status. Classify hard vs soft.
- Hard bounces and complaints → `suppressions`. Soft bounces retry within policy, then
  give up.
- If bounces arrive as inbound mail, they must be recognized by the inbound consumer and
  routed to submission handling — **not** materialized as a normal message in someone's
  inbox.
- Surface per-message failure in the read model so the UI can render it.

## Part G — Rate limiting / abuse guard
Per-mailbox and per-instance send caps over a rolling window, enforced before the provider
call. A compromised account or a reply loop must not be able to torch the domain's
reputation. Exceeding a cap → submission `failed` with a clear reason, and an admin-visible
signal. Reuse the existing DB-backed rate-limit pattern rather than inventing a new one.

## Part H — Send-state in the read model
Extend the thread DTO so each outbound message carries its submission status, mapped to
**WhatsApp-style ticks**: clock (queued/scheduled) → single tick (sent/accepted) → double
tick (delivered) → warning glyph (bounced/failed). Per-recipient detail available on
demand for multi-recipient messages.

## Part I — Trigger surfaces (no compose UI in this task)
- A `.remote.ts` send function (app → `mail-out` via Service Binding), gated by `can()`.
- A cancel/undo function operating on `undo_until`.
- Programmatic send via bearer API key (Better Auth `apiKey` plugin), authorized against the
  same mailbox capability.
- Enough of a minimal internal test surface to exercise sending. **Do not build the compose
  UI, the from-selector, or drafts** — that is the next task.

## Out of scope
Compose UI, drafts, from-selector, internal-note rendering, verified destination addresses,
open/click tracking. Do not modify auth, domain onboarding, or the inbound pipeline except
where Part F requires bounce recognition.

## Deliverables
1. Conflict list + the `mailer.ts` reconciliation plan — **then STOP for review.**
2. Drizzle schema + migration (Part A).
3. `mail-out` Worker + outbound Queue consumer with retries, chunking, idempotency
   (Part B), Service Binding from the app, API-key path.
4. Provider adapter interface + Cloudflare Email Service implementation, with the Resend
   fallback seam stubbed and documented.
5. Internal short-circuit and sender's-copy handling via `materializeDelivery()`
   (Parts C, D).
6. Outbound message construction: re-quoting, threading headers, BCC discipline (Part E).
7. Bounce/complaint processing + suppression list (Part F) and rate limiting (Part G).
8. Send-state in the thread DTO (Part H).
9. Tests: redelivered job does not double-send; 50-recipient chunking; undo cancels before
   the window closes and cannot after; scheduled send fires; mixed internal/external
   recipient split; hard bounce suppresses and blocks the next send; soft bounce retries
   then fails; rate-limit rejection; BCC absent from transmitted headers; reply threads
   correctly in an external client; sender's copy placement (new thread vs reply).
