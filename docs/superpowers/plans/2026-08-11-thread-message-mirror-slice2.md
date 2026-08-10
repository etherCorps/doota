# Thread-message Mirror (Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Opening a thread renders instantly (and offline on re-open) by lazily mirroring a thread's messages — metadata + text + the server-built framed HTML doc — into the client SQLite store.

**Architecture:** Extends slice 1's client mirror (`apps/web/src/lib/client/localdb/`). On thread open, a runed sync engine seeds the thread's messages from a server endpoint that reuses the `/api/messages/[id]/body` render, then applies `Email` change_log deltas. Rich messages render via iframe `srcdoc` fed from the mirror; sanitize + framing stay 100% server-side. Remote images stay an online opt-in.

**Tech Stack:** SvelteKit, Svelte 5 runes, `@sqlite.org/sqlite-wasm`, runed FSM, Drizzle + D1, vitest, puppeteer smoke.

## Global Constraints
- No raw SQL in server code — Drizzle query builder only. Client SQLite SQL lives in the worker/schema module (the established exception).
- Sanitization + `buildFramedDocument` run ONLY server-side. The client stores/displays the server-produced framed string verbatim; it never sanitizes or frames.
- Reads gate through `assertMailboxAccess` + `contentKey` (the `can()` chokepoint).
- The mirrored frame keeps `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals"` (NO `allow-same-origin`) — identical isolation to the current `src` path.
- Mirror the `images=0` framed variant only. Never mirror `images=1` (short-lived signed tokens).
- runed 0.23.4 utilities only (`FiniteStateMachine`, `watch`, `useEventListener`, `Debounced`). Reactive state lives in `.svelte.ts`.
- Descriptive names; SPDX headers; full suite + `svelte-check` + `mail-core tsc` is the gate; Svelte MCP autofixer on `.svelte`/`.svelte.ts` edits.
- Plaintext-on-device: mirrored bodies are plaintext, per-user, cleared on logout (existing `clear`).
- Spec: `docs/superpowers/specs/2026-08-11-thread-message-mirror-design.md`.

## File Structure
- `apps/web/src/lib/client/localdb/schema.ts` — MODIFY: add `message` + `thread_synced` DDL, SQL builders, `MessageDTO`↔row marshaling.
- `apps/web/src/lib/client/localdb/worker.ts` — MODIFY: `seedThreadMessages`/`applyMessageDeltas`/`listMessages`/`getThreadSync` handlers.
- `apps/web/src/lib/client/localdb/index.svelte.ts` — MODIFY: facade methods + `liveThread(getThreadId)`.
- `apps/web/src/lib/client/localdb/sync.svelte.ts` — MODIFY: `ensureThread`/`onThreadRealtime` (extend `createSync`).
- `apps/web/src/routes/api/messages/[id]/body/+server.ts` — MODIFY: extract `renderFramedBody(...)` into a shared module.
- `apps/web/src/lib/server/framed-body.ts` — CREATE: the extracted `renderFramedBody` (used by the route AND the seed endpoint).
- `apps/web/src/lib/rpc/thread-localdb.ts` — MODIFY: `buildSeedThread` / `buildThreadMessageChanges` pure helpers.
- `apps/web/src/lib/rpc/thread.remote.ts` — MODIFY: `seedThread` / `threadMessageChanges` remote wrappers.
- `apps/web/src/lib/components/mail/mail-frame.svelte` — MODIFY: accept `srcdoc` alongside `src`.
- `apps/web/src/routes/(app)/app/+page.svelte` — MODIFY: `ensureThread` on open; source items from `liveThread` with `openThread` fallback; pass `srcdoc` to `MailFrame` for mirrored rich messages.
- `apps/docs/src/content/docs/reference/security.mdx` — MODIFY: extend the local-mirror note to message bodies.
- `apps/web/e2e/local-first.mjs` — MODIFY: add thread-open-from-mirror checks.
- Tests: `apps/web/src/test/localdb-messages.test.ts`, `localdb-seed-thread.test.ts`, `localdb-thread-sync.test.ts`, `localdb-live-thread.test.ts`.

---

## Task 1: Client schema — message + thread_synced

