# Feature gaps & roadmap

Where Doota stands as a mail client versus what a "complete" one carries, grounded
in a codebase scan (re-verified 2026-08-20). Each gap notes what it is, why users
expect it, a rough implementation shape, and effort. Status legend: **present** ·
**partial** · **absent**.

Verify before trusting: this file drifted badly once (it listed rules, vacation,
export, attachment preview and bulk actions as missing months after they shipped).
Check for an RPC surface in `apps/web/src/lib/rpc/` before believing a gap.

A planning doc, not a promise — order is a recommendation, not a schedule.

---

## Present / strong (no action)

| Feature | Evidence |
| --- | --- |
| **Labels** | broad support across the app. |
| **Search** | blind-token FTS, query parser, snippet shaping (`mail-core/search`, `search-query.ts`). |
| **Scheduled send + undo** | `submission.sendAt`/`undoUntil`, cron sweep past the queue's 12 h delay. |
| **Snooze** | `thread_state.snoozedUntil` (migration `0030`) + partial index (`0031`); `mail-core/snooze.ts`, `snooze-menu.svelte`, `thread.remote.ts`; the 5-min cron un-hides due threads. Snoozed view in the sidebar. |
| **Signatures** | `mailbox_signature` (migration `0029`, per user+mailbox HTML); `signature.remote.ts`; inserted into the composer. |
| **Shared mailboxes** | assignment, assigned-only access, internal notes with @mention. |
| **Calendar invites** | iMIP RSVP — `calendar_event` + `calendar_rsvp` tables, `invite-card.svelte`. |
| **Notifications** | durable `notification` log (cross-device read state) + Web Push (VAPID, hand-rolled Workers crypto) + installable PWA. See `notifications.md`. |
| **Contacts (recent)** | recipient autocomplete from the `correspondent` table (people you've mailed). |
| **Service accounts / API sending** | `POST /api/send`, hosted templates + WYSIWYG builder, two-tier send log, SDK, attachments. See `service-accounts.md`. |
| **Remote-content policy** | org mode/lock, per-user sender trust, server-enforced, always-proxied. See `remote-content.md`. |
| **Spam placement** | `thread_state` placement. |
| **Threading & quote handling** | forward-aware stripping, golden-standard raw-is-truth render. |
| **Encryption at rest** | subjects, bodies, attachments, outbound, render cache — see the caveat in `pre-release.md` §0.2 (draft-staged attachments). |

---

## Partial / needs finishing

### Contacts / address book — *computed, not managed*
`contact.remote.ts` exposes exactly one query (`contactRecent`, over
`correspondent`); `contact-card.remote.ts` reads a card and accepts a suggested
detail. There is **no** managed store — no save/edit, no display name, company or
notes, no manual add of someone never emailed. Autocomplete works; an address
book doesn't exist.
- **Shape:** a `contact` table (org/user scoped) + CRUD RPC + a contacts view;
  recipient autocomplete unions managed + computed.
- **Effort:** medium.

## Absent — the real product gaps

### 1. mbox import
Export round-trips by design (the `X-Doota-*` headers exist for exactly this) but
nothing consumes it, so a new self-hoster starts at zero mail. Live IMAP pull is
platform-blocked (Workers have no inbound TCP); mbox upload is not.
- **Shape:** browser-sliced upload into an R2 multipart object, then a resumable
  job with a **byte-offset** cursor riding the inbound queue by `kind`. Must skip
  `rulesEval`/`vacation`/`notify` — nobody wants auto-replies to five-year-old
  mail — and land archived under a dated label.
- **Effort:** medium–large. The upload is the hard part, not the parsing.

### 2. Canned responses / snippets
No `snippet` table, no RPC. The `template` surface is service-account API
sending, and `templates/*.html` are transactional auth mails — neither is a reply
snippet inserted while composing.
- **Shape:** a `snippet` table (user/org, title + body) and a composer picker.
  Trigger expansion (`;hours`) is a second pass.
- **Effort:** small.

### 3. IMAP / POP import
Blocked by the platform, not by priority — Workers cannot open inbound TCP. Out
of scope unless the deployment model changes.

### 4. PGP / S-MIME end-to-end encryption
Absent — **by design.** Doota's model is zero-access-at-rest plus operator
oversight, not E2EE. Adding it is a philosophy change, not a feature.

### 5. Read receipts
Absent — **by design.** Doota strips the reader signal (proxied images). Sending
MDN requests would sit against that posture; honoring them, more so.

## Infra gaps (tracked elsewhere)

| Gap | Status | Ref |
| --- | --- | --- |
| **Re-materialize tool** | spec'd, not built — build on first render-logic change to live data. | `pre-release.md` §2 |
| **Draft-staged attachment encryption** | **accepted, not a blocker** (2026-08-08) — transient, re-encrypted on send. The obligation was to footnote the encrypted-at-rest claim; done in the README. | `pre-release.md` §0.2 |
| **Remove R2 plaintext tolerance** | **done** — `unpackBlob` is encrypted-only and the test asserts a plaintext blob is rejected. | `pre-release.md` §0.1 |
| **Client remote-content banner sync** | cosmetic follow-up (enforcement already correct). | `remote-content.md` |

---

## Recommended order

**Product:** mbox import → snippets → managed contacts. Import first: it is the
only one that blocks a new self-hoster from having any mail at all.

**Infra (before public release):** the `pre-release.md` items — correctness and
accuracy, not features.

**Blocked or by design:** IMAP/POP pull, PGP/S-MIME, read receipts.
