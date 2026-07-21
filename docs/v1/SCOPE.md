# Doota — v1 Scope

This document is the boundary of v1. If a feature is not listed under **In scope**, it is
out — additions require editing this file first. The point is to ship the thesis, not a
helpdesk, not a platform.

## Thesis

Doota is an open-source, self-hosted email app on Cloudflare (Workers, D1, R2, Queues).
Explicitly **not a SaaS**. One deployment = one operator = one Cloudflare account, serving
one or more operator-owned domains, where **organization = one domain**. The differentiator
is UX: email rendered as a messaging app — a thread is a flat, WhatsApp-style timeline of
bubbles, with reply-context chips, that still interoperates cleanly with Gmail/Outlook.

v1 must be excellent for a **single user** first. Collaboration features exist only where
they reinforce the conversational metaphor.

> **Status:** auth/identity and organisation management are **built** (see
> `AUTH_HANDOFF.md`). Next up is the mailbox model + inbound pipeline. Items below marked
> *(built)* are done; everything else is designed but unshipped. Data model and flows are
> in `ARCHITECTURE.md`.

---

## In scope — v1

### Core mail
- **Inbound pipeline** — Email Routing catch-all → standalone `mail-in` Worker,
  bucket-first / accept-and-enqueue (raw to R2, heavy work in an idempotent Queue
  consumer). Unknown or disabled addresses are rejected at the edge (proper bounce,
  nothing stored).
- **Outbound pipeline** — standalone `mail-out` Worker + Cloudflare Queue: retries with
  backoff, 50-recipient chunking, double-send guard. Internal (same-instance) mail
  short-circuits into deliveries — no SMTP loopback. Provider pluggable: Cloudflare Email
  Service primary (public beta — a named dependency risk), Resend fallback behind the same
  seam.
- **Send state** — a first-class submission object (modeled on JMAP `EmailSubmission`,
  separate from the message): `queued → sent → delivered → bounced(hard|soft) → complained`,
  carrying `sendAt` (scheduled send) and undo status. Surfaced in the UI as
  WhatsApp-style ticks (clock / single / double / warning).
- **Undo send & scheduled send** — fall out of the outbound queue + submission object.
- **Threading** — RFC In-Reply-To/References resolved at ingest; normalized-subject only as
  a weak, same-org, time-bounded fallback. Flat timeline + reply-chip with colored spine.
- **Quote stripping** — mandatory. `email-reply-parser` (text) + HTMLRewriter (HTML);
  store both `body_stripped` and `body_full`. Re-quote on outbound for Gmail/Outlook
  interop.
- **Bubble vs card** — `deriveContentKind` splits conversational mail (bubbles) from rich
  HTML mail (cards: newsletters, receipts).
- **Drafts** — own table, autosave, resume. Compose includes a **from-selector** so replies
  can be sent as an alias.
- **Attachments** — send/receive; files + raw MIME in R2; authenticated downloads;
  size/count limits.

### Organization & triage
- **Placement** — exclusive enum per thread per mailbox: inbox / archived / spam / trash /
  sent. **Un-archive on reply.**
- **Labels** — org-scoped, many-to-many.
- **Flags** — read / starred / answered etc. modeled as an extensible **keyword set**
  (JMAP-style), not one boolean column per flag.
- **Soft-delete → trash; hard-purge** (including R2) only when zero deliveries remain.
- **Spam = manual mark only.** No automatic filtering in v1.
- **Bulk actions** — select, mark read, move, delete across a folder.

### Search & privacy
- **Zero-access at-rest encryption** — AES-256-GCM via WebCrypto; instance DEK in Worker
  secret / Secrets Store (never in D1); rotation-ready envelope. Encrypt **content only**;
  routing/threading metadata stays cleartext. Not E2EE — operator oversight is a feature.
- **Blind-token search** — HMAC each word with a separate SEARCH_KEY; FTS5 stores opaque
  tokens; exact-word AND/OR only; mailbox-scoped via deliveries join.
