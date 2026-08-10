# Thread-message mirror — design (slice 2)

Date: 2026-08-11
Status: approved (brainstorm), pending implementation plan
Builds on: slice 1 (`docs/superpowers/specs/2026-08-10-local-first-thread-mirror-design.md`) — the client SQLite mirror, worker, facade, and runed sync FSM already exist.

## Goal

Make **opening a thread instant** (and re-openable offline) by mirroring a
thread's **messages** — metadata, plain-text bodies, and the fully-rendered rich
HTML frame — into the client SQLite store, **lazily, the first time the thread is
opened**. Re-opens render from the mirror; a live `Email` change reconciles it.

## Decisions (owner-approved)
- **Lazy per-opened-thread** — mirror a thread's messages on first open, not the
  whole mailbox. Storage stays bounded to threads actually read.
- **Full HTML body** — mirror the rich message render, not just text, so a thread
  reads fully offline (minus remote images).
- **Sanitization + framing stay 100% server-side.** The client never runs the
  sanitizer or `buildFramedDocument`. It stores and displays the **server-built
  framed document** verbatim (an opaque string) via iframe `srcdoc`.

## Key refinement vs the pitch
The rich-HTML frame is produced today by `GET /api/messages/[id]/body`:
`R2 raw → rawObjectToHtml → stripQuotesHtml → sanitizeEmailHtml → proxyRemoteResources → buildFramedDocument` → a complete framed `<!doctype html>…` string that the sandboxed iframe loads via `src`.

Slice 2 mirrors **that exact string** (the `images=0` variant — see Images) per
rich message. The thread view then renders a mirrored message by feeding the
iframe **`srcdoc`** instead of `src`, with the **same sandbox attributes** — so
the opaque-origin protection is identical to today. No new sanitize/frame code on
the client; the render pipeline is unchanged, just its source (mirror vs network).

## Architecture

### Client schema (add to `localdb/schema.ts`)
```
message(
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq INTEGER NOT NULL,              -- order within the thread (sent_at-based)
  from_addr TEXT, from_name TEXT,
  sent_at INTEGER,
  item_type TEXT,                    -- external_message | note | system (mirror external_message only in slice 2)
  content_kind TEXT,                 -- bubble | card
  html_kind TEXT,                    -- rich | plain | null
  body_text TEXT,                    -- bodyStripped/bodyFull (chat-bubble render)
  framed_html TEXT,                  -- server-built framed doc, images-off (rich only; null for plain)
  dmarc_pass INTEGER NOT NULL DEFAULT 0,
  has_remote_images INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  outbound INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,                    -- attachments[], to/cc, viaAlias, replyContext, calendarInvite, sender flags — the rest of MessageDTO as JSON
  render_version TEXT,               -- RENDER_CACHE_VERSION at mirror time
  PRIMARY KEY (thread_id, message_id)
);
CREATE INDEX message_by_thread ON message (thread_id, seq);
thread_synced(thread_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL, render_version TEXT NOT NULL);
```
`meta_json` carries the long tail of `MessageDTO` so the mirrored thread renders
identically to a server load without inventing a reduced type — the render code
consumes `MessageDTO`, so we round-trip it.

### Server endpoints (`thread.remote.ts`, pure helpers in `thread-localdb.ts`)
- `seedThread({ mailboxId, threadId })` → `{ messages: MirroredMessage[]; cursor; renderVersion }`.
  Reuses `getThread` for the DTO **and** the `/body` derivation for each rich
  message's framed doc (`images=0`). `MirroredMessage = MessageDTO + { framedHtml: string | null }`.
  `cursor` = the thread's current max `Email`-type `change_log` seq snapshot.
- `threadMessageChanges({ mailboxId, threadId, sinceSeq })` → `{ upserts: MirroredMessage[]; removals: string[]; newSeq; cannotCalculate }`.
  `changesSince` filtered to this thread's `Email` objects (map message-id → this
  thread), re-derive the changed messages. Same shape/idempotency as slice 1.
- Both gate through `assertMailboxAccess` + `contentKey`, like every other read.
- Factor the `/body` render into a reusable `renderFramedBody(db, env, msg, ck, { images:false })` so the endpoint and `seedThread` share one path (DRY — no second framing path to drift).

### Worker (`worker.ts`) — new handlers
- `seedThreadMessages({ threadId, messages, cursor, renderVersion })` — replace the thread's rows in `message`, set `thread_synced`.
- `applyMessageDeltas({ threadId, upserts, removals, newCursor })`.
- `listMessages({ threadId })` → `MessageDTO[]` (rebuilt from rows + `meta_json`, ordered by `seq`).
- `getThreadSync({ threadId })` → `{ cursor, renderVersion } | null`.

