<!-- SPDX-License-Identifier: Apache-2.0 -->
# Notifications — durable log + web push (shipped)

Status: **both phases shipped.** Written from a code walkthrough 2026-08-02;
file:line references point at `packages/mail-core/src/` and `apps/web/src/` unless
noted.

Two layers, both live:

- **Phase A — durable notification log.** A `notification` row per event, the
  single source of truth for the in-app bell (cross-device read state).
- **Phase B — Web Push.** OS-level push to closed/backgrounded tabs, built on the
  same rows and a hand-rolled Workers-compatible push crypto module.

Both reuse the existing realtime path: `MailEventHub` (hibernatable-WebSocket
Durable Object in `mail-jobs`) → `mailEvents` `query.live` → `RealtimeSync` →
shared client bus. No new transport. Push is *additive* — it fires from the same
`record*` calls that write the log row, so the bell and the OS notification never
diverge.

---

## Data model (`packages/db/src/mail.schema.ts`)

### `notification` — structural refs only, no rendered text

| column | notes |
| --- | --- |
| `id` text pk | |
| `userId` fk user cascade | recipient |
| `orgId` fk cascade | active-org filter (see cross-org) |
| `type` text | `new_mail` \| `send_failed` \| `assigned` \| `note` \| `mention` |
| `mailboxId` text nullable | |
| `threadId` text nullable | |
| `submissionId` text nullable | `send_failed` |
| `actorUserId` fk nullable | internal actor (`assigned`/`note`/`mention`); null for `new_mail` (sender is external) |
| `createdAt` int | |
| `readAt` int nullable | clicked / thread opened |
| `seenAt` int nullable | bell opened |

**No `title`/`body` columns.** Display strings are *rendered at read time*, never
stored — storing them would mean a migration+backfill to reword, and would drag a
subject line into a zero-access design. `myNotifications` joins the thread's
latest `message.fromAddr`/`fromName` (both cleartext) and returns a computed
`senderName`; the client renders "New message from Alice". Push builds the same
string at send time from the same cleartext fields.

**Indexes (three):**

- **Feed** — `(userId, createdAt desc)`, non-partial. Serves the paginated feed
  including recently-read rows.
- **Unread count** — partial `(userId) WHERE readAt IS NULL`. Stays tiny (read
  rows drop out) — the badge query.
- **Dedupe** — unique partial `(userId, threadId) WHERE readAt IS NULL AND
  type = 'new_mail'`. A reply burst collapses onto one unread row per
  `(userId, thread)` instead of N inserts, and the uniqueness makes the collapse
  race-safe.

### `pushSubscription`

`id, userId (fk cascade), endpoint (unique), p256dh, auth, userAgent, createdAt,
lastSeenAt`. One row per browser/device push endpoint; `endpoint` unique so a
re-subscribe upserts.

---

## Phase A — the log

### Write points — `packages/mail-core/src/notify.ts`

`notify.ts` is the single source of truth. Every writer is **best-effort**
(`tryLog`-wrapped) — a notify failure never fails the mail operation that
triggered it — and each takes an optional `push?: WebPushEnv` so the OS push
fires from the same call (Phase B). Exports: `recordNewMail`, `recordSendFailed`,
`recordAssigned`, `recordNote`, `recordMention`, `markThreadNotificationsRead`,
`pruneStaleNotifications`.