**Files:** Modify `apps/web/src/lib/client/localdb/schema.ts`; Test `apps/web/src/test/localdb-messages.test.ts`.

**Interfaces produced:**
- Extend `DDL` with the `message` + `thread_synced` tables (per spec).
- `MessageRow` type (typed columns as `$`-bind object).
- `messageDtoToRow(threadId, seq, dto, framedHtml, renderVersion)` and `rowToMessageDto(row)` — round-trip `MessageDTO` (the long tail via `meta_json`).
- SQL: `upsertMessageSql`, `deleteMessageSql`, `listMessagesSql` (WHERE thread_id ORDER BY seq), `clearThreadMessagesSql`, `getThreadSyncSql`, `setThreadSyncSql`.

- [ ] Step 1: Write failing test — seed 2 messages (one rich w/ `framedHtml`, one plain), read back via `listMessagesSql` ordered by seq; assert `rowToMessageDto` round-trips `htmlKind`, `bodyText`, `framedHtml`, and a `meta_json` field (e.g. `attachments`). Assert upsert-replace + delete + `thread_synced` get/set. (Use sqlite-wasm memory VFS, mirroring `localdb-schema.test.ts`.)
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement the DDL additions, `MessageRow`, SQL builders, and marshaling. `MessageDTO` is imported type-only from the same place `+page.svelte` gets it (`$lib/rpc/thread.remote` / read). `meta_json` = JSON of the MessageDTO fields NOT stored as typed columns (to, cc, replyTo, keywords, attachments, submission, replyContext, calendarInvite, senderTrusted, senderVerified, viaAlias, viaAliasId, subject, messageIdHeader). `framed_html` null for plain.
- [ ] Step 4: Run → PASS.
- [ ] Step 5: Commit `feat(localdb): message + thread_synced schema for the thread mirror`.

---

## Task 2: Server — extract renderFramedBody + seedThread/threadMessageChanges

**Files:** Create `apps/web/src/lib/server/framed-body.ts`; Modify `apps/web/src/routes/api/messages/[id]/body/+server.ts`, `apps/web/src/lib/rpc/thread-localdb.ts`, `apps/web/src/lib/rpc/thread.remote.ts`, `apps/web/src/test/helpers/seed-threads.ts`; Test `apps/web/src/test/localdb-seed-thread.test.ts`.

**Interfaces produced:**
- `renderFramedBody(deps, msgRow, ck, opts): Promise<string | null>` — the extracted `R2 raw → rawObjectToHtml → stripQuotesHtml → sanitizeEmailHtml → buildFramedDocument` pipeline for `images:false` (no `proxyRemoteResources`). Returns the framed doc string, or null if no HTML body. The route calls it (behavior-preserving); the seed calls it per rich message.
- `buildSeedThread(db, ctx): Promise<{ messages: MirroredMessage[]; cursor: number; renderVersion: string }>` where `MirroredMessage = MessageDTO & { framedHtml: string | null; seq: number }`; `ctx = { mailboxId, threadId, ck, userId, includeCollab, assignedTo, env }`.
- `buildThreadMessageChanges(db, ctx + sinceSeq): Promise<{ upserts: MirroredMessage[]; removals: string[]; newSeq: number; cannotCalculate: boolean }>`.
- Remote: `seedThread({mailboxId, threadId})`, `threadMessageChanges({mailboxId, threadId, sinceSeq})`.

