# Claude Code Prompt — Mailbox model + inbound mail pipeline

> Task 2 in the build order. Reference docs in repo: `AUTH_HANDOFF.md`,
> `ARCHITECTURE.md`, `SCOPE.md`.

## Context
Doota is a self-hosted, Cloudflare-native email app: SvelteKit (Svelte 5 runes) +
Cloudflare Workers + D1 + Drizzle + Better Auth. **organization = one domain**
(`org.domain` unique). Core thesis: email rendered as a messaging app — a thread is a
WhatsApp-style timeline of bubbles.

Auth and organisation management are COMPLETE. Already built, NOT to be rebuilt:
- `can()` — the single permission chokepoint. `send` is already modeled there as a
  **mailbox capability, not a role** (owner or explicitly-granted sender only).
- Domain onboarding (onboard/link/refresh CF zones, DNS tab, BIMI), lifecycle status
  `pending_zone → pending_nameservers → active | error`. Cloudflare is source of truth;
  D1 caches domain/zoneId/status only.
- **`org-domains.ts`** — the domain→org cache (30s TTL + explicit invalidation) that
  already drives routing, login validation, and sender-address resolution.
- **Routing subdomains** — per-org configurable; addresses may live on the apex OR any
  configured routing subdomain.
- **Subaddressing** (`user+tag@`) — a per-domain toggle that already exists.
- User provisioning (`provisioning.ts`): admin supplies a LOCAL PART, org pins the domain,
  atomic `admin.createUser` → `addMember` → invite email.
- Auth boundary module (`src/lib/server/auth/`) after the internal-adapter refactor.

## Read before writing — and STOP to report conflicts
Read `AUTH_HANDOFF.md`, `ARCHITECTURE.md`, the current Drizzle schema, `provisioning.ts`,
`org-domains.ts`, `can()`, `MIGRATION_NOTES.md`, and the existing artifacts: `crypto.ts`
(zero-access encryption), `search.ts` (blind-token search), `mail-thread-contract.ts`.
EXTEND these — do not rewrite. Produce a short conflict list FIRST and STOP for review
before implementing.

## Hard constraints
- **Auth boundary:** all auth/user/org/permission access goes through
  `src/lib/server/auth/`. Never import `$context`, `internalAdapter`, or auth table schemas
  outside it — the lint guard blocks it. `mailbox_access` and every permission check resolve
  through the EXISTING `can()`; do not create a parallel permission path.
- **RPC pattern:** app-side mailbox/alias management uses SvelteKit remote functions
  (`.remote.ts`), matching `domains.remote.ts`. No ad-hoc REST routes.
- **Cache reuse:** the inbound worker resolves recipients via the existing `org-domains.ts`
  cache (extended, see Part B). Do not build a second cache.
- The Cloudflare API must NEVER be called on the inbound hot path.
- D1 has NO transactions — rely on unique indexes and idempotent upserts.
- Encrypt CONTENT only (subject, bodies); routing/threading metadata stays cleartext so the
  hot path and threading work without decryption. DEK/SEARCH_KEY never in D1.

## DESIGN DECISION TO RESOLVE FIRST (report your plan before coding)
Provisioning already assigns each user a local part, so every user has an *implied* address.
But a mailbox must be a SEPARATE entity from `user`, because shared mailboxes (`support@`)
have many users and no single owner.

Resolution to implement: provisioning creates a **personal `mailbox` row + a
`mailbox_access` grant** alongside the user, rather than the address living implicitly on
the user row. There must be exactly ONE source of truth for "what address is this person".
Report how you'll migrate any existing provisioned users to this model.

## Part A — Schema (Drizzle / D1)

Three-level split — internalize this, it is load-bearing:
- **Message, shared** → `messages`
- **Message, per mailbox** → `deliveries` (receipt: role, read, via-alias, subaddress tag)
- **Thread, per mailbox** → `thread_states` (triage: placement, star, assignee)

Tables:
- `mailboxes` — id, org_id, local_part, address (unique per org), display_name, is_active,
  is_personal, created_at. Address may be on the apex or a configured routing subdomain.
- `mailbox_access` — (user_id, mailbox_id) unique, capability flags resolved via `can()`.
  Shaped so a nullable team scope is an additive migration later.
- `aliases` — id, mailbox_id, address (unique per org), label, is_enabled, last_used_at.
  Hide-my-email: random, revocable (distinct from subaddressing, which is guessable and
  leaks the real address).
- `threads` — id, org_id, subject_normalized, last_message_at.
- `messages` — id, org_id, thread_id, message_id_header (UNIQUE per org — dedupe key),
  in_reply_to, references, from_addr, sent_at, r2_raw_key, content_kind (bubble|card),
  subject_enc, body_stripped_enc, body_full_enc. IMMUTABLE once written.
- `deliveries` — (message_id, mailbox_id, role) UNIQUE; org_id, role (to|cc|bcc|from),
  via_alias_id nullable, **subaddress_tag nullable**, is_read.
  BCC = delivery rows only, NEVER written into the shared message's stored headers.
- `thread_states` — (thread_id, mailbox_id) UNIQUE; placement enum
  (inbox|archived|spam|trash|sent), is_starred, assignee_user_id nullable, last_read_at.