- **Hide-my-email aliases (minimal slice)** — generate random alias on your own domain →
  maps to a mailbox; enable / disable / delete; `last_used_at`; disabled aliases rejected
  at ingest; reply-as-alias via the from-selector. *Deferred:* per-alias auto-labeling,
  analytics, alias-specific rules.

### Sending safety (invisible but non-negotiable)
- **Bounce & complaint handling** — process provider delivery events (incl. cf-bounce),
  surface per-message via the submission object, stop retrying hard-bounced addresses.
- **Outbound rate limiting** — per-mailbox and per-instance send caps, so a compromised
  account or a loop cannot torch the domain's reputation.

### Collaboration (the Missive layer — deliberately thin)
- **Shared mailbox access** — multiple users granted one mailbox (support@, sales@) via
  `mailbox_access`; all permissions through the single `can()`. Sending is a **mailbox
  capability, not a role**.
- **Internal notes** — a non-sent item type in the thread timeline, visible only to org
  members with mailbox access, never transmitted externally.
- **Assignment** — an assignee per thread per mailbox.
- The thread timeline is a **discriminated union**: `external_message | internal_note |
  system_event`, all rendered in one conversation.

### Auth & access — *(built)*
- **Login** — (A) email+password → TOTP, or (B) passkey (no stacked TOTP). Backup codes.
  Better Auth plugins: emailAndPassword, twoFactor (+backup), passkey, admin, organization,
  multiSession, apiKey, lastLoginMethod, openAPI. Rate limits (DB-backed) on sign-in,
  password reset, and 2FA; 5-minute session cookie cache with forced-fresh reads on
  `?verified=1` and onboarding completion.
- **No self-signup** — accounts are admin-provisioned only.
- **Two role axes** — *instance role* (`member | admin | superadmin`) and *org membership
  role* (`owner | admin | member`, per-org). Superadmin has an external email, no mailbox,
  `/admin` only, and is owner of every org it creates. One `can()` resolves everything;
  it logs denials.
- **Email-free superadmin genesis** — trust root is deploy access, not email. The first
  user on a fresh deploy auto-becomes external superadmin via a `user.create` hook guarded
  by `$count(user) === 0`; the public `setup` route is inert once a user exists. CLI
  setup/`reset-admin` is the guaranteed floor (works with no web layer and no mail).
  Superadmin's external email is stored unverified at genesis; verification is auto-sent
  once a domain goes `active`.
- **Served-domain invariant** — login/recovery addresses on any served domain are rejected
  (circular-lockout rule). Reset target branches by role: superadmin → verified primary
  email; member/admin → verified **external** recovery email; never the Doota inbox, never
  unverified. Recovery-verify flow uses namespaced tokens.
- **User provisioning** — admin supplies the **local part only** (org pins the domain;
  domain must be `active`). Atomic `admin.createUser` → `addMember` → `mustChangePassword`
  → invite email (temp password + recovery-verify link) to the external recovery address.
- **Role-based onboarding gate** — derived steps, fresh D1 reads, gating everything until
  complete (superadmin: onboard domain + secure account; admin/member: verify recovery,
  set password).
- **Multi-session** — switching between accounts across served domains.
- **Admin controls** — pause login (ban **and** revoke live sessions), admin-initiated
  reset, ownership-gated "view all orgs" (aggregate query, not a non-member override).
- **Programmatic API keys** — bearer keys for external send through `mail-out`.

### Onboarding & domain management — *(built)*
- **In-app Cloudflare domain onboarding (superadmin-only)** — `onboardDomain` (zone create
  → wire mail → create org), `linkDomain` (sync a zone already configured on the CF
  dashboard), `refreshDomain` (poll a pending zone, activate when live),
  `listCloudflareZones` (account zone picker with onboarded/configured flags). Pending
  zones surface their nameservers. `domains.remote.ts` is the **only** Cloudflare writer.
- **Store-minimal** — D1 keeps only domain, `zone_id`, and Doota's own lifecycle status
  (`pending_zone → pending_nameservers → active | error`). Everything else is fetched live
  from the Cloudflare API, for admin/settings screens **only** — never on the inbound hot
  path or login validation.
- **Domain→org cache** (`org-domains.ts`) — 30s TTL + explicit invalidation; drives inbound
  routing, login validation, served-domain rejection, and sender-address resolution.
