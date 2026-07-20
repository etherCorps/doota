# Doota — Architecture

Data model and mail flow. Auth specifics live in `AUTH_HANDOFF.md`; feature boundaries in
`SCOPE.md`.

---

## 1. Governing ideas

**Raw is truth.** The RFC 5322 blob in R2 is canonical. Every parsed, stripped, threaded, or
derived field is regenerable from it. No derived field may ever be the only copy of
anything. When `stripQuotes` or `deriveContentKind` improve later, re-run them against the
originals and every message upgrades — zero data loss, because the source was never thrown
away. (This is JMAP's model, and Dovecot/Cyrus's before it.)

**Cloudflare is the source of truth for Cloudflare state.** D1 caches only `domain`,
`zone_id`, and `onboarding_status`. DNS records, routing rules, DKIM/SPF/DMARC status are
fetched live for admin surfaces. Nothing persisted means nothing to drift.

**Idempotency over transactions.** D1 has no transactions. Every pipeline step relies on
unique indexes and upserts, and must converge when re-run.

**Encrypt content, not routing.** Subject and bodies are encrypted (AES-256-GCM via
WebCrypto, instance DEK in Worker secret / Secrets Store, rotation-ready envelope). Routing
and threading metadata stays cleartext so the hot path and threading work without
decryption. This is zero-access at rest, **not** E2EE — operator oversight is intended.

---

## 2. The three-level split

The load-bearing refinement. Folders and assignment are *thread*-scoped ideas; receipt
(to/cc/bcc) is a *message*-scoped idea. Keeping them apart is what makes assignment,
un-archive-on-reply, and shared mailboxes clean.

| Level | Table | Holds |
|---|---|---|
| Message, shared | `messages` | One immutable row per unique email, deduped by `message_id_header` |
| Message, per mailbox | `deliveries` | Receipt: role, read, via-alias, subaddress tag |
| Thread, per mailbox | `thread_states` | Triage: placement, star, assignee |

---

## 3. Tables

### Tenancy (built)
Better Auth tables (`user`, `account`, `session`, `verification`, `organization`, `member`,
`invitation`, `passkey`, `twoFactor`, `rate_limit`). The org row additionally carries
`domain` (unique — the org identity), `zone_id`, `onboarding_status`
(`pending_zone → pending_nameservers → active | error`), and BIMI profile fields.

### Address layer (next)
- **`mailboxes`** — `id`, `org_id`, `local_part`, `address` (unique per org),
  `display_name`, `is_active`, `is_personal`. An address that receives mail. May sit on the
  apex or any configured routing subdomain.
- **`mailbox_access`** — `(user_id, mailbox_id)` unique, capability flags. The shared-mailbox
  grant. Resolves through the existing `can()`; shaped so a nullable team scope is an
  additive migration later.
- **`aliases`** — `id`, `mailbox_id`, `address` (unique per org), `label`, `is_enabled`,
  `last_used_at`. Hide-my-email: random and revocable. Distinct from subaddressing, which is
  guessable and leaks the real address.

### Mail core (next)
- **`threads`** — `id`, `org_id`, `subject_normalized`, `last_message_at`.
- **`messages`** — `id`, `org_id`, `thread_id`, `message_id_header` (**unique per org** — the
  dedupe key), `in_reply_to`, `references`, `from_addr`, `sent_at`, `r2_raw_key`,
  `content_kind` (`bubble|card`), `subject_enc`, `body_stripped_enc`, `body_full_enc`.
  **Immutable once written.**
- **`deliveries`** — `(message_id, mailbox_id, role)` **unique**; `org_id`, `role`
  (`to|cc|bcc|from`), `via_alias_id` nullable, `subaddress_tag` nullable, `is_read`.
  **BCC exists only as delivery rows** — never written into the shared message's stored
  headers.
- **`thread_states`** — `(thread_id, mailbox_id)` **unique**; `placement`
  (`inbox|archived|spam|trash|sent`, exclusive), `is_starred`, `assignee_user_id` nullable,
  `last_read_at`.
- **`labels`** (org-scoped) + **`thread_labels`** (`thread_id`, `mailbox_id`, `label_id`).
- **`attachments`** — `message_id`, `part_id`, `filename`, `content_type`, `size`, `r2_key`.
  Raw stays canonical; attachments are servable by re-extraction.
- **FTS5 virtual table** — blind HMAC tokens (per-word, separate `SEARCH_KEY`), scoped to
  mailboxes via a `deliveries` join. Exact word AND/OR only; no prefix or fuzzy.

Model read/answered/flagged as an extensible **keyword set** (JMAP-style) where practical,
rather than a boolean column per flag.

### Planned (later slices)
- **`submissions`** — the JMAP `EmailSubmission`-style object, separate from the message:
  send state (`queued → sent → delivered → bounced (hard|soft) → complained`), `send_at`,
  undo status, attempts, provider message id. Likely per-recipient rows, since bounces are
  per-recipient and sends chunk at 50.