### Facade + reactive read (`index.svelte.ts`)
- `liveThread(getThreadId: () => string)` → `{ current: MessageDTO[] }`, `$state`-backed, re-queried on message seed/delta for that thread (per-thread version signal, mirroring `liveThreadList`).
- Facade methods `seedThreadMessages`, `applyMessageDeltas`, `getThreadSync`, `listMessages`.

### Sync (`sync.svelte.ts`)
- Extend `createSync` (or a sibling `createThreadSync`) with `ensureThread(threadId)` + `onThreadRealtime(threadId)`, reusing the FSM. `ensureThread`: no `thread_synced` row → seed via `seedThread`; render_version mismatch → reseed; else `threadMessageChanges` catch-up.

### Thread-view wiring (`(app)/app/+page.svelte`)
- On thread open, `sync.ensureThread(threadId)`; source `thread.items` from `liveThread(threadId).current` when mirrored, else the existing `openThread` remote (fallback — SSR, not-yet-mirrored, unsupported browser).
- `MailFrame`: accept a `srcdoc` prop as an alternative to `src`. A mirrored rich message passes `srcdoc={framedHtml}`; a non-mirrored one keeps `src={/api/messages/[id]/body…}`. Sandbox attrs unchanged. The height-report `postMessage` script is already inside the framed doc, so it works under `srcdoc` too.
- Realtime `Email` event for an open, mirrored thread → `sync.onThreadRealtime`.

## Images
The mirrored framed doc is the **`images=0`** variant — remote images are not
proxied into it, so it renders offline (text + layout, no remote images). The
existing **"load remote images"** opt-in is unchanged: it swaps the frame to the
live `src=/api/messages/[id]/body?images=1` (fresh signed tokens, network) —
never mirrored (tokens are short-lived). So: instant/offline text render from the
mirror; images remain an explicit, online action.

## Freshness / correctness
- **render_version**: each mirrored message stores `RENDER_CACHE_VERSION` at mirror
  time. On open, a mismatch (render logic shipped since) → reseed the thread. This
  is the client-side analogue of the body cache's ETag.
- **Delta**: `Email` `change_log` rows (created/updated) for a mirrored thread →
  re-derive + upsert; a destroyed message → removal. Same self-heal via
  realtime/re-open as slice 1.

## Security / posture
- **Bigger plaintext-on-device surface**: full message bodies (text + the framed
  HTML) now sit in the client store in plaintext, not just list snippets. Same
  posture as slice 1 (owner-accepted, per-user, cleared on logout via the existing
  `clear`); extend the `reference/security` note to say "message bodies too."
- **Frame isolation unchanged**: `srcdoc` + the same `sandbox="allow-scripts …"`
  (no `allow-same-origin`) = opaque origin, same as the `src` path. CSP lives in
  the framed doc's `<meta>` (built server-side); `srcdoc` honors it. The injected
  height-script's sha256 is already in that CSP.
- **No client-side sanitization or framing** — the client stores/opaquely displays
  a server-produced string. A mirrored doc is only ever what the server would have
  served for that message at `images=0`.

## Testing
- **Server**: `seedThread` + `threadMessageChanges` against the `makeDb` harness —
  message set, cursor snapshot, delta upsert/removal, cannotCalculate, and that a
  rich message carries a non-null `framedHtml` while a plain one doesn't. Reuse
  `seedMailboxWithThreads`; extend it to deliver a rich-HTML message.
- **Client SQL**: `message`/`thread_synced` DDL + queries via sqlite-wasm memory
  VFS (order by seq, replace-on-seed, meta_json round-trip).
- **Sync**: `ensureThread`/`onThreadRealtime` FSM with fakes (seed, delta,
  render_version-mismatch reseed).
- **Facade**: `liveThread` re-queries on delta (fake bridge).
- **e2e** (`local-first.mjs`, deployed): open a thread → renders; re-open →
  served from the mirror (no `openThread`/`/body` network call for that message);
  reload → thread still renders from the mirror; a rich HTML message renders in the
  sandboxed frame via srcdoc. Manual: images opt-in still fetches live; iOS Safari.

## Out of scope (slice 3+)
- Eager whole-mailbox message mirror / true full-offline inbox.
- Mirroring notes + system events (slice 2 mirrors `external_message` only; notes
  stay remote — they're collab state with their own live channel).
- Local write path / offline compose.
- Mirroring the `images=1` (remote-images-loaded) render.

## Open implementation details (resolve in the plan)
- Exact `MirroredMessage` wire type + how `meta_json` splits from typed columns
  (keep typed columns for what queries/filters need; JSON for the render tail).
- Whether `liveThread` supersedes or complements the existing `openThread` store
  in `+page.svelte` (prefer: mirror drives when present, `openThread` is the
  fallback + first-open source while the seed runs).
- Cap on mirrored threads (LRU eviction) — likely unneeded for slice 2 (lazy +
  OPFS), but note a ceiling rather than unbounded growth.
