# Thread-timeline mirror — design (slice 3, true offline)

Date: 2026-08-11
Status: approved (brainstorm), pending plan
Builds on: slice 2 (`2026-08-11-thread-message-mirror-design.md`). Slice 2 was an
accelerator (mirror supplied `framedHtml`; `openThread` stayed the timeline
authority). Slice 3 makes **the mirror drive the whole timeline** so a thread
opens fully — messages, notes, and system events — with no network.

## Goal
Open a thread entirely from the local mirror: the full ordered timeline
(external messages + internal notes + system events), rendered offline, with
`openThread` demoted to first-open seed + revalidation fallback.

## Decisions (owner-approved)
- **Unified `thread_item` table** — one client table storing every timeline item
  (message/note/system) as `item_type` + JSON `payload` + `seq` (+ `framed_html`
  for message items). Replaces slice-2's message-only table.
- **Revalidate the whole thread on open + realtime** — notes/system have no
  incremental `change_log` delta, so on open and on any realtime event for the
  open thread, re-fetch the full `seedThread` DTO and replace the mirrored
  timeline. (This supersedes slice-2's incremental `threadMessageChanges` for
  timeline freshness — see Trade-off.)

## Architecture (deltas from slice 2)

### Client schema (`localdb/schema.ts`)
Replace the `message` table with:
```
thread_item(
  thread_id TEXT NOT NULL,
  item_id TEXT NOT NULL,          -- item.id (message id / note id / event id)
  seq INTEGER NOT NULL,           -- position in the timeline
  item_type TEXT NOT NULL,        -- external_message | internal_note | system_event
  payload TEXT NOT NULL,          -- JSON.stringify(TimelineItem) — opaque, app renders it
  framed_html TEXT,               -- server-built framed doc (message items, rich, images-off); null otherwise
  PRIMARY KEY (thread_id, item_id)
);
CREATE INDEX thread_item_order ON thread_item (thread_id, seq);
```
`thread_synced(thread_id, cursor, render_version)` stays. `item_to_row`/`row_to_item`
marshal the opaque `TimelineItem` JSON + attach `framedHtml` for message items.

### Server (`thread-localdb.ts`, `thread.remote.ts`)
- `buildSeedThread` (extend): return the **full** `getThread` timeline — NOT
  filtered to `external_message`. Each item → `MirroredItem = { itemId, seq, itemType, payload: TimelineItem, framedHtml: string | null }`. Message items keep the `renderFramedBody` (images-off) call; notes/system carry `framedHtml: null`.
- **Drop** `threadMessageChanges` from the timeline path (revalidate-whole
  supersedes it). Keep it exported only if a later slice re-wires an incremental
  optimization; otherwise remove to avoid dead code.
- `seedThread` wrapper unchanged in signature (gates via `assertMailboxAccess`).

### Worker (`worker.ts`)
- `seedThreadItems({ threadId, items, cursor, renderVersion })` — replace all rows
  for the thread + set `thread_synced`.
- `listThreadItems({ threadId })` → `TimelineItem[]` (ordered by seq; message items
  get `framedHtml` attached from the row).
- `getThreadSync` unchanged. Remove `applyMessageDeltas`/`listMessages` (replaced).

### Facade (`index.svelte.ts`)
- `liveThread(getThreadId)` → `{ current: TimelineItem[] }` — the FULL ordered
  timeline (message items carry `framedHtml`). Version bumped on `seedThreadItems`.
- Methods: `seedThreadItems`, `listThreadItems`, `getThreadSync`.

### Sync (`sync.svelte.ts`)
- `ensureThread(threadId)`: if not mirrored OR render_version drift → seed (full
  DTO). If mirrored → **revalidate**: re-fetch `seedThreadFn` and `seedThreadItems`
  (replace). No incremental delta path.
- `onThreadRealtime(threadId)`: revalidate (re-seed) the open thread.
- Separate `threadFsm` reused; per-thread busy guard reused.

### Thread-view wiring (`+page.svelte`)
- **The mirror drives the timeline.** When `liveThread.current.length > 0` for the
  open thread, render `thread.items` FROM the mirror (full timeline incl. notes +
  system). Else render from `openThread` (first open, not-yet-seeded, SSR,
  `localReady` false — the fallback). Message items still render via `srcdoc` from
  the item's `framedHtml`; notes/system render with the existing app components.
- `openThread` still fires (first-open + revalidation source); its result feeds the
  seed. Once mirrored, the visible timeline comes from `liveThread`.
- Realtime event for the open thread → `onThreadRealtime` (revalidate).

## Trade-off (revalidate-whole)
Re-seeding re-renders every message's `framedHtml` server-side (R2 + sanitize +
frame per message) on each revalidation. For lazy per-thread + typical thread
sizes this is fine. `ponytail:` note the cost + the upgrade path (re-wire the
slice-2 Email `threadMessageChanges` incremental delta so only changed messages
re-render, and revalidate only notes/system wholesale). Not built in slice 3.

## Security / posture
- `framedHtml` via `srcdoc` unchanged (same sandbox/opaque origin; sanitize+frame
  server-side). Notes/system are the app's own JSON data rendered by app
  components — plaintext on device like the rest of the mirror.
- Extend the `reference/security` note: the local mirror now holds the full thread
  timeline (messages, notes, system events) plaintext on device, per-user, cleared
  on logout. **Internal notes are collab/private data now mirrored on the device**
  — call this out explicitly.

## Fallback / correctness
- Not mirrored / SSR / `localReady` false → `openThread` renders the timeline (no
  regression).
- render_version drift → reseed.
- Offline open of a previously-opened thread → full timeline from the mirror.
- Notes/system freshness bounded by "revalidate on open + realtime" (a note added
  by a teammate shows after the next open or realtime tick — acceptable; the
  live collab channel still updates the in-memory view when online).

## Testing
- Client SQL: `thread_item` DDL + ordered list + payload round-trip (message with
  framedHtml, note, system) + replace-on-seed. sqlite-wasm memory VFS.
- Server: `buildSeedThread` returns the full timeline (all three item types; rich
  message has framedHtml; note/system framedHtml null); cursor + renderVersion.
- Sync: `ensureThread` seeds; re-open/realtime revalidates (re-seed); render_version
  drift reseeds. Fakes.
- Facade: `liveThread.current` is the full ordered timeline; updates on re-seed.
- e2e (`local-first.mjs`, deployed): open a thread with a note + a rich message →
  full timeline renders; reload → renders from mirror (messages, note, system);
  offline (block network after seed) → thread still opens fully.

## Out of scope (slice 4+)
- Incremental re-render (message delta) to avoid whole re-seed cost.
- Eager whole-mailbox timeline prefetch.
- Mirroring the collab realtime channel for incremental note updates.
- Local write path / offline compose/notes.

## Open details (resolve in plan)
- Whether to keep or delete `threadMessageChanges`/`applyMessageDeltas` (slice 2)
  — prefer delete for a clean single path; keep the `renderFramedBody` extraction.
- `seq` assignment (server index order) must match the render order the app expects
  (the existing `openThread` item order).
- Migration of the client `message` table → `thread_item`: it's derived client
  data — a fresh table + reseed; drop the old table in the DDL.
