# Local-first thread mirror — design (slice 1)

Date: 2026-08-10
Status: approved (brainstorm), pending implementation plan

## Goal

Make the app feel **instant** on the two navigations that still round-trip the
server: **opening a thread** and **switching folder/mailbox**. Do it with a
persistent client-side SQLite (WASM) mirror kept live by the existing
`change_log`, so the UI reads locally instead of refetching.

This slice mirrors **only the thread list of the active mailbox**. Thread bodies
stay server-fetched (a later slice). It proves the whole pipeline —
persistence + delta sync + reactive local reads — on the lowest-risk surface.

### Non-goals (slice 1)
- No offline **compose/send** or any local write path. User actions keep going
  through today's remote functions; their `change_log` rows reconcile the mirror.
- No thread-body mirror (slice 2).
- No new encryption of local data — the mirror stores decrypted subject/snippet
  in plaintext (see Security posture).
- Not a general offline mode; "on-site realtime" is the primary freshness driver.

## Why this is small
The delta substrate already exists and is JMAP-shaped:
- `change_log` (trigger-written, per-mailbox `seq`) + `change_log_floor`.
- `changesSince(db, mailboxId, sinceSeq)` → `{ changes:[{seq,type,objectId,action}], newSeq, hasMore }`
  or `{ cannotCalculateChanges: true }` (resync-from-scratch signal).
- `MailEventHub` DO — hibernatable WebSocket, push-only, "subscribers re-read on
  event." Exactly the live trigger to pull a delta while the user is on-site.

The mirror layers on top; it does not reinvent sync.

## Architecture

Four single-purpose units under `apps/web/src/lib/client/localdb/` (+ two server
endpoints).

### 1. SQLite worker — `localdb/worker.ts`
Owns the DB file in a dedicated Web Worker (OPFS SyncAccessHandle must run off
the main thread). Runs `@sqlite.org/sqlite-wasm`. Message API:
- `open(userId)` — open/create the per-user DB, run migrations.
- `query(sql, params)` → rows.
- `applyDeltas(mailboxId, upserts, removals, newCursor)` — transactional.
- `seed(mailboxId, rows, cursor)` — bulk replace a mailbox's rows + cursor.
- `getCursor(mailboxId)` → number | null.
- `clear(userId)` — drop everything (logout / account switch).

**Tiered persistence, capability-detected, same query API above both:**
- **Tier 1 (preferred): `opfs-sahpool` VFS.** Incremental writes to disk; no
  manual snapshot. Chosen when SyncAccessHandle + sahpool install succeed. Uses
  the sahpool VFS specifically (not the `opfs` VFS), so it does **not** require
  COOP/COEP cross-origin isolation and won't break the cross-origin mail iframe,
  proxied images, or attachment viewer.
- **Tier 2 (fallback): memory VFS + debounced IndexedDB snapshot.** Universal
  (IndexedDB is everywhere). On mutate, debounce then `sqlite3_js_db_export()` →
  one IndexedDB blob; on `open`, `deserialize` it back. Whole-DB snapshot is
  cheap at slice-1 size (thread list, well under ~1 MB).
- Selection at `open`: try Tier 1; on any failure fall back to Tier 2. The rest
  of the codebase is VFS-agnostic. No network-only cliff.

### 2. Store facade — `localdb/index.ts`
Main-thread promise wrapper over the worker (Comlink-style or a small
request/response map). Plus a reactive read:
- `liveThreadList(mailboxId, folder)` → a `$state`-backed array that re-runs its
  local query when that mailbox's data mutates. Invalidation via a per-mailbox
  version signal bumped on `applyDeltas`/`seed`.

### 3. Sync engine — `localdb/sync.svelte.ts`
Orchestration, modeled as a **runed `FiniteStateMachine`**:
`idle → seeding → live → resyncing → error`.
- On mailbox open (`watch` on active mailbox): if local empty → `seeding`; else
  render-from-local + `resyncing` catch-up.
- Subscribe to the existing realtime stream (reuse `realtime-sync`); on each
  event → `resyncing` (pull delta from cursor).
- `useEventListener` for `visibilitychange` + `online` → catch-up on
  refocus/reconnect (covers missed events while hidden/offline).
- `Debounced` around snapshot + revalidation.
- `cannotCalculateChanges` → drop that mailbox's rows → `seeding`.

### 4. Server endpoints — `lib/rpc/localdb.remote.ts`
- `seedThreadList(mailboxId)` → `{ rows, cursor }`. Reuses the existing
  thread-list projection (already decrypts subject/snippet server-side); `cursor`
  is the `seq` snapshot at read time so there is no gap between seed and deltas.
