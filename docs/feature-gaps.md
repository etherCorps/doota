# Feature gaps & roadmap

Where Doota stands as a mail client versus what a "complete" one carries, grounded
in a codebase scan (2026-08-02). Each gap notes what it is, why users expect it, a
rough implementation shape, and effort. Status legend: **present** · **partial** ·
**absent**.

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
`contact.remote.ts` exposes only `contactRecent` (a query over `correspondent`);
there is **no** managed store — no save/edit a contact, display name, company,
notes, or manual add of someone never emailed.
- **Shape:** a `contact` table (orgId/userId scoped) + CRUD RPC + a contacts view;
  recipient autocomplete unions managed + computed.
- **Effort:** medium.

### Attachment preview — *download-only*
Attachments serve decrypted but there's **no inline viewer** — no PDF/image/doc
preview; the user downloads to see them.
- **Shape:** inline image/PDF render in the sandboxed frame or a dedicated viewer
  route (PDF via `<embed>`/pdf.js, images inline). Reuse the signed-token +
  encrypted-serve path in `attachments/[id]`.
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
No "if from X → label/archive/forward." The single biggest expectation gap for
anyone coming from Gmail/Fastmail.
- **Shape:** a `mail_rule` table (org/user, ordered conditions + actions),
  evaluated in the inbound path (`queue-consumer` after materialize) — match on
  from/to/subject/list-id → apply label/placement/mark-read/forward. Keep the
  engine tiny and deterministic; no scripting.
- **Effort:** medium–large (engine + editor UI).

### 2. Vacation / auto-responder (out-of-office)
Auto-reply once per sender within a window.
- **Shape:** per-mailbox setting (enabled, window, message, once-per-sender
  dedupe) evaluated in the inbound path; send via the existing outbound queue.
  Must **not** reply to bulk/list mail (`List-*`, `auto-submitted`) — loop safety.
- **Effort:** medium (the loop/dedupe rules are the hard part, not the send).

### 3. Canned responses / snippets (user-facing)
The `templates/*.html` are **transactional auth emails** (verify, reset, invite),
and the service-account templates are for API sending — neither is a reply-snippet
inserted while composing.
- **Shape:** a `snippet` table (user/org, title + body), inserted from the
  composer.
- **Effort:** small.

### 4. IMAP / POP import
Can't pull mail from an external account — Doota only receives via Cloudflare
Email Routing.
- **Shape:** a separate importer (IMAP fetch → the same materialize path). Large,
  stateful (connection mgmt, incremental sync), and arguably out of the
  self-hosted-single-domain model.
- **Effort:** large. Lowest priority unless onboarding-from-Gmail is a goal.

### 5. PGP / S-MIME end-to-end encryption
Absent — **by design.** Doota's model is zero-access-at-rest + operator oversight,
not E2EE. Adding it is a philosophy change, not a feature.

### 6. Read receipts
Absent — **likely intentional** (privacy). Doota strips the reader signal (proxy).
Sending MDN requests would sit against that posture; receiving/honoring them even
more so. Leave out unless there's a concrete ask.

---

## Infra gaps (tracked elsewhere)

| Gap | Status | Ref |
| --- | --- | --- |
| **Re-materialize tool** | spec'd, not built — build on first render-logic change to live data. | `pre-release.md` §2 |
| **Draft-staged attachment encryption** | deferred, release-blocker — last plaintext content path. | `pre-release.md` §0.2 |
| **Remove R2 plaintext tolerance** | pre-release, fail-closed. | `pre-release.md` §0.1 |
| **Client remote-content banner sync** | cosmetic follow-up (enforcement already correct). | `remote-content.md` |

---

## Recommended order

**Product (quick wins first):** canned responses → attachment preview (images) →
bulk actions → rules/filters → vacation-responder → managed contacts → export.
Signatures and snooze — previously the top quick-wins — are **now shipped**;
rules/filters is the big-ticket item worth doing deliberately.

**Infra (before public release):** close the `pre-release.md` blockers (plaintext
tolerance, draft-attachment gap) — correctness/security, not features.

**Probably never (or by design):** IMAP/POP import, PGP/S-MIME, read receipts.
