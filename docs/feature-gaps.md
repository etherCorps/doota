# Feature gaps & roadmap

Where Doota stands as a mail client versus what a "complete" one carries, grounded
in a codebase scan (2026-07-28). Each gap notes what it is, why users expect it, a
rough implementation shape, and effort. Status legend: **present** · **partial** ·
**absent**.

This is a planning doc, not a promise — order is a recommendation, not a schedule.

---

## Present / strong (no action)

| Feature | Evidence |
| --- | --- |
| **Labels** | broad support across the app. |
| **Search** | blind-token FTS, query parser, snippet shaping (`search`, `search-query.ts`). |
| **Scheduled send + undo** | `submission` object, `undoUntil`, cron sweep past the queue's 12h delay. |
| **Shared mailboxes** | assignment, assigned-only access, internal notes with @mention. |
| **Calendar invites** | iMIP RSVP (`invite-card.svelte`). |
| **Spam placement** | `thread_state` placement. |
| **Web push + PWA** | new-mail / send-failed / mention push; installable PWA. |
| **Threading & quote handling** | forward-aware stripping, golden-standard raw-is-truth render. |
| **Encryption at rest** | subjects, bodies, attachments, outbound, render cache — no plaintext path. |

---

## Partial / needs finishing

### Contacts / address book — *computed, not managed*
`contact.remote.ts` exposes only `contactRecent` (a query); there is **no**
insert/update/delete. "Contacts" are derived on demand from the `correspondent`
table (people you've mailed). **Missing:** a managed store — save a contact, edit a
display name, group/company, notes, manual add of someone never emailed.
- **Shape:** a `contact` table (orgId/userId scoped) + CRUD RPC + a contacts view;
  recipient autocomplete unions managed + computed.
- **Effort:** medium.

### Attachment preview — *download-only*
Attachments serve decrypted but there's **no inline viewer** — no PDF/image/doc
preview; the user downloads to see them.
- **Shape:** inline image/PDF render in the sandboxed frame or a dedicated viewer
  route (PDF via `<embed>`/pdf.js, images inline). Reuse the signed-token +
  encrypted-serve path already in `attachments/[id]`.
- **Effort:** small (images) → medium (PDF/office).

### Bulk actions / multi-select — *unverified, likely thin*
No clear multi-select-then-archive/label/delete affordance found.
- **Shape:** selection state in the list + batch RPC (archive/label/trash over N
  thread ids).
- **Effort:** small–medium.

### Data export / portability — *absent for users*
No user-facing "export my mail" (mbox/EML). Raw RFC822 is in R2, so the data
exists; there's just no export path.
- **Shape:** an operator/user job that streams a user's R2 raws as an mbox/zip.
- **Effort:** medium.

---

## Absent — the real product gaps

Ordered by how much a real mail user misses them.

### 1. Rules / filters (auto-sort incoming)
0 references. No "if from X → label/archive/forward." The single biggest
expectation gap for anyone coming from Gmail/Fastmail.
- **Shape:** a `mail_rule` table (org/user, ordered conditions + actions), evaluated
  in the inbound path (`queue-consumer` after materialize) — match on
  from/to/subject/list-id → apply label/placement/mark-read/forward. Keep the
  engine tiny and deterministic; no scripting.
- **Effort:** medium–large (engine + editor UI).

### 2. Snooze
0 references. Hide a thread until a chosen time, then resurface in inbox.
- **Shape:** `thread_state.snoozedUntil` + the existing 5-min cron un-hides when due
  (same machinery as scheduled send). UI: snooze menu + a Snoozed view.
- **Effort:** small–medium (cron + placement already exist).

### 3. Vacation / auto-responder (out-of-office)
0 real references. Auto-reply once per sender within a window.
- **Shape:** per-mailbox setting (enabled, window, message, once-per-sender
  dedupe) evaluated in the inbound path; send via the existing outbound queue.
  Must **not** reply to bulk/list mail (`List-*`, `auto-submitted`) — loop safety.
- **Effort:** medium (the loop/dedupe rules are the hard part, not the send).

### 4. Email signatures
Absent (the only "signature" hits are a brand-hue comment + crypto). No per-user
/per-mailbox signature appended to composed mail.
- **Shape:** signature text/HTML on the mailbox or user, inserted into the composer
  on new/reply/forward; sanitized on the way out.
- **Effort:** small.

### 5. Canned responses / templates (user-facing)
Absent. The `templates/*.html` are **transactional auth emails** (verify, reset,
invite), not user reply snippets.
- **Shape:** a `snippet` table (user/org, title + body), inserted from the
  composer.
- **Effort:** small.

### 6. IMAP / POP import
Absent — can't pull mail from an external account. Doota only receives via
Cloudflare Email Routing.
- **Shape:** a separate importer (IMAP fetch → the same materialize path). Large,
  stateful (connection mgmt, incremental sync), and arguably out of the
  self-hosted-single-domain model.
- **Effort:** large. Lowest priority unless onboarding-from-Gmail is a goal.

### 7. PGP / S-MIME end-to-end encryption
Absent — **by design.** Doota's model is zero-access-at-rest + operator oversight,
not E2EE. Listed for completeness; adding it is a philosophy change, not a feature.

### 8. Read receipts
Absent — **likely intentional** (privacy). Doota strips the reader signal (proxy).
Sending MDN requests would sit against that posture; receiving/honoring them even
more so. Leave out unless there's a concrete ask.

---

## Infra gaps (tracked elsewhere)

| Gap | Status | Ref |
| --- | --- | --- |
| **Remote-content policy** | **done** — org mode/lock, server-enforced, admin UI. Client banner-sync is a cosmetic follow-up. | `remote-content.md` |
| **Re-materialize tool** | spec'd, not built — build on first render-logic change to live data. | `pre-release.md` §2 |
| **Draft-staged attachment encryption** | deferred, release-blocker — last plaintext content path. | `pre-release.md` §0.2 |
| **Remove R2 plaintext tolerance** | pre-release, fail-closed. | `pre-release.md` §0.1 |

---

## Recommended order

**Product (quick wins first):** signatures → snooze → canned responses →
attachment preview (images) → bulk actions → rules/filters → vacation-responder →
managed contacts → export. Signatures/snooze/canned are small and high-visibility;
rules/filters is the big-ticket item worth doing deliberately.

**Infra (before public release):** close the `pre-release.md` blockers (tolerance,
draft-attachment gap) — those are correctness/security, not features.

**Probably never (or by design):** IMAP/POP import, PGP/S-MIME, read receipts.