- `threadChanges(mailboxId, sinceSeq)` → `{ upserts:[row…], removals:[id…], newSeq, cannotCalculate }`.
  Wraps `changesSince`, then **hydrates** changed thread ids into full thread-list
  rows (the log carries ids/actions; the client needs the data). One round-trip
  per delta. Both endpoints are mailbox-access-gated through the existing `can()`
  chokepoint.

## Data flow (thread list)
- **Open mailbox:** local empty → `seedThreadList` → bulk insert → save cursor →
  render. Local present → render instantly, then `threadChanges(cursor)` catch-up.
- **Folder switch:** pure local query on `placement` — instant, no network (one
  mailbox mirror covers all its folders).
- **Live (on-site):** realtime WS event → `threadChanges(cursor)` → apply
  upserts/removals → cursor advances → reactive query repaints.
- **Gap:** `cannotCalculate` → clear mailbox rows → reseed.
- **Read path:** local-first; if the store isn't ready (first paint, init
  failure), fall back to today's remote-function list. Safe degrade.
- **Optimistic actions:** existing optimistic UI also patches the local store, so
  the row updates immediately; the server delta is the reconciler.

## Client schema (SQLite)
```
thread_list(
  mailbox_id TEXT, thread_id TEXT, placement TEXT,
  subject_plain TEXT, from_name TEXT, snippet TEXT,
  last_message_at INTEGER, unread INTEGER, is_starred INTEGER,
  pinned_at INTEGER, labels TEXT,           -- JSON array
  PRIMARY KEY (mailbox_id, thread_id)
)
sync_state(mailbox_id TEXT PRIMARY KEY, cursor INTEGER)
```
Mirror of the server thread-summary shape. Decrypted fields stored plaintext.
Indexed by `(mailbox_id, placement, last_message_at)` for the list query.

## runed utilities (no hand-rolled equivalents)
- `FiniteStateMachine` — sync-engine lifecycle.
- `watch` — active mailbox/folder change → seed/catch-up.
- `useEventListener` — `visibilitychange` / `online` catch-up triggers.
- `Debounced` / `useDebounce` — snapshot + revalidation debounce.
- `PersistedState` — tiny UI state only, never the mirror.
(`resource` is runed 0.37+; installed is 0.23.4, so avoided — `watch` + facade
covers it.)

## Security posture
The mirror holds **decrypted** subjects/snippets in local persistent storage
(OPFS or IndexedDB) in **plaintext** — an owner decision, matching every native
mail client (Apple Mail, Outlook). Zero-access-at-rest remains a **server**
property (D1/R2 stay encrypted). Boundaries:
- **Per-user DB file**, namespaced by `userId`. Account switch (multiSession)
  swaps/clears the file; **logout clears it**.
- **Multi-tab:** guard writes with a Web Lock (leader tab) so two tabs can't
  corrupt the store.
- **Eviction tolerance:** OPFS/IndexedDB can be evicted under storage pressure;
  the mirror tolerates loss by reseeding (cursor-floor path already handles this).
- One-line note added to `reference/security` docs: local mirror = plaintext on
  device, cleared on logout.

## Testing
- **Unit — sync engine (the brain):** cursor advance, `cannotCalculate` → reseed,
  apply upserts/removals, ordering, FSM transitions. Fake worker + fake
  endpoints; deterministic vitest.
- **Server endpoints:** `seedThreadList` + `threadChanges` against the `makeDb`
  D1 harness (`changesSince` is already tested there). Cover hydrate, removals,
  floor/`cannotCalculate`.
- **Local SQL layer:** run `sqlite-wasm` in node (memory VFS) to test schema +
  queries (folder filter, upsert, removal, ordering).
- **OPFS/IndexedDB persistence + reactivity + tier fallback:** Playwright e2e
  (repo has an e2e smoke harness) + one manual device pass (iOS Safari). OPFS
  can't be unit-tested in node.

## Out of scope / future slices
- Slice 2: thread-**body** mirror (opening a thread instant); likely flips the
  default tier to `opfs-sahpool` when data size makes whole-DB snapshots costly.
- Local write path / offline compose + outbox.
- Full JMAP local store / cross-object sync.

## Open implementation details (resolve in the plan)
- Exact worker RPC shape (Comlink vs a hand-rolled postMessage map — prefer a
  tiny typed map to avoid a dep, unless Comlink is already present).
- Where the realtime subscription is shared (extend `realtime-sync` vs a sibling).
- Migration/versioning of the client schema (a `user_version` pragma + reseed on
  bump is enough for a mirror — no migration history needed since it's derived).
