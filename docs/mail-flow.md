# Mail pipeline: inbound, outbound, threading

How a message becomes rows, how rows become threads, and how a reply becomes a
wire email. Written from a code walkthrough on 2026-07-22; file:line references
point at `packages/mail-core/src/` unless noted. Known issues are at the bottom,
ranked.

## Data model (the four core tables)

| Table | Scope | Meaning |
| --- | --- | --- |
| `message` | one per `(orgId, messageIdHeader)` | Shared, immutable. Same email delivered to 5 org mailboxes = **1 row**. Encrypted content (subject / stripped / full / html), cleartext routing metadata (from, to, cc, In-Reply-To, References). |
| `thread` | org-level | `subjectNormalized` + `lastMessageAt`. No participants of its own — derived from member messages. |
| `delivery` | per `(message, mailbox, role)` | "This mailbox received/sent this message as to/cc/bcc/from." Bcc exists **only** here, never in stored headers. |
| `thread_state` | per `(thread, mailbox)` | Placement (inbox/sent/archived/spam/trash), `hiddenAt` (soft empty-folder). One thread can sit in different folders per mailbox. |

Plus outbound bookkeeping: `submission` (one send attempt: status, undoUntil,
idempotencyKey, provider ids) and `submission_recipient` (per-address status →
delivery ticks).

## Inbound flow

**Stage 1 — receipt** (`inbound-worker.ts:57 handleEmail`, `doota-mail-inbound`
Worker, Email Routing catch-all target). Bucket-first, accept-and-enqueue: do the
minimum so a processing outage never loses mail.

1. `resolveRecipient` (`resolver.ts:49`) — D1 only, never the CF API: org domain
   match → strip `+tag` if subaddressing enabled → active mailbox, else enabled
   alias → its active mailbox. Unknown/disabled → `setReject` (clean bounce,
   nothing stored).
2. Buffer raw, put to R2 at `raw/{orgId}/{safe(Message-ID) | sha256(raw)}` —
   content-stable key, redelivery overwrites identical bytes.
3. Enqueue `InboundJob` (r2 key, recipient, resolved mailbox, alias, tag,
   envelope from). No parsing here.

Email Routing invokes once **per recipient** of the same email — expected; the
consumer dedupes by Message-ID.

**Stage 2 — processing** (`queue-consumer.ts:88 handleQueue`, same Worker's queue
consumer). Idempotent; any error retries the whole job.

1. Fetch raw from R2 (gone → ack, nothing to reconstruct), parse with
   postal-mime (Workers-compatible; not Node mailparser).
2. **Bounce short-circuit**: `looksLikeBounce` (envelope from, return-path
   domain, subject heuristics) → `applyBounce` updates submission recipients +
   suppressions and acks. DSNs never land in an inbox.
3. `materializeMessage` (`materialize.ts:109`) — upsert by
   `(orgId, messageIdHeader)`; first writer creates, later recipients of the
   same email reuse. Create path: resolve thread (below), strip quotes
   (`stripQuotesText`), derive `contentKind` (bubble ≤800 chars, else card),
   encrypt subject/stripped/full/html, insert with `onConflictDoNothing` (create
   race → re-read winner). Always: bump `thread.lastMessageAt`, rewrite
   attachment metadata rows (bytes stay in the R2 raw), index search tokens.
4. Role derivation (`queue-consumer.ts:52 deriveRole`): envelope recipient
   (tag-stripped) in parsed To → `to`, in Cc → `cc`, in neither → `bcc`.
5. `materializeDelivery` (`materialize.ts:286`): delivery row
   (conflict-ignored), alias `lastUsedAt` bump, then `ensureThreadState` with
   inbound placement policy: new thread → `inbox`; reply to an `archived`
   thread → un-archive; `spam`/`trash` respected (a reply never resurrects what
   the user killed).

## Threading (`resolveThreadId`, `materialize.ts:50`)

1. **Headers win.** `resolveParentMessageId` = last id of In-Reply-To, else last
   of References (`mail-thread-contract.ts:133`). Parent found by
   `(orgId, messageIdHeader)` → its thread.
2. **Weak fallback**: normalized subject (Re:/Fwd:/AW:/SV: prefixes stripped,
   whitespace collapsed, lowercased) matches a thread in-org with
   `lastMessageAt` in the last **7 days**, **and** the new message shares ≥1
   participant (from/to/cc) with a message already in that thread. Subject alone
   never merges — two unrelated "Re: invoice" threads must not collapse.
