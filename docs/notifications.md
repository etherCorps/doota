<!-- SPDX-License-Identifier: Apache-2.0 -->
# Notifications — design (pinned)

Durable notifications, in-app and OS-level. Two phases, **A then B** — A's
`notification` row is the single source of truth B's push payload reads from.
Both reuse the existing `MailEventHub` (hibernatable-WebSocket Durable Object in
`mail-jobs`) → `mailEvents` `query.live` → `RealtimeSync` → shared client bus. No
new transport.

**Timing.** Phase A is modest and ships **pre-release** — cross-device read state
is a real gap today (the bell is currently derived + a device-local
`localStorage` seen-set). Phase B (service worker + VAPID + push crypto) is
**post-release**.

---

## Phase A — persistent notification log (app-level, cross-device)

### Schema (`mail.schema.ts`, Drizzle)

`notification` — **structural refs only, no rendered text**:

| column | notes |
| --- | --- |
| `id` text pk | |
| `userId` fk user cascade | recipient |
| `orgId` fk cascade | for the active-org filter (below) |
| `type` text | `new_mail` \| `send_failed` \| `assigned` \| `mention` |
| `mailboxId` fk nullable | |
| `threadId` text nullable | |
| `submissionId` text nullable | `send_failed` |
| `actorUserId` fk nullable | the internal actor (`assigned`/`mention`); null for `new_mail` (sender is external) |
| `createdAt` int | |
| `readAt` int nullable | clicked |
| `seenAt` int nullable | bell opened |

**No `title`/`body` columns.** Display strings are rendered, not stored — storing
them means a migration+backfill to reword, and invites a subject line into a
zero-access design. Resolve at read time: `myNotifications` joins the thread's
latest `message.fromAddr`/`fromName` (both cleartext) and returns a computed
`senderName`; the client renders "New message from Alice". Push builds the same
string at **send** time from the same cleartext fields.

### Indexes (the lookups, spelled out)

The feed filters on `(userId, orgId)` (see cross-org), so the indexes carry
`orgId`, and the unread-partial can't double as the feed index (it excludes read
rows). Three:

- **Feed** — `(userId, orgId, createdAt desc)`, non-partial. Serves the paginated
  feed **including recently-read** rows.
- **Unread count** — partial `(userId, orgId) WHERE readAt IS NULL`. Stays tiny
  (read rows drop out); same `thread_state` trick.
- **Dedupe lookup** — partial `(userId, threadId) WHERE readAt IS NULL`. Every
  inbound recipient looks up an existing unread row for `(userId, threadId)`
  before insert; without it that's a scan per recipient (the `draft` table
  already cost 42.3k reads for exactly this). `threadId` is selective enough that
  `orgId` adds nothing here.

Drizzle: express the partial predicate via `.where(sql\`read_at is null\`)` in the
index builder.

**Open — does the panel show read rows?** If the panel *only ever* shows unread,
the non-partial feed index is unnecessary — the unread-count partial serves the
list too, and this drops to **two** indexes. Confirm panel behaviour before
building.

### Write points (server, where events originate)