| type | fired from | notes |
| --- | --- | --- |
| `new_mail` | `queue-consumer.ts:314` (`recordNewMail`, after `materializeDelivery`) + `outbound-consumer.ts:275` (internal same-org send lands in a mailbox) | one row per recipient user of the mailbox; **dedupe** collapses a reply burst per `(userId, threadId)` onto the existing unread row (bump `createdAt`, stay unread). **assigned-only grantees** skip `new_mail` for threads not assigned to them (they can't open those) and get an `assigned` row instead. |
| `send_failed` | `bounce.ts:192` (DSN/complaint path) + `outbound-consumer.ts:163` (send failure) | row for the submission's sender; tagged per submission so distinct failures don't collapse. |
| `assigned` | `collab.ts:106` (`assignThread`) | row for the assignee, `actorUserId` = assigner. |
| `note` | `notes.ts:110` (`createNote`) | thread participants notified of a new internal note. |
| `mention` | `notes.ts:129` (`recordMention`) | `createNote` parses `@username` mentions, resolves those who can access the mailbox, one row + push per mentioned user; `actorUserId` = note author. |

### Read / mark API — `apps/web/src/lib/rpc/notification.remote.ts`

Drizzle builder only, all scoped to `locals.user.id`:

- `myNotifications(offset)` — paginated feed, newest first, **filtered to the
  active org**, with sender/actor name resolved from cleartext fields.
- `unreadNotificationCount()` — badge; served by the unread partial index.
- `markNotificationsSeen()` — bulk, on bell open (stamps `seenAt`).
- `markAllNotificationsRead()` — bulk clear `readAt`.
- `markNotificationRead(id)` — single, on click.
- `markThreadNotificationsRead()` — thread-level clear, called when a thread is
  opened (so opening mail clears its bell entries; also in `notify.ts` for the
  server side).

### Cross-org behaviour (pinned)

`multiSession` lets a user hold mailboxes across served domains. **The bell shows
the active org only** — `myNotifications` + the unread count filter on the active
`orgId`. One-line filter now; an awkward retrofit later. Follow-up (cheap, not
yet built): a faint dot on the org switcher when any non-active org has unread.

### Panel — `apps/web/src/lib/components/app/notification-panel.svelte`

Reads `myNotifications()` on open; renders all five types; badge reflects
`unreadNotificationCount()` and refetches on inbound / notification / send-state
realtime events. Optimistic read + server sync. **No `localStorage`** — read
state is server-owned and therefore cross-device (the old device-local seen-set
is gone). The hub emits a thin `notification` event (`{ userId, id }`);
`RealtimeSync` bumps the bell without a poll.

### Hygiene

- +1 D1 write per inbound recipient; the `(userId, threadId)` dedupe collapses
  bursts; indexed + batched.
- `pruneStaleNotifications` drops `readAt < now-30d`, folded into the daily
  `mail-jobs` cron sweep (same job as `draft` tombstones — not lazy-on-read,
  which would let inactive users' rows grow forever).

---

## Phase B — Web Push

### Crypto — `packages/mail-core/src/web-push.ts` (hand-rolled, Workers-native)

No npm push library (most pull Node built-ins that don't run on Workers). The
module implements the two specs directly with WebCrypto:

- **VAPID** — ES256 JWT signing (RFC 8292).
- **Payload encryption** — `aes128gcm` ECDH (RFC 8291 / 8188).

Exports:

- `sendWebPush(env, sub, payload, subject)` → HTTP status; a **404/410 prunes**
  that subscription.
- `sendPushToUser(db, env, userId, payload, subject)` — fans out to all of a
  user's subscriptions.
- `pruneStalePushSubscriptions()` — 90-day-inactivity sweep (daily cron).

Payload is **structural only** (title/body/url built from cleartext
`fromAddr`/`fromName`) — the same zero-access rule as the log row. Send is
best-effort (`.catch(() => {})`) everywhere it's wired.

### Keys / secrets

One VAPID keypair, generated by `scripts/gen-vapid-keys.mjs` (P-256 ECDSA,
base64url out):

| var | where | kind |
| --- | --- | --- |
| `VAPID_PUBLIC_KEY` | web (client subscribes with it), mail-jobs, mail-in | plaintext var (safe to expose) |
| `VAPID_PRIVATE_KEY` | mail-jobs, mail-in | **secret** — never a dashboard plaintext var (deploy-wiped; see [`cloudflare-vars-deploy-wipe`](../pre-release.md)) |

`pushPublicKey()` (`notification.remote.ts`) hands the public key to the client;
returns `""` when unconfigured, so push silently no-ops on an instance that
hasn't set up VAPID.

### Service worker — `apps/web/src/service-worker.ts` (SvelteKit-native)

- `push` (`onPush`, ~L52) → `showNotification(title, { body, tag, data:{ url } })`;
  `tag` per thread so replies collapse into one OS notification.
- `notificationclick` → focus an existing client on that URL else `openWindow`.
- Precaches the immutable build + static files (the SvelteKit `version`
  invalidates old precache on the next load).

### Subscription lifecycle — `notification.remote.ts`

- `savePushSubscription(endpoint, p256dh, auth, userAgent)` — upsert on
  `endpoint`, stamps `lastSeenAt`. Only a server-accepted persist counts as
  enabled. Client gesture: `Notification.requestPermission()` → `serviceWorker.ready`
  → `pushManager.subscribe({ applicationServerKey: VAPID public })` → extract
  `p256dh`/`auth` → post here.
- `deletePushSubscription(endpoint)` — logout / opt-out.
- Prune: 404/410 on send (immediate) + `lastSeenAt > 90d` in the daily cron.

### iOS caveat (state it, don't overpromise)

iOS Safari delivers Web Push **only to installed PWAs**, not regular tabs. Desktop
browsers are fine; iPhone users must **add Doota to the home screen** first.
"Works with the app closed" is desktop-everywhere, iOS-only-if-installed. (The
native Tauri shell — `apps/native` — is a separate delivery path and doesn't use
Web Push.)

---

## Deploy scope

- Migrations: `notification` + `pushSubscription` are already applied (part of the
  34-migration set through `0033`).
- Secrets/vars per env: `VAPID_PUBLIC_KEY` (all three mail-touching Workers),
  `VAPID_PRIVATE_KEY` (mail-jobs + mail-in). Generate with
  `node scripts/gen-vapid-keys.mjs`.
- Write points live in `mail-jobs` (`queue-consumer`, `outbound-consumer`,
  `bounce`) and web (`collab`, `notes` via remote functions); the SW ships with
  the web build.

## Known follow-ups (ranked)

1. **Cross-org unread dot** — active-org-only feed means a two-org user can sit
   unaware of the other org's notifications. Add the org-switcher dot (cheap now,
   awkward once the count query is org-scoped everywhere).
2. **Push delivery is fire-and-forget** — a transient push-service 500 (not
   404/410) is swallowed; the bell still catches up on next open, but that one OS
   notification is lost. Acceptable; a retry queue is the upgrade path.