3. Else create a thread.

All threading reads cleartext metadata — no decryption on the hot path.

## Outbound flow

**Stage 1 — enqueue** (`outbound.ts:74 enqueueSend`, runs in the web Worker from
send/draft remote functions). Ordering rule: submission row first, queue job
second — that is what makes redelivery safe.

1. Idempotency-key dedupe: repeated key returns the existing send.
2. Mint our own Message-ID `<uuid@domain>` (`mintMessageId`) and build
   In-Reply-To/References from the parent row (`threadingHeaders` — parent's
   References chain + parent's id, RFC 5322).
3. Stage `{text, html}` JSON in R2 at `outbound/{orgId}/{uuid}` — canonical body
   for the consumer (html survives; D1 keeps only encrypted columns).
4. **Same materialize seam as inbound**: message row stores what the sender
   wrote (a bubble — quoted history is wire-only), sender's delivery role
   `from`, placement policy sent-and-never-yank (new thread → `sent`; a reply
   leaves the thread wherever it sits).
5. Submission (`queued`, `undoUntil` = max(sendAt, now + undo window)) +
   per-recipient rows.
6. Queue job with `delaySeconds` = the hold. Beyond the queue's 12 h max delay
   the job is **not** enqueued — the 5-min cron sweep (`sweepDueSubmissions`)
   enqueues due submissions later. Double-enqueue is harmless (consumer
   idempotent).

Undo (`cancelSend`): flips `queued → canceled` while `undoUntil` is in the
future. The row is authoritative, not the queue delay — an in-flight job re-reads
status and acks without sending.

**Stage 2 — consumer** (`outbound-consumer.ts:80 processSubmission`,
`doota-mail-jobs`).

1. Re-read submission: missing/canceled/terminal → ack. Fired early → re-hold
   via `retry({delaySeconds})`. Else `status = sending`, attempts++.
2. **Preflight** (permanent fail, no retry): sending user still has the grant
   (`can(send)`), org active, from-domain owned by org, alias enabled + owned.
   From display name: alias label **only** for alias sends (hide-my-email must
   not leak the real name), else mailbox displayName, else user name.
3. **Classify recipients**: already sent/terminal → skip (redelivery safety);
   suppressed → `dropped` with reason (recorded, not silently lost);
   **internal (resolves to same org)** → `materializeDelivery` straight into the
   recipient's mailbox with inbound placement — no SMTP round-trip — recipient
   status `delivered`; the rest → external.
4. Rate limit (`chargeSend`) on external count only; over → permanent fail.
5. **Wire build + send**, chunks of 50:
   - `buildBody`: R2-staged text/html; if a reply, re-quote the parent
     (`buildQuotedText` — `>`-prefixed + "On … wrote:";
     `buildQuotedHtml` — `<blockquote class="gmail_quote">`, the exact container
     inbound quote-stripping recognizes, so round-trips stay symmetric).
   - `extractInlineImages`: pasted base64 `data:` images → CID inline
     attachments (providers strip data URIs).
   - Attachments loaded from R2, buffered, base64'd (binding can't serialize
     ArrayBuffer).
   - Provider seam (`provider.ts`): Cloudflare Email Service via `EMAIL_SENDER`
     binding. Only In-Reply-To/References/X-* headers pass the filter;
     **Message-ID is rejected by CF and set by them** (see issue 1). Errors →
     `ProviderSendError` with `permanent` flag classified by message regex.
   - Soft error → whole job retries with 30 s backoff, cap 5 attempts.
     Permanent → chunk's recipients `failed`, continue with the rest.
6. `rollup`: any sent/delivered → submission `sent`; all-terminal-none-failed
   (internal-only or fully suppressed) → still `sent` (a deliberate drop is not
   a failure); else `failed`. DSN bounces later flip individual recipients
   (`bounce.ts`) → WhatsApp-style ticks (`tickForStatus`: clock/single/double/
   warning).

## Reply construction contract

- The UI keys replies on **`MessageDTO.messageIdHeader`** (RFC header id), never
  the row id.
- Stored copy = the bubble (new text only). Quoted history exists **only on the
  wire**, rebuilt by the consumer from the parent's `bodyFullEnc`.