- `labels` (org-scoped) + `thread_labels` (thread_id, mailbox_id, label_id).
- `attachments` — message_id, part_id, filename, content_type, size, r2_key. Raw blob stays
  canonical; attachments are servable by re-extraction.
- FTS5 migration extending `search.ts` — blind HMAC tokens, mailbox-scoped via a deliveries
  join.

Model read/answered/flagged as an extensible KEYWORD SET (JMAP-style) where practical,
rather than one boolean column per flag.

## Part B — Address resolution (extends `org-domains.ts`)
A single resolver used by both ingest and app code. Given an inbound recipient address:
1. Match the domain against the org's apex OR any configured **routing subdomain**.
2. If **subaddressing is enabled for that domain**, strip `+tag` and resolve the base
   address; carry the tag through so it lands in `deliveries.subaddress_tag`.
3. Resolve to an ACTIVE `mailbox` OR an ENABLED `alias` (alias → its mailbox).
4. Unknown or disabled → not deliverable.
Extend the existing cache to serve this; invalidate on mailbox/alias/subdomain changes.

## Part C — Mailbox & alias management (`.remote.ts`)
- Mailbox CRUD within the current org: create (shared, e.g. `support@`), rename, deactivate.
- Grant/revoke `mailbox_access` for shared mailboxes.
- Alias CRUD: generate collision-safe random alias, enable/disable/delete, show
  last_used_at.
- Hook personal-mailbox creation into `provisioning.ts` per the decision above.
- All gated through `can()`. Domain must be `active`.

## Part D — Inbound pipeline

### D1 — `mail-in` Worker `email()` handler (fast, accept-and-enqueue)
Standalone worker, already referenced as `MAIL_IN_WORKER_NAME` by the routing rule.
1. Resolve `message.to` via the Part B resolver (cached D1 only).
2. Unresolvable/disabled → `message.setReject(...)` so the sender gets a proper bounce and
   we store nothing.
3. Otherwise stream `message.raw` to R2, keyed by Message-ID (or content hash if absent).
4. Enqueue `{ r2_raw_key, recipient, resolved_mailbox_id, subaddress_tag, via_alias_id,
   envelope_from, org_id }`.
No parsing, no threading here.

NOTE: Email Routing invokes the worker ONCE PER RECIPIENT when a message is addressed to
several of our addresses. Expected — dedupe happens downstream by Message-ID; each
invocation contributes its own delivery.

### D2 — Inbound Queue consumer (idempotent, heavy work)
1. Fetch raw from R2; parse MIME with **postal-mime** (Workers-compatible — NOT Node
   mailparser).
2. Upsert `messages` by message_id_header — first writer creates, later recipients reuse.
3. Threading: resolveParent + resolveThread from In-Reply-To/References. Normalized subject
   ONLY as a weak, time-bounded, same-org fallback.
4. `stripQuotes` (email-reply-parser for text, HTMLRewriter for HTML) — store BOTH
   body_stripped and body_full. Run `deriveContentKind` → bubble vs card.
5. Encrypt content via `crypto.ts`; write ciphertext. Routing/threading meta cleartext.
6. Attachment metadata → `attachments`.
7. Upsert `deliveries` per recipient role (bcc envelope-only), recording via_alias_id and
   subaddress_tag; bump `alias.last_used_at` on alias delivery.
8. Ensure `thread_states` per recipient mailbox: place in inbox; **un-archive-on-reply**.
9. Emit blind search tokens → FTS5.

### D3 — Idempotency
Every step safe to re-run. Unique indexes + upserts, never multi-statement transactions. A
redelivered job must converge, never duplicate.

### D4 — Internal-mail seam (do not build outbound)
Expose a shared `materializeDelivery()` that writes messages/deliveries/thread_state, so the
future outbound worker can short-circuit internal mail without SMTP loopback. Leave the
seam; build no outbound here.

## Part E — Read model
- Thread DTO assembled from thread + messages + the current mailbox's deliveries and
  thread_state, decrypting on read. Shape it on the **JMAP Email/Thread** objects so a
  future JMAP-compatible API is a thin mapping.
- The timeline is a DISCRIMINATED UNION: `external_message | internal_note | system_event`.
  Schema and DTO accommodate all three now; only `external_message` renders in this pass.
- Mailbox views: list threads by placement, open a thread. Shared-mailbox access via
  `can()`.

## Out of scope
No outbound/`mail-out`, no compose/send UI, no drafts, no internal-note rendering. Do not
modify domain onboarding or auth.

## Deliverables
1. Conflict list + the provisioning/mailbox migration plan — **then STOP for review.**
2. Drizzle schema + migration (Part A), reconciled with the existing schema.
3. Address resolver extending `org-domains.ts` (Part B).
4. Mailbox/alias `.remote.ts` functions + minimal admin UI (Part C).
5. `mail-in` worker + queue consumer with idempotency (Part D).
6. Thread DTO + mailbox list/open read paths (Part E).
7. Tests: consumer idempotency (redelivered job), Message-ID dedupe across recipients,
   alias delivery, disabled-alias rejection, subaddress tag capture, routing-subdomain
   resolution, un-archive-on-reply.