- [ ] Step 1: Extract `renderFramedBody` from `+server.ts` into `framed-body.ts` WITHOUT behavior change; the route imports it. Confirm the attachment/body e2e assumptions still hold (svelte-check + existing tests). Note: keep the route's `images=1` + injected-script path in the route; `renderFramedBody` handles the `images:false` core both share.
- [ ] Step 2: Write failing test (`localdb-seed-thread.test.ts`, `makeDb`): extend `seedMailboxWithThreads` (or add a helper) to deliver a thread with one rich-HTML message + one plain message. `buildSeedThread` returns both as `MirroredMessage`; the rich one has non-null `framedHtml` containing `<!doctype html` and the sanitized text; the plain one has null `framedHtml` + non-null `bodyText`; `cursor` is a number; `renderVersion` set. Then a placement/read change → `buildThreadMessageChanges` upserts the changed message; a floor case → `cannotCalculate`.
- [ ] Step 3: Run → FAIL.
- [ ] Step 4: Implement the helpers (reuse `getThread` for the DTO tail; map each `external_message` item to `MirroredMessage`, calling `renderFramedBody` for `htmlKind==='rich'`). `buildThreadMessageChanges` uses `changesSince` filtered to `Email` objects whose `threadId === ctx.threadId`. Wrappers gate through `assertMailboxAccess`.
- [ ] Step 5: Run → PASS; full suite + svelte-check green.
- [ ] Step 6: Commit `feat(rpc): seedThread + threadMessageChanges reusing the framed-body render`.

---

## Task 3: Worker — message handlers

**Files:** Modify `worker.ts`; covered by Task 1 SQL + Task 7 e2e (add a small RPC-shape assertion if practical).

**Interfaces produced:** worker methods `seedThreadMessages({threadId, messages, cursor, renderVersion})`, `applyMessageDeltas({threadId, upserts, removals, newCursor})`, `listMessages({threadId})` → `MessageDTO[]`, `getThreadSync({threadId})` → `{cursor, renderVersion}|null`. All transactional; persist (idb tier) after mutations, skip on reads (extend `NO_PERSIST_METHODS`).

- [ ] Step 1: Implement the handlers using Task 1's SQL + marshaling (`messageDtoToRow`/`rowToMessageDto`). `seedThreadMessages` clears the thread's rows then inserts + sets `thread_synced`. `listMessages` orders by seq → `rowToMessageDto`.
- [ ] Step 2: Add `list`/`getCursor`-style methods to `NO_PERSIST_METHODS` set (`listMessages`, `getThreadSync`).
- [ ] Step 3: `svelte-check` clean; RPC test still green.
- [ ] Step 4: Commit `feat(localdb): worker handlers for message seed/delta/list`.

---

## Task 4: Facade — liveThread + methods

**Files:** Modify `index.svelte.ts`; Test `apps/web/src/test/localdb-live-thread.test.ts`.

**Interfaces produced:** facade `seedThreadMessages`, `applyMessageDeltas`, `getThreadSync`, `listMessages`; `liveThread(getThreadId: () => string) → { current: MessageDTO[]; destroy() }` ($state-backed, per-thread version bumped on seed/applyMessageDeltas).

- [ ] Step 1: Write failing test (fake bridge): `liveThread(() => "t1").current` updates after `applyMessageDeltas("t1", [msg], [], 5)`. Mirror `localdb-facade.test.ts`.
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement — reuse the slice-1 watcher/version pattern, keyed by threadId; `current` is `$state<MessageDTO[]>`.
- [ ] Step 4: Run → PASS; full suite green.
- [ ] Step 5: Commit `feat(localdb): liveThread reactive message read + facade methods`.

---

## Task 5: Sync — ensureThread / onThreadRealtime

**Files:** Modify `sync.svelte.ts`; Test `apps/web/src/test/localdb-thread-sync.test.ts`.

**Interfaces produced:** `createSync` (or exported `createThreadSync`) gains `ensureThread(threadId)` + `onThreadRealtime(threadId)`, injected `seedThreadFn`/`threadChangesFn`/`localdb` (getThreadSync/seedThreadMessages/applyMessageDeltas). FSM reused.

- [ ] Step 1: Write failing tests (fakes): no `thread_synced` → `ensureThread` seeds (seedThreadFn + seedThreadMessages), state live. `onThreadRealtime` in live → threadChangesFn(cursor) + applyMessageDeltas. `renderVersion` mismatch on `ensureThread` → reseed. `cannotCalculate` → reseed.
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement, reusing the FSM. `ensureThread`: read `getThreadSync`; null OR renderVersion != current → seed; else resync via threadChangesFn.
- [ ] Step 4: Run → PASS; full suite green.
- [ ] Step 5: Commit `feat(localdb): thread sync engine (ensureThread + delta)`.

---

## Task 6: MailFrame srcdoc + thread-view wiring