- **new_mail** — `queue-consumer.ts` after `materializeDelivery`, batched insert,
  one row per recipient user of the mailbox. **Dedupe:** collapse a reply burst
  per `(userId, threadId)` — if an unread `new_mail` row exists, bump its
  `createdAt` and keep it unread instead of inserting N rows.
  **assigned-only grantees** (`mailbox_access.assignedOnly && !canManage`, via
  `assignedOnlyFor`): skip `new_mail` for threads **not** assigned to them (they
  can't open those); they get an `assigned` notification when a thread lands on
  them instead.
- **assigned** — `collab.ts` `assignThread` → row for the assignee, `actorUserId`
  = the assigner.
- **send_failed** — `applyBounce` / outbound fail → row for `createdByUserId`.
- **mention** — enum reserved, **not wired** (feature doesn't exist yet).

### Read / mark API (`notification.remote.ts`, Drizzle builder only)

- `myNotifications({ cursor })` — paginated feed, newest first, **filtered to the
  active org** (see cross-org).
- `unreadNotificationCount()` — badge.
- `markNotificationsSeen()` — bulk, on bell open.
- `markNotificationRead(id)` — on click.
- All scoped to `locals.user.id`.

### Cross-org behaviour (pinned)

`multiSession` means a user can hold mailboxes across served domains. **The bell
shows the active org only** — `myNotifications` + the unread count filter on the
active `orgId`. One-line filter now; an awkward retrofit later.

**"Unread elsewhere" affordance.** Active-org-only means a two-org user can sit
unaware of notifications in the other org. Cover it cheaply: a faint dot on the
org switcher when `unreadNotificationCount` is non-zero for any non-active org.
Cheap now; annoying to add once the count query is org-scoped everywhere.

### Live + panel

- Hub emits a thin `notification` event (`{ userId, id }`); `RealtimeSync` bumps
  the bell.
- Rewrite `notification-panel.svelte` to read `myNotifications` — drop the
  `localStorage` seen-set and the `recentUnreadMail`/`failedSends` derivation.
  Read state is server-owned (cross-device).

### Cost / hygiene

- +1 D1 write per inbound recipient; the `(userId, threadId)` dedupe collapses
  bursts. Indexed, batched.
- Pruning: **daily cron, folded into the sweep already needed for `draft`
  tombstones** — one scheduled `mail-jobs` job, both tables. Drop
  `readAt < now-30d`. (Not lazy-on-read — that leaves inactive users' rows
  growing forever.)

---

## Phase B — Web Push (OS-level, app closed)

### Keys / secrets

- One VAPID keypair. Public key → client (build-time public var). Private key +
  subject → `mail-jobs` secrets (`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`). **Never**
  in dashboard-plaintext vars (they get wiped on deploy — see
  `cloudflare-vars-deploy-wipe`).

### Service worker (`apps/web/src/service-worker.ts`, SvelteKit-native)

- `push` → `showNotification(title, { body, tag, data:{ url } })`; `tag` per
  thread so replies collapse.
- `notificationclick` → focus an existing client on that URL else `openWindow`.
- **Open-tab dedupe:** in `push`, `clients.matchAll({ type:'window' })`; if a
  focused, visible client exists, **suppress** `showNotification` — the in-tab
  `osNotify`/chirp handles it. Push covers closed/backgrounded only.

### Subscription store

`pushSubscription`: `id, userId fk cascade, endpoint (unique), p256dh, auth,
userAgent, createdAt, lastSeenAt`.

- Subscribe on the existing permission gesture (`enableOsNotifications`) →
  `pushManager.subscribe({ applicationServerKey })` → `savePushSubscription`
  command, upsert on `endpoint`.
- Re-subscribe on `pushsubscriptionchange`. Unsubscribe on logout.
- **Prune** endpoints returning **404/410** on send; drop `lastSeenAt > 90d` in
  the same daily cron.

### Send path (`mail-jobs`, at inbound)

- Where the hub is already notified, also load recipients' `pushSubscription`
  rows and send a Web Push per endpoint.
- Payload = **structural only** (title/body/url), built from cleartext
  `fromAddr`/`fromName` — same rule as A.
- **Crypto: use a pinned, Workers-compatible library** (VAPID ES256 JWT +
  aes128gcm ECDH). Hand-rolling is ~150 lines where a subtle error means silent
  delivery failure, and sits badly against the security posture. Pin the version;
  vendor it if zero supply-chain surface is wanted.

### iOS caveat (state it — don't overpromise)

iOS Safari delivers Web Push **only to installed PWAs**, not regular tabs.
Desktop browsers are fine; iPhone users must **add Doota to the home screen**
first. "Works with the app closed" is desktop-everywhere, iOS-only-if-installed.

---

## Deploy scope

- Migrations via `pnpm db:generate`: `notification` (A), `pushSubscription` (B).
- **A** → web + `mail-jobs` (write points in `queue-consumer`/`collab`) +
  `mail-inbound`.
- **B** → adds the SW (web) + VAPID secrets + send path (`mail-jobs`).
