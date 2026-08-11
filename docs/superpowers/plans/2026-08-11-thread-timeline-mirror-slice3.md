# Thread-timeline Mirror (Slice 3, true offline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A thread opens fully from the local mirror — messages + internal notes + system events — with no network. The mirror drives the timeline; `openThread` becomes first-open seed + revalidation fallback.

**Architecture:** Replace slice-2's message-only mirror with a unified `thread_item` table (every timeline item as type + JSON payload + seq, + framed_html for messages). Freshness = revalidate the whole thread (re-seed the full `seedThread` DTO) on open + realtime. Rich messages still render via iframe `srcdoc`; notes/system render with existing app components. Reuses slice-2's `renderFramedBody` extraction, `srcdoc` MailFrame, facade/sync patterns.

**Tech Stack:** SvelteKit, Svelte 5 runes, `@sqlite.org/sqlite-wasm`, runed FSM, Drizzle + D1, vitest, puppeteer smoke.

## Global Constraints
- No raw SQL in server code (Drizzle). Client SQLite SQL lives in the worker/schema module (established exception).
- Sanitize + `buildFramedDocument` server-side ONLY; client stores/opaquely renders the framed string via `srcdoc` (same sandbox `allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals`, no `allow-same-origin`).
- Reads gate through `assertMailboxAccess` + `contentKey`.
- runed 0.23.4 utilities only; reactive state in `.svelte.ts`.
- Descriptive names; SPDX; full suite + `svelte-check` + `mail-core tsc` gate; Svelte MCP on `.svelte`/`.svelte.ts`.
- Plaintext-on-device now includes internal notes (collab data) — document it.
- Spec: `docs/superpowers/specs/2026-08-11-thread-timeline-mirror-slice3.md`.

## File Structure
- `apps/web/src/lib/client/localdb/schema.ts` — MODIFY: replace `message` DDL/SQL/marshaling with `thread_item` (`itemToRow`/`rowToItem`, ordered list SQL, replace/clear, thread_synced kept).
- `apps/web/src/lib/client/localdb/worker.ts` — MODIFY: `seedThreadItems`/`listThreadItems`/`getThreadSync`; remove `seedThreadMessages`/`applyMessageDeltas`/`listMessages`.
- `apps/web/src/lib/client/localdb/index.svelte.ts` — MODIFY: `liveThread → { current: TimelineItem[] }`; methods `seedThreadItems`/`listThreadItems`/`getThreadSync`.
- `apps/web/src/lib/client/localdb/sync.svelte.ts` — MODIFY: `ensureThread`/`onThreadRealtime` = revalidate-whole (re-seed); drop the incremental delta path.
- `apps/web/src/lib/rpc/thread-localdb.ts` — MODIFY: `buildSeedThread` returns the full timeline (`MirroredItem[]`); remove `buildThreadMessageChanges` (keep `deliveriesToThreadInfo` if still used by the thread-LIST `buildChanges` — it is; keep it).
- `apps/web/src/lib/rpc/thread.remote.ts` — MODIFY: `seedThread` unchanged signature; remove `threadMessageChanges` export.
- `apps/web/src/routes/(app)/app/+page.svelte` — MODIFY: render the timeline from `liveThread` (mirror) when mirrored; `openThread` fallback; message items srcdoc from item.framedHtml.
- `apps/docs/src/content/docs/reference/security.mdx` — MODIFY: full-timeline + notes-on-device note.
- `apps/web/e2e/local-first.mjs` — MODIFY: full-timeline offline checks.
- Tests: `localdb-thread-item.test.ts`, `localdb-seed-thread.test.ts` (update), `localdb-thread-sync.test.ts` (update), `localdb-live-thread.test.ts` (update).

---

## Task 1: Unified thread_item schema

**Files:** Modify `schema.ts`; Test `apps/web/src/test/localdb-thread-item.test.ts`.

**Interfaces produced:** `thread_item` DDL (replaces `message`; keep `thread_synced`); `ThreadItemRow`; SQL `upsertThreadItemSql`, `clearThreadItemsSql`, `listThreadItemsSql` (WHERE thread_id ORDER BY seq), `getThreadSyncSql`/`setThreadSyncSql` (unchanged); `itemToRow(threadId, seq, item, framedHtml)` and `rowToItem(row)` — `item` is a `TimelineItem` (opaque union: `MessageDTO | NoteItem | SystemEventItem`); `payload` = JSON of the item; `rowToItem` = `{ ...JSON.parse(payload), framedHtml: row.framed_html ?? undefined }` (framedHtml attached for message items; harmless extra field on others).