- **DNS tab / onboarding health** — live DKIM / DMARC / return-path (`domainDnsRecords`)
  and `mailRoutingConfig`, so "why is mail failing" is a screen, not a support ticket.
- **Inbound routing config** — add/remove **routing subdomains** (addresses may live on the
  apex or any configured subdomain), and a per-domain **subaddressing** toggle (`user+tag@`).
- **BIMI profile** — name + logo via `updateOrgProfile`.
- **Credential** — scoped API **Token** (Bearer), never the Global API Key. Env is
  `CF_ACCOUNT_ID` + `CF_API_TOKEN`; stored as Worker secret / Secrets Store, never in D1.
  Treated with the same rigor as the DEK.

### Client & deployment
- **Three-pane mailbox**, sidebar nav, header search, **⌘K command palette**.
- **Desktop-first PWA** now; Tauri v2 shell later; native mobile only if demanded.
- **Design system** — calm/precise/conversational. Paper #F4F6F8, ink #15171E, accent
  #0E7AE6 (interactive only); Bricolage Grotesque / Inter / JetBrains Mono (every address
  in mono); sent bubbles graphite, not blue; reply-chip with colored spine is the
  signature.
- **OSS packaging** — Deploy-to-Cloudflare button, contributor README, local dev story
  for ingest (wrangler dev + `.eml` fixtures).

---

## Data-model invariants

1. **Raw is truth.** The RFC 5322 blob in R2 is canonical and immutable; every derived
   field (stripped body, content kind, search tokens, attachment metadata) is regenerable
   from it. No derived field may ever be the only copy of anything.
2. **Message vs. state split** (JMAP-shaped): `messages` are shared, deduped by
   Message-ID, immutable. Per-mailbox receipt lives in `deliveries` (message-level: role,
   read, via_alias, subaddress_tag). Per-mailbox triage lives in `thread_states`
   (thread-level: placement, star, assignee).
3. **Address resolution** — apex or configured routing subdomain; strip `+tag` where
   subaddressing is enabled and carry it to `deliveries.subaddress_tag`; resolve to an
   active mailbox or enabled alias. Served by the `org-domains.ts` cache, never the CF API.
4. **BCC is envelope-only** — delivery rows, never written into shared message headers.
5. **Idempotency over transactions.** D1 has no transactions; every pipeline step
   converges on re-run via unique indexes and upserts.
6. **DTOs shaped on JMAP** `Email`/`Thread`/`EmailSubmission`, so a future
   JMAP-compatible API is a thin mapping — but the full JMAP protocol is *not* v1.
7. **Keys decoupled from credentials** — DEK and SEARCH_KEY never depend on, or live
   near, user credentials or the CF token.
8. **Auth boundary** — all auth/user/org/permission access goes through
   `src/lib/server/auth/`. No `$context`, `internalAdapter`, or auth-schema imports outside
   it (lint-guarded). Writes to Better Auth-owned tables only via Better Auth.
9. **RPC via SvelteKit remote functions** (`.remote.ts`), matching `domains.remote.ts`.
   Cloudflare writes only from `domains.remote.ts`.

---

## Out of scope — v1

| Item | Why / condition for revisiting |
|---|---|
| **Teams-as-grouping** (Better Auth teams) | Shared mailboxes cover the real need. Constraint: `can()` stays team-*agnostic* but team-*ready* — grants shaped so a nullable `team_id` scope is an additive migration, not a resolver rewrite. |
| Automatic spam filtering | Manual mark only; classifiers are a different project. |
| Advanced routing rules (forward/reject/priority) beyond alias mapping | After the alias slice proves out. |
| PGP / E2EE | Zero-access at-rest is the deliberate model; operator oversight is wanted. |
| Prefix / fuzzy search | Blind-token design trades this away knowingly. |
| Mail import (IMAP / mbox) | Post-v1; raw-is-truth makes it safe to add later. |
| Cloudflare verified destinations | Dropped. Same-domain mail already short-circuits to the internal DB; the remaining win is bounded to low-volume system mail. |
| Full JMAP protocol | Shape only; protocol is fast-follow at most. |
| Missive-scale surface (tasks, integrations, workflow automation) | That's a helpdesk. Notes + assignment are the whole v1 collaboration layer. |
| Native mobile apps | PWA first; Tauri shell before native. |
| npx-distributed CLI | Doota is npm-free; setup/reset-admin ships as a bundled script/binary. |
| Agent-first mailboxes | The `can()` + mailbox-capability model leaves the door open; not v1. |