**Files:** Modify `mail-frame.svelte`, `(app)/app/+page.svelte`. No unit test (Task 7 e2e); MUST compile + not regress.

- [ ] Step 1: `mail-frame.svelte` — add an optional `srcdoc` prop. When set, render `<iframe srcdoc={srcdoc} …>` with the SAME sandbox attrs; when absent, keep `src`. Height-report postMessage + expand logic unchanged. Validate with Svelte MCP.
- [ ] Step 2: `+page.svelte` — on thread open (the existing open handler / `openThread` call site), also `sync.ensureThread(threadId)` and expose `liveThread(() => openThreadId)`. Source the rendered `thread.items` from the mirror when `liveThread.current.length` (mirrored), else the existing `openThread` result (fallback + first-open). Guard with the existing `localReady`.
- [ ] Step 3: For a rendered rich message, if it came from the mirror and has `framedHtml`, pass `srcdoc={m.framedHtml}` to `MailFrame`; else keep `src={/api/messages/[id]/body…}`. The "load remote images" opt-in stays on the `src` path (live).
- [ ] Step 4: Realtime `Email` event for the open thread → `sync.onThreadRealtime(openThreadId)`.
- [ ] Step 5: `svelte-check` + full suite green; Svelte MCP clean.
- [ ] Step 6: Commit `feat(thread): render messages from the local mirror (srcdoc frame) with remote fallback`.

---

## Task 7: Security doc + e2e

**Files:** Modify `apps/docs/src/content/docs/reference/security.mdx`, `apps/web/e2e/local-first.mjs`.

- [ ] Step 1: Extend the local-mirror security row: the mirror now holds full message bodies (text + rendered HTML) plaintext on device, per-user, cleared on logout.
- [ ] Step 2: `local-first.mjs` — add checks (gated `SMOKE_LOCAL_FIRST`): open a thread → messages render; re-open the same thread → no `openThread`/`/api/messages/*/body` network call for it (served from mirror); reload → thread still renders; a rich message renders in the sandboxed frame (assert an iframe with `srcdoc` or the framed content present).
- [ ] Step 3: Full gate: `vitest run` + `svelte-check` + `mail-core tsc`. Confirm the smoke skips cleanly unconfigured.
- [ ] Step 4: Commit `test(localdb): e2e for thread-open-from-mirror + security doc`.

---

## Self-Review
- Instant/offline thread open → Tasks 1–6 ✓ (mirror + render).
- Full HTML via server-built framed doc + srcdoc → Task 2 (renderFramedBody) + Task 6 (srcdoc) ✓.
- Sanitize/frame stays server-side → renderFramedBody is server-only; client stores the string ✓.
- Lazy per-thread → `ensureThread` on open, `thread_synced` per thread ✓.
- Freshness (render_version) + delta → Tasks 2,5 ✓.
- Fallback (not-mirrored / SSR / unsupported) → Task 6 `localReady` + `openThread` ✓.
- Images opt-in stays live → Task 6 Step 3 ✓.
- Privacy posture doc → Task 7 ✓.
- Tests: schema, seedThread/changes, sync FSM, facade, e2e → Tasks 1,2,4,5,7 ✓.

**Placeholder scan:** Tasks 3 & 6 are wiring/Svelte-file tasks verified via svelte-check + e2e rather than node unit tests; their interfaces are pinned by Tasks 1/2/4/5. No `TBD`/"handle edge cases" in the server/SQL tasks.

**Type consistency:** `MessageDTO` is the single render+mirror type; `MirroredMessage = MessageDTO & {framedHtml, seq}` is the wire type; `messageDtoToRow`/`rowToMessageDto` the only marshaling seam; worker method names match between Task 3 and the facade (Task 4) and sync (Task 5).

## Notes for the executor
- `renderFramedBody` extraction (Task 2 Step 1) must be behavior-preserving for the existing `/body` route — run the attachment/body-related tests + a manual note in the report.
- Do not mirror `images=1`. Do not run the sanitizer on the client.
- Reuse `seedMailboxWithThreads`; extend it to deliver a rich-HTML message (a `text/html` part) so `htmlKind==='rich'` and `framedHtml` is exercised.