- [ ] Step 1: Failing test — upsert a message item (with framedHtml, type external_message), a note item (type internal_note), a system item (type system_event) for "t1" at seq 0/1/2; `listThreadItemsSql` returns them ordered; `rowToItem` round-trips each item's type + a payload field + framedHtml (message only). Replace-on-seed + clear. thread_synced round-trip. (sqlite-wasm memory VFS; mirror `localdb-messages.test.ts`.)
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement. `TimelineItem` type imported type-only (from where +page.svelte / read gets the ThreadDTO items union; if no single exported name, define a local `type TimelineItem = { type: string; id: string; [k: string]: unknown }` — the mirror treats items opaquely). Remove the slice-2 `message` DDL/SQL/marshaling (superseded).
- [ ] Step 4: Run → PASS; full suite green.
- [ ] Step 5: Commit `feat(localdb): unified thread_item schema (full timeline mirror)`.

---

## Task 2: Server — buildSeedThread returns the full timeline

**Files:** Modify `thread-localdb.ts`, `thread.remote.ts`; Test `localdb-seed-thread.test.ts` (update).

**Interfaces produced:** `buildSeedThread(db, ctx)` → `{ items: MirroredItem[]; cursor; renderVersion }` where `MirroredItem = { itemId: string; seq: number; itemType: string; payload: TimelineItem; framedHtml: string | null }`. Full `getThread` timeline (NOT filtered to external_message); message items call `renderFramedBody` (images-off), others `framedHtml: null`. Remove `buildThreadMessageChanges` + the `threadMessageChanges` remote export. Keep `deliveriesToThreadInfo` (still used by thread-list `buildChanges`).

- [ ] Step 1: Update the seed test: extend the seed helper to a thread that has a rich message + (if feasible) an internal note. Assert `buildSeedThread` returns all items with correct `itemType`; rich message has non-null `framedHtml` containing `<!doctype html`; note/system have null framedHtml; `cursor` numeric; `renderVersion` set. Order (seq) matches getThread order.
- [ ] Step 2: Run → FAIL (buildSeedThread still filters/returns MirroredMessage).
- [ ] Step 3: Implement: `buildSeedThread` maps EVERY `getThread` item to `MirroredItem` (seq = index). Remove `buildThreadMessageChanges` + its wrapper. Verify nothing else imports the removed exports (thread-list `buildChanges`/`resolveThreadIds`/`deliveriesToThreadInfo` stay).
- [ ] Step 4: Run → PASS; full suite + svelte-check + mail-core tsc green.
- [ ] Step 5: Commit `feat(rpc): buildSeedThread returns the full timeline (messages + notes + system)`.

---

## Task 3: Worker — thread_item handlers

**Files:** Modify `worker.ts`.

**Interfaces produced:** `seedThreadItems({threadId, items, cursor, renderVersion})` (replace thread rows + set thread_synced), `listThreadItems({threadId})` → `TimelineItem[]` (ordered; framedHtml attached to message items via rowToItem), `getThreadSync` unchanged. Remove `seedThreadMessages`/`applyMessageDeltas`/`listMessages`. Add `listThreadItems` to `NO_PERSIST_METHODS`; `seedThreadItems` persists.