## Fast-follow (explicitly after v1 ships)

New-mail push notifications (in-app real-time first), per-mailbox signatures, recipient
autocomplete from prior correspondents, admin audit log (v1 logs domain-onboarding actions
minimally), per-alias rules/labels, presence & collision detection on shared mailboxes.

---

## Open items (must close, tracked here)

- **Provisioning ↔ mailbox reconciliation** — provisioning already assigns each user a
  local part, so every user has an *implied* address. But a mailbox must be a separate
  entity from `user` (shared mailboxes have many users, no single owner). Resolution:
  provisioning creates a **personal `mailbox` row + `mailbox_access` grant**. Exactly one
  source of truth for "what address is this person." Needs a migration plan for already
  provisioned users. *Closes in the mailbox task.*
- **Timeline item storage** — `internal_note` and `system_event` need a home: sibling
  tables, or one `thread_items` table that external messages also register in.
- **LICENSE + CONTRIBUTING** — license direction leaning Apache-2.0 + CLA (see
  Governance); text needs counsel review, files not yet added.

---

## Governance

- **License: leaning Apache-2.0 with a license-grant CLA** — *not yet final.*
  Apache-2.0 over MIT for the explicit patent grant, the trademark clause protecting the
  Doota name, and §5's default inbound-contribution terms.
- **CLA over DCO, for one specific reason: transferability.** Under a DCO contributors
  retain copyright, so the project becomes a mosaic of rights and neither Ethercorps nor a
  successor can relicense or cleanly hand over the whole thing without unanimous consent. A
  license-grant CLA (broad, irrevocable, **sublicensable**) preserves that option. The CLA
  text must be explicitly **assignable to a successor entity** — templates that grant rights
  to a named company without an assignment clause defeat the purpose.
- **Copyright held by Ethercorps**, not personally — a company asset transfers far more
  cleanly, and allows selling the entity rather than the code.
- **The Doota name is a separate asset** from the code copyright; hold it deliberately.
- This reverses the earlier AGPL-3.0 + DCO position. Consequence to accept knowingly:
  going permissive means anyone may run Doota as a hosted SaaS without sharing changes
  back — exactly what AGPL would have prevented.
- *Open: have counsel review the CLA text before publishing. A defective CLA is worse than
  none — it creates the appearance of protection without the substance. Add LICENSE and
  CONTRIBUTING.md once settled.*

## Known risks (named, accepted)

- **Cloudflare Email Service is public beta** — primary send/receive dependency; mitigated
  by the pluggable provider seam (Resend fallback).
- **Quote-stripping fidelity is the thesis-critical risk** — mitigated by a real-world
  `.eml` test corpus (Gmail, Outlook desktop/web, Apple Mail, newsletters: nested quotes,
  forwards, inline replies) collected continuously and run against the threading module.
- **D1 no-transactions** — accepted; idempotency-by-unique-index is the standing
  discipline.

## Build order

0. Auth, identity, `can()`, served-domain invariant *(**done**)*
1. Organisation management — domain onboarding, provisioning, onboarding flow, DNS tab,
   routing subdomains, subaddressing, BIMI *(**done**)*
2. Mailbox model + inbound pipeline — schema, address resolver, `mail-in`, queue
   consumer, thread DTO *(**done**)*
3. Outbound: mail-out worker, queue, submission/send-state, bounce handling, rate
   limiting, internal short-circuit *(**next** — prompt written)*
4. Compose + drafts + from-selector (completes hide-my-email) *(prompt written)*
5. Collaboration layer: internal notes + assignment in the timeline *(prompt written)*
6. OSS packaging: deploy button, README, dev story, LICENSE + CLA
