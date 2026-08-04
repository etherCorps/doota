# Client features — folders, rules, signatures, vacation, spam, export

Operator/developer reference for the mail-client parity features (built per the
client-gaps build guide). Each section: what it is, where it lives, what to
watch. The user-facing copy lives in the app itself.

## Change log (sync substrate)

A monotonic per-mailbox change stream (`change_log`, JMAP `/changes`-shaped)
written by **SQLite triggers** (`drizzle/0037_change_log_triggers.sql`), never
application code. Types: `Email` (delivery), `Thread` (thread_state), `Mailbox`
(label/thread_label), `EmailSubmission` (submission). Only observable columns
fire; recency bumps and cache writes never burn a `seq`. Retention 30 days:
the daily cron prunes and raises `change_log_floor` — a client presenting a
below-floor token gets `cannotCalculateChanges` (full resync). Reader:
`@doota/mail-core/change-log` (`changesSince`). No JMAP endpoint yet; the
table is the substrate for local-first sync.

Deploy note: the trigger file is a `--custom` drizzle migration.
`apply-virtual-tables.mjs` re-applies `*_fts5.sql` **and** `*_triggers.sql`
after `db:push` — don't rename the file outside that pattern.

## Folders (labels)

Placement stays system-only (`inbox/archived/spam/trash`); **labels carry all
user organisation** (org-scoped vocabulary, per-(thread, mailbox) application,
depth ≤ 2). Folder-like behaviour is one action, not schema: **Move replaces**
a thread's labels (`moveThreadToFolder`), "Add label" is additive. Filing is
moving — a moved thread leaves the inbox (placement `archived`).

Resurfacing on a new reply follows `thread_state.placement_origin`:
`user`-filed → back to Inbox unread; `rule`-filed → stays put; `muted` → stays
put and silent. Undo (snackbar) restores labels **and** origin stamps.
Per-folder notification setting `label.notify_new_mail` (rule-fed folders
default to off). Deleting a folder always offers "move contents to…" — mail is
never orphaned or deleted.

## Rules

`rule` table per mailbox; JSON DSL (closed enums, validated on write in
`@doota/mail-core/rules` — nothing unvalidated reaches the executor).
Evaluation runs at the inbound `rulesEval` stage, **before placement and
notification dispatch** (structurally: `INBOUND_STAGES` order, tested).

- Tier 1 conditions (from/to/cc/subject/list-id/has-attachment/size) are free.
  Tier 2 (`body`) is lazy: at ingest the parsed text is already in memory; the
  **backfill** fetches R2 only when a rule declares a body condition.
- **Privacy note for self-hosters: a body-matching rule means the server
  matches against decrypted message content at ingest.** This is already true
  of the ingest pipeline generally (parsing, quote-stripping, search
  tokenisation happen in-memory before encrypted storage) — body rules add no
  new at-rest exposure, but they are content-dependent server logic. If that
  matters to your threat model, use header-only rules.
- Precedence: first `moveTo` in position order wins (later ones logged as
  `rules.move_ignored`, their non-move actions still apply); a thread with
  `placement_origin = 'user'` is never moved by ingest-time evaluation.
- "Apply to existing" is a resumable queue backfill (cursor in D1 on the rule
  row); it may override user placement only via the explicit confirm dialog.
- `forward` requires a confirmed destination, refuses auto-generated mail and
  our own `X-Doota-Forwarded` marker, and sends authorized as the rule's
  creator (normal can() send gate + outbound rate limit apply).

## Signatures

Per (user, mailbox, context) with `context ∈ {new, reply}` (missing reply row
falls back to new). The composer emits the standard `-- ` delimiter above the
signature; rendering collapses the trailing signature behind a `···` control
(per-message expand; global "Always show signatures" preference, default off).

Contact card: built from reliable sources first — display name, correspondent
interaction facts (`first_seen_at`, `message_count`, `last_replied_at`),
domain colleagues, BIMI avatar. Signature extraction is read-time enrichment:
longest-common-suffix across 3+ messages (a diff, not NLP), high-precision
fields only (phone/url/email/handle), surfaced as **suggestions** — nothing is
written to `correspondent.details` without an explicit accept.

## Vacation auto-responder

`mailbox_vacation` per mailbox; responder in `@doota/mail-core/vacation`,
running at the inbound `vacation` stage (after spam/rules — junked mail never
gets a reply). RFC 3834: never replies to bounces (null return-path),
`Auto-Submitted` ≠ no, `Precedence: bulk/list/junk`, list headers, Bcc'd mail,
or our own forwards; always sends with `Auto-Submitted: auto-replied` (on
Cloudflare's header allowlist — this is what stops loops with other
responders). Note: a null outgoing envelope is not expressible through the
Email Service binding; Auto-Submitted carries the loop-prevention burden.
Dedupe: one reply per (mailbox, sender) per `interval_days` via KV TTL.
Ceilings: 30/hour, 200/day per mailbox (`vacation_*` counters), **plus** the
normal outbound limits — over-limiting is the safe direction.

## Spam

Tiers 1+2 + lists (tier 3 blinded Bayes is a follow-up):

1. Per-mailbox allow/block lists (`mailbox_sender_list`, `@domain` entries
   supported) — evaluated first. Moving mail out of Junk adds an implicit
   allow entry.
2. Tier 2 — correspondent reputation, **ham-only by construction**: replied-to
   sender → ham; any replied-to address on the domain → ham; previously seen →
   weak ham; **no row → strictly neutral** (a support inbox's legitimate mail
   is mostly from strangers; unfamiliarity must never read as spam).
3. Tier 1 — spam only on an **explicit** `dmarc=fail` in Cloudflare's
   Authentication-Results (captured in `InboundJob.authResults`; watch the
   debug log `in.auth_headers` on a real deployment to verify observed
   headers before tightening).

An explicit user-rule filing beats the classifier. Junk is a placement: it
suppresses notifications and vacation replies, and is never auto-deleted —
the daily cron **hides** (`hidden_at`) spam threads idle past 30 days.

## Export

`mail_export` job (rides the inbound queue, `kind: mailbox_export`): batches
of 50 deliveries per invocation, cursor in D1 (resumable), each batch an
encrypted R2 part object; finalisation writes a sidecar JSON (per-thread
placement/labels/assignee/snooze/muted). Format: mbox with `From_` separators,
RFC 4155 body escaping, and `X-Doota-Thread-Id/-Placement/-Labels/-Assigned-To/
-Snooze-Until` headers prepended — losslessly re-importable later without a
second format. Inbound messages export at raw-MIME fidelity (attachments
intact); outbound messages are synthesized RFC822 from the stored twin.

Security: starting an export and minting the download link both require a
session younger than 30 minutes (re-login otherwise); the capability URL
lives 15 minutes; **the download is plaintext by definition** (the UI says so
before starting); `mail_export` rows + `export.requested`/`export.downloaded`
logs are the audit trail.

## Import — deferred

Live IMAP pull is blocked by the platform (no inbound TCP on Workers). mbox
upload is **deferred on priority, not blocked** — it is a file upload feeding
the existing ingest pipeline. The export format above is designed to
round-trip through it when built.