- Reply-all audience comes from the stored `to`/`cc`/`replyTo` of the parent.
- `viaAliasId` on the delivery lets a reply default its From to the alias the
  mail arrived through — otherwise hide-my-email leaks the real address on the
  first reply.

## Known issues (ranked)

1. **Cloudflare rewrites Message-ID — the big one.** The binding rejects a
   custom `Message-ID` header and mints its own (`provider.ts:63`), but D1
   stores *our* minted id. External replies therefore carry
   `In-Reply-To: <CF's id>`, which matches nothing — threading survives only on
   the weak subject+participant fallback. Reply after 7 idle days, or with an
   edited subject → new thread. Also breaks reflection dedupe: send to a mailing
   list containing one of our own hosted addresses → the reflected copy carries
   CF's id → duplicate message in the thread. **Fix direction**: store the
   provider's `res.messageId` as an additional lookup key on the message row
   (second indexed column checked by `resolveParentMessageId`'s consumer), or
   move to raw-MIME sending when Email Service allows owning Message-ID.
2. **Chunking breaks visible headers for >50 recipients**
   (`outbound-consumer.ts:240`): each chunk's wire To/Cc contains only that
   chunk's subset, so recipients in different chunks see different To lists and
   reply-all fractures. Headers should carry the full visible list and only the
   envelope should chunk — the CF binding ties envelope to headers, so until
   that's possible, consider capping a send at 50 external recipients.
3. **No dead-letter queue.** Both consumers: `max_retries: 5`, no
   `dead_letter_queue` in the wrangler configs. Inbound jobs that fail 5× (bad
   deploy, wrong MAIL_DEK) are silently dropped — the raw stays in R2 but
   nothing re-processes it. Add a DLQ, or a repair cron that diffs
   `raw/{org}/…` keys against `message.r2RawKey`.
4. **Concurrent double-send race.** Idempotency = re-read status, but
   `queued → sending` is unconditional (`outbound-consumer.ts:101`, `where id`
   only). A sweep-enqueued duplicate delivered concurrently with the delayed
   job can have both invocations pass the terminal check and both hit the
   provider. Cheap fix: conditional UPDATE (`... where id = ? and status =
   'queued'`) and bail when 0 rows changed — D1's single-writer makes that an
   effective lock.
5. **Retries double-charge the rate limit** (`outbound-consumer.ts:212`):
   `chargeSend` runs on every attempt for still-unsent externals; a soft
   provider failure retried 5× charges 5× quota for one send. Charge once
   (flag on the submission) or refund on the retry path.
6. **`thread.lastMessageAt` can move backwards** (`materialize.ts:224`
   `bumpThread` sets unconditionally from the message Date header). A
   late-delivered or date-forged old message drags the thread down the list.
   Use `max(existing, incoming)`.
7. **Forged Message-ID suppression.** Inbound dedupe trusts the sender-supplied
   header: an attacker reusing an existing `(orgId, messageIdHeader)` gets their
   new content deduped away — the victim's delivery row points at the *old*
   message and the new content exists only in R2. Mitigation: on id collision
   with a different raw content hash, treat as new (suffix the key).
8. **Replying to your own sent message loses the chain on the wire.** Outbound
   rows store bubble-only bodies, and `buildBody` quotes the parent's
   `bodyFull` — for an outbound parent that's just the sender's last text, so
   the external recipient sees one quote level, not the history. (Inbound
   parents are fine — their `bodyFull` includes their own quoted chain.)
9. **Minor / cosmetic**
   - `buildQuotedHtml` escapes the parent as plain text — a rich-HTML parent's
     formatting is lost in the quote.
   - Mailing-list deliveries classify as role `bcc` (envelope recipient absent
     from To/Cc headers) — cosmetic mislabel.
   - Canceled sends leave the message row + Sent thread_state behind (thread
     shows in Sent with a warning tick).
   - `writeAttachments` is delete-then-insert — concurrent redelivery of the
     same message can duplicate attachment rows briefly.
   - Attachments are fully buffered and base64-expanded in memory (~2.3× file
     size) — very large attachments can press Worker memory / RPC size limits.
   - `outbound/{org}/{uuid}` R2 staging blobs: verify the cron GC covers them,
     else growth is unbounded.

Nothing above is urgent at current scale (single org, small recipient lists).
Priority order if picked up: **1** (threading corrupts permanently) and **3**
(mail lost silently), then 4/5.