- [ ] Step 1: Implement handlers using Task 1 SQL/marshaling (mirror the removed message handlers' structure). `seedThreadItems`: transaction — clearThreadItems, upsert each via `itemToRow(threadId, item.seq, item.payload, item.framedHtml)`, setThreadSync.
- [ ] Step 2: `svelte-check` clean; rpc test green.
- [ ] Step 3: Commit `feat(localdb): worker thread_item seed/list handlers`.

---

## Task 4: Facade liveThread(full timeline) + revalidate-whole sync

**Files:** Modify `index.svelte.ts`, `sync.svelte.ts`; Tests `localdb-live-thread.test.ts` + `localdb-thread-sync.test.ts` (update).

**Interfaces produced:** facade `seedThreadItems`/`listThreadItems`/`getThreadSync`; `liveThread(getThreadId) → { current: TimelineItem[]; destroy() }` (full ordered timeline; message items carry framedHtml). Sync `ensureThread(threadId)`: seed if absent OR render_version drift; else revalidate = re-fetch `seedThreadFn` + `seedThreadItems` (replace). `onThreadRealtime(threadId)`: revalidate. Drop the delta path (`threadChangesFn`/`applyMessageDeltas`).

- [ ] Step 1: Update the facade test — `liveThread.current` updates after `seedThreadItems` (fake bridge returns TimelineItem[] on listThreadItems). Update the sync test — ensureThread seeds when absent; ensureThread when present RE-SEEDS (revalidate, not delta); render_version drift reseeds; onThreadRealtime reseeds. (Remove delta-specific assertions.)
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement. `liveThread` mirrors the slice-2 pattern but typed `TimelineItem[]`. Sync: `doSeedThread` = fetch seedThreadFn + seedThreadItems + live; `ensureThread`/`onThreadRealtime` both route to a revalidate that re-seeds (per-thread busy guard reused; separate threadFsm).
- [ ] Step 4: Run → PASS; full suite + svelte-check + MCP green.
- [ ] Step 5: Commit `feat(localdb): liveThread full timeline + revalidate-whole thread sync`.

---

## Task 5: Thread-view renders the timeline from the mirror

**Files:** Modify `+page.svelte`. No unit test (Task 6 e2e); MUST compile + not regress. MCP validate.

- [ ] Step 1: Replace the slice-2 accelerator wiring: build `liveThread(() => threadId ?? '')`. When `liveThreadMsgs.current.length > 0` (mirrored) AND `localReady`, render the timeline FROM `liveThreadMsgs.current` (the full `TimelineItem[]` — messages, notes, system); else render from `openThread`'s `thread.items` (first-open/fallback/SSR). Introduce a `const timelineItems = $derived(mirrorDriving ? liveThreadMsgs.current : (openDto?.items ?? []))` used by the `{#each}`.
- [ ] Step 2: Message items render via `srcdoc={item.framedHtml}` when present + images not opted-in (else live `src`), exactly as slice 2. Notes (`internal_note`) + system (`system_event`) render with the existing app components/branches — they now come from the mirror when mirror-driving. Confirm the existing `{:else if item.type === 'internal_note'}` / `'system_event'` branches consume the same shape from the mirror (they're the same TimelineItem JSON).
- [ ] Step 3: `ensureThread(threadId)` on open (localReady-gated); `onThreadRealtime(threadId)` on realtime Email/thread events for the open thread. `openThread` still fires for first-open + revalidation (its DTO seeds the mirror).
- [ ] Step 4: Fallback integrity: mirror empty / not-ready / SSR → `openThread` timeline renders unchanged.
- [ ] Step 5: `svelte-check` + full suite green; MCP clean. Commit `feat(thread): render the full timeline from the local mirror (true offline) with remote fallback`.

---

## Task 6: Security doc + e2e (full-timeline offline)

**Files:** Modify `security.mdx`, `local-first.mjs`.

- [ ] Step 1: `security.mdx`: the local mirror now holds the full thread timeline — messages, **internal notes (collab/private data)**, and system events — plaintext on device, per-user, cleared on logout.
- [ ] Step 2: `local-first.mjs` (gated `SMOKE_LOCAL_FIRST`): open a thread → full timeline renders; reload → renders from mirror; block network after seed (CDP offline or abort openThread + /body) → the thread still opens fully (messages + any note/system). Honest reporting (skip note-specific assertions if the test mailbox has none).
- [ ] Step 3: Full gate: `vitest run` + `svelte-check` + `mail-core tsc`; confirm e2e skips cleanly unconfigured.
- [ ] Step 4: Commit `test(localdb): e2e full-timeline offline + security doc for notes on device`.

---

## Self-Review
- True offline thread open (full timeline) → Tasks 1–5 ✓.
- Unified thread_item (all item types) → Task 1 ✓.
- Revalidate-whole on open+realtime → Task 4 ✓.
- Mirror drives timeline; openThread fallback; notes/system from mirror → Task 5 ✓.
- srcdoc frame isolation unchanged → Task 5 (reuses slice-2 MailFrame) ✓.
- Notes-on-device posture doc → Task 6 ✓.
- Tests: schema, seed full timeline, sync revalidate, facade, e2e → Tasks 1,2,4,6 ✓.

**Placeholder scan:** Tasks 3 & 5 are wiring tasks (svelte-check + e2e verified); interfaces pinned by Tasks 1/2/4. No `TBD`.

**Type consistency:** `TimelineItem` is the single mirror+render type; `MirroredItem` the wire type (adds itemId/seq/itemType/framedHtml); `itemToRow`/`rowToItem` the marshaling seam; worker `seedThreadItems`/`listThreadItems` match facade (Task 4) + sync (Task 4).

## Notes for the executor
- Removing slice-2's message table/handlers/delta is intended — do NOT keep dead paths. Keep `renderFramedBody` (framed-body.ts) and `deliveriesToThreadInfo` (thread-list still uses it).
- `seq` must preserve `getThread`'s item order (the order the thread view expects).
- Do NOT mirror `images=1`; do NOT sanitize on the client.