- **`drafts`** — own table, with the from-selector that completes reply-as-alias.
- **Timeline items** — `internal_note` and `system_event` need a home: either sibling tables
  or one `thread_items` table that external messages also register in. Open design choice.

---

## 4. Address resolution

One resolver, used by both ingest and app code. Given an inbound recipient:

1. Match the domain against the org's apex **or any configured routing subdomain**.
2. If **subaddressing is enabled for that domain**, strip `+tag`, resolve the base address,
   and carry the tag through to `deliveries.subaddress_tag`.
3. Resolve to an **active mailbox** or an **enabled alias** (alias → its mailbox).
4. Unknown or disabled → not deliverable.

Served by the existing `org-domains.ts` cache (30s TTL + explicit invalidation), extended.
Invalidate on mailbox, alias, or routing-subdomain changes. **Never** call the Cloudflare API
here.

---

## 5. Inbound flow

Cloudflare Email Routing catch-all → `mail-in` Worker → Queue → consumer.

**Bucket-first, accept-and-enqueue.** The Worker does the minimum so that a processing
backlog or outage affects *processing*, never *receipt*.

### `mail-in` Worker — `email()` handler
1. Resolve `message.to` via the resolver above (cached D1 only).
2. Unresolvable or disabled → `message.setReject(...)`. The sender gets a proper bounce and
   we store nothing.
3. Stream `message.raw` to R2, keyed by Message-ID (or content hash if absent).
4. Enqueue `{ r2_raw_key, recipient, resolved_mailbox_id, subaddress_tag, via_alias_id,
   envelope_from, org_id }`.

No parsing, no threading here.

> Email Routing invokes the Worker **once per recipient** when a message is addressed to
> several of our addresses. Expected — dedupe happens downstream by Message-ID, and each
> invocation contributes its own delivery.

### Queue consumer — idempotent, heavy work
1. Fetch raw from R2; parse MIME with **postal-mime** (Workers-compatible — not Node
   `mailparser`).
2. Upsert `messages` by `message_id_header` — first writer creates, later recipients reuse.
3. Threading: `resolveParent` + `resolveThread` from `In-Reply-To`/`References`. Normalized
   subject only as a weak, time-bounded, same-org fallback.
4. `stripQuotes` (email-reply-parser for text, HTMLRewriter for HTML) — store **both**
   `body_stripped` and `body_full`. `deriveContentKind` → bubble vs card.
5. Encrypt content; write ciphertext. Routing/threading meta stays cleartext.
6. Attachment metadata → `attachments`.
7. Upsert `deliveries` per recipient role (BCC envelope-only), recording `via_alias_id` and
   `subaddress_tag`; bump `alias.last_used_at` on alias delivery.
8. Ensure `thread_states` per recipient mailbox: place in inbox; **un-archive-on-reply**.
9. Emit blind search tokens → FTS5.

Every step must be safe to re-run. A redelivered job converges; it never duplicates.

---

## 6. Outbound (designed, not built)

`mail-out` Worker + Queue: retries with backoff, 50-recipient chunking, double-send guard.
Send state lives on the **submission object**, not the message, and surfaces in the UI as
WhatsApp-style delivery ticks (clock → single tick → double tick → warning glyph on bounce).
Undo send and scheduled send fall out of the queue.

**Internal mail short-circuits** — mailbox→mailbox on the same instance writes straight into
`messages`/`deliveries`/`thread_states` with no SMTP loopback, via a shared
`materializeDelivery()` seam that the inbound consumer also uses.

Two invisible essentials ship with outbound, not after: **bounce/complaint handling** (via
cf-bounce, surfaced per-message) and **outbound rate limiting** (per-mailbox and
per-instance caps, so a compromised account can't get the domain blocklisted).

---

## 7. Read model

A thread DTO assembled from thread + messages + the current mailbox's `deliveries` and
`thread_states`, decrypting on read. Shaped on the **JMAP `Email`/`Thread`** objects —
`bodyValues`, `textBody`/`htmlBody`, `attachments`, `keywords`, `mailboxIds` — so a future
JMAP-compatible API is a thin mapping rather than a rewrite.

The timeline is a **discriminated union**: `external_message | internal_note |
system_event`. Schema and DTO accommodate all three from day one; retrofitting an item-type
discriminator later would touch every render path.

---

## 8. Boundaries

- **Auth:** everything through `src/lib/server/auth/`. Never `$context`, `internalAdapter`,
  or auth-schema imports outside it (lint-guarded).
- **Cloudflare writes:** only `domains.remote.ts`.
- **RPC:** SvelteKit remote functions (`.remote.ts`), matching `domains.remote.ts`.
- **Provider:** pluggable. Cloudflare Email Service is public beta — the Resend fallback
  seam stays clean.
