# Local-first Thread Mirror (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make opening a thread and switching folder/mailbox feel instant by mirroring the active mailbox's thread list into a persistent client-side SQLite (WASM) store, kept live by the existing `change_log` deltas.

**Architecture:** A Web Worker owns a SQLite-WASM DB (OPFS-sahpool VFS preferred, memory-VFS + debounced IndexedDB snapshot fallback). A main-thread facade exposes reactive local reads. A runed `FiniteStateMachine` sync engine seeds from a server endpoint, then applies `changesSince`-derived deltas triggered by the realtime bus. The inbox list reads local-first with the current remote function as fallback. Read-only mirror — user actions still write through existing remote functions; their `change_log` rows reconcile the mirror.

**Tech Stack:** SvelteKit, Svelte 5 runes, `@sqlite.org/sqlite-wasm`, runed (`FiniteStateMachine`, `watch`, `useEventListener`, `Debounced`), Drizzle + Cloudflare D1, vitest, Playwright.

## Global Constraints

- No raw SQL in app/server code — use the Drizzle query builder (FTS/virtual-table exceptions only). The client SQLite mirror is a separate engine; its SQL is unavoidable and lives only in the worker/schema module.
- Descriptive variable names; no single-letter loop/callback vars (`q`/`sig` allowed).
- Auth-entity mutations go through `locals.auth.api.*`; reads via Drizzle. New endpoints are reads only.
- Every privileged read gates through the existing `assertMailboxAccess` / `can()` chokepoint.
- Full test suite + `tsc` + `svelte-check` is the gate before any push.
- Svelte files: use the Svelte MCP autofixer/validation after edits.
- runed installed is 0.23.4 — use only utilities present there (`FiniteStateMachine`, `watch`, `useEventListener`, `Debounced`, `useDebounce`, `PersistedState`). Do NOT use `resource` (0.37+).
- Client mirror stores DECRYPTED subject/snippet in plaintext (owner decision); it is per-user and cleared on logout/account switch.
- Spec: `docs/superpowers/specs/2026-08-10-local-first-thread-mirror-design.md`.

---

## File Structure

**Server (packages/mail-core + apps/web/src/lib/rpc):**
- `packages/mail-core/src/read.ts` — MODIFY: add `threadSummariesByIds()` (hydrate changed threads → `ThreadSummary[]`).
- `apps/web/src/lib/rpc/thread.remote.ts` — MODIFY: add `seedThreadList` + `threadChanges` remote queries (reuse `assertMailboxAccess`, `contentKey`, `listThreads`).

**Client (apps/web/src/lib/client/localdb):**
- `localdb/schema.ts` — CREATE: client SQLite DDL + row types + pure query/upsert SQL builders (node-testable).
- `localdb/worker.ts` — CREATE: Web Worker; owns the DB; tiered persistence; typed message handler.
- `localdb/rpc.ts` — CREATE: tiny typed postMessage request/response bridge (no comlink dep).
- `localdb/index.ts` — CREATE: main-thread facade + `liveThreadList()` reactive read.
- `localdb/sync.svelte.ts` — CREATE: `FiniteStateMachine` sync engine; consumes the realtime bus + endpoints.
- `localdb/persistence.ts` — CREATE: tier selection (OPFS-sahpool vs memory+IndexedDB snapshot).

**Integration:**
- `apps/web/src/routes/(app)/app/+page.svelte` — MODIFY: read list from `liveThreadList` with remote fallback; apply optimistic patches to the mirror.
- `apps/web/src/routes/(app)/+layout.svelte` or logout flow — MODIFY: clear the mirror on logout/account switch.
- `apps/docs/src/content/docs/reference/security.mdx` — MODIFY: one note on the plaintext local mirror.

**Tests:**
- `apps/web/src/test/localdb-schema.test.ts` — client SQL layer (sqlite-wasm memory VFS in node).
- `apps/web/src/test/thread-summaries-by-ids.test.ts` — hydrate helper (makeDb).
- `apps/web/src/test/localdb-endpoints.test.ts` — seed + changes endpoints (makeDb).
- `apps/web/src/test/localdb-sync.test.ts` — sync FSM with fakes.
- `apps/web/e2e/local-first.spec.ts` — persistence + instant nav + fallback.

---

## Task 1: Add sqlite-wasm + client SQL schema module (node-testable)

**Files:**
- Modify: `apps/web/package.json` (add `@sqlite.org/sqlite-wasm`)
- Create: `apps/web/src/lib/client/localdb/schema.ts`
- Test: `apps/web/src/test/localdb-schema.test.ts`

**Interfaces:**
- Produces:
  - `type ThreadRow` — the mirrored row (mirrors `ThreadSummary` fields + `mailboxId`).
  - `DDL: string` — the `CREATE TABLE`/index statements.
  - `upsertThreadSql(): { sql: string }` — parameterized upsert (named params).
  - `deleteThreadSql(): { sql: string }` — delete by `(mailbox_id, thread_id)`.
  - `listThreadsSql(): { sql: string }` — select by `(mailbox_id, placement)` ordered by `pinned_at` then `last_message_at` desc.
  - `getCursorSql`, `setCursorSql`, `clearMailboxSql` — cursor + reset statements.
  - `rowToThreadSummary(row)` / `threadSummaryToRow(mailboxId, summary)` — JSON (labels/participants) marshaling.

- [ ] **Step 1: Add the dependency**

Run:
```bash
cd apps/web && pnpm add @sqlite.org/sqlite-wasm
```
Expected: `@sqlite.org/sqlite-wasm` in `apps/web/package.json` dependencies.

- [ ] **Step 2: Write the failing test**

```ts
// apps/web/src/test/localdb-schema.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { DDL, upsertThreadSql, deleteThreadSql, listThreadsSql, threadSummaryToRow, rowToThreadSummary } from "$lib/client/localdb/schema";

// A ThreadSummary fixture (shape from @doota/mail-core/read).
const summary = (over: Partial<any> = {}) => ({
  threadId: "t1", subject: "Invoice", snippet: "hi", from: "a@x.com", fromName: "A",
  participants: ["a@x.com"], participantCount: 1, lastMessageAt: 1000, isStarred: false,
  unread: true, hasNotes: false, assigneeUserId: null, placement: "inbox", pinnedAt: null, ...over,
});

let db: any;
beforeEach(async () => {
  const sqlite3 = await sqlite3InitModule();
  db = new sqlite3.oo1.DB(":memory:", "c"); // memory VFS — universal, node-safe
  db.exec(DDL);
});

describe("localdb schema", () => {
  it("upserts a ThreadSummary and reads it back by mailbox+placement", () => {
    const row = threadSummaryToRow("mb_a", summary());
    db.exec({ sql: upsertThreadSql().sql, bind: row });
    const out: any[] = [];
    db.exec({ sql: listThreadsSql().sql, bind: { $mailbox_id: "mb_a", $placement: "inbox" }, rowMode: "object", resultRows: out });
    expect(out.length).toBe(1);
    expect(rowToThreadSummary(out[0]).subject).toBe("Invoice");
  });

  it("upsert replaces the same (mailbox, thread) row", () => {
    db.exec({ sql: upsertThreadSql().sql, bind: threadSummaryToRow("mb_a", summary({ unread: true })) });
    db.exec({ sql: upsertThreadSql().sql, bind: threadSummaryToRow("mb_a", summary({ unread: false })) });
    const out: any[] = [];
    db.exec({ sql: listThreadsSql().sql, bind: { $mailbox_id: "mb_a", $placement: "inbox" }, rowMode: "object", resultRows: out });
    expect(out.length).toBe(1);
    expect(rowToThreadSummary(out[0]).unread).toBe(false);
  });

  it("delete removes the row; folder filter scopes by placement", () => {
    db.exec({ sql: upsertThreadSql().sql, bind: threadSummaryToRow("mb_a", summary({ threadId: "t1", placement: "inbox" })) });
    db.exec({ sql: upsertThreadSql().sql, bind: threadSummaryToRow("mb_a", summary({ threadId: "t2", placement: "archived" })) });
    db.exec({ sql: deleteThreadSql().sql, bind: { $mailbox_id: "mb_a", $thread_id: "t1" } });
    const inbox: any[] = [];
    db.exec({ sql: listThreadsSql().sql, bind: { $mailbox_id: "mb_a", $placement: "inbox" }, rowMode: "object", resultRows: inbox });
    expect(inbox.length).toBe(0);
    const archived: any[] = [];
    db.exec({ sql: listThreadsSql().sql, bind: { $mailbox_id: "mb_a", $placement: "archived" }, rowMode: "object", resultRows: archived });
    expect(archived.length).toBe(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/test/localdb-schema.test.ts`
Expected: FAIL — cannot resolve `$lib/client/localdb/schema`.

- [ ] **Step 4: Implement the schema module**

```ts
// apps/web/src/lib/client/localdb/schema.ts
// SPDX-License-Identifier: Apache-2.0
import type { ThreadSummary } from "@doota/mail-core/read";

/** A mirrored thread-list row: ThreadSummary + owning mailbox. JSON arrays are
 *  stored as TEXT so the row is a flat bind object. */
export type ThreadRow = {
  $mailbox_id: string;
  $thread_id: string;
  $placement: string;
  $subject: string | null;
  $snippet: string | null;
  $from_addr: string | null;
  $from_name: string | null;
  $participants: string;      // JSON string[]
  $participant_count: number;
  $last_message_at: number | null;
  $is_starred: number;        // 0 | 1
  $unread: number;            // 0 | 1
  $has_notes: number;         // 0 | 1
  $assignee_user_id: string | null;
  $pinned_at: number | null;
};

export const DDL = `
CREATE TABLE IF NOT EXISTS thread_list (
  mailbox_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  placement TEXT NOT NULL,
  subject TEXT, snippet TEXT, from_addr TEXT, from_name TEXT,
  participants TEXT NOT NULL DEFAULT '[]',
  participant_count INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  is_starred INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  has_notes INTEGER NOT NULL DEFAULT 0,
  assignee_user_id TEXT,
  pinned_at INTEGER,
  PRIMARY KEY (mailbox_id, thread_id)
);
CREATE INDEX IF NOT EXISTS thread_list_view ON thread_list (mailbox_id, placement, last_message_at);
CREATE TABLE IF NOT EXISTS sync_state (mailbox_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
`;

export const upsertThreadSql = () => ({
  sql: `INSERT INTO thread_list
    (mailbox_id, thread_id, placement, subject, snippet, from_addr, from_name,
     participants, participant_count, last_message_at, is_starred, unread, has_notes,
     assignee_user_id, pinned_at)
    VALUES ($mailbox_id,$thread_id,$placement,$subject,$snippet,$from_addr,$from_name,
     $participants,$participant_count,$last_message_at,$is_starred,$unread,$has_notes,
     $assignee_user_id,$pinned_at)
    ON CONFLICT(mailbox_id, thread_id) DO UPDATE SET
     placement=excluded.placement, subject=excluded.subject, snippet=excluded.snippet,
     from_addr=excluded.from_addr, from_name=excluded.from_name, participants=excluded.participants,
     participant_count=excluded.participant_count, last_message_at=excluded.last_message_at,
     is_starred=excluded.is_starred, unread=excluded.unread, has_notes=excluded.has_notes,
     assignee_user_id=excluded.assignee_user_id, pinned_at=excluded.pinned_at`,
});

export const deleteThreadSql = () => ({
  sql: `DELETE FROM thread_list WHERE mailbox_id=$mailbox_id AND thread_id=$thread_id`,
});

export const listThreadsSql = () => ({
  sql: `SELECT * FROM thread_list WHERE mailbox_id=$mailbox_id AND placement=$placement
        ORDER BY (pinned_at IS NULL), pinned_at DESC, last_message_at DESC`,
});

export const getCursorSql = () => ({ sql: `SELECT cursor FROM sync_state WHERE mailbox_id=$mailbox_id` });
export const setCursorSql = () => ({
  sql: `INSERT INTO sync_state (mailbox_id, cursor) VALUES ($mailbox_id,$cursor)
        ON CONFLICT(mailbox_id) DO UPDATE SET cursor=excluded.cursor`,
});
export const clearMailboxSql = () => ({ sql: `DELETE FROM thread_list WHERE mailbox_id=$mailbox_id` });

export function threadSummaryToRow(mailboxId: string, summary: ThreadSummary): ThreadRow {
  return {
    $mailbox_id: mailboxId, $thread_id: summary.threadId, $placement: summary.placement,
    $subject: summary.subject, $snippet: summary.snippet, $from_addr: summary.from,
    $from_name: summary.fromName, $participants: JSON.stringify(summary.participants ?? []),
    $participant_count: summary.participantCount ?? 0, $last_message_at: summary.lastMessageAt,
    $is_starred: summary.isStarred ? 1 : 0, $unread: summary.unread ? 1 : 0,
    $has_notes: summary.hasNotes ? 1 : 0, $assignee_user_id: summary.assigneeUserId,
    $pinned_at: summary.pinnedAt,
  };
}

// Raw sqlite row (snake_case columns) → ThreadSummary.
export function rowToThreadSummary(row: Record<string, unknown>): ThreadSummary {
  return {
    threadId: row.thread_id as string, subject: (row.subject as string) ?? null,
    snippet: (row.snippet as string) ?? null, from: (row.from_addr as string) ?? null,
    fromName: (row.from_name as string) ?? null,
    participants: JSON.parse((row.participants as string) || "[]"),
    participantCount: (row.participant_count as number) ?? 0,
    lastMessageAt: (row.last_message_at as number) ?? null,
    isStarred: !!row.is_starred, unread: !!row.unread, hasNotes: !!row.has_notes,
    assigneeUserId: (row.assignee_user_id as string) ?? null,
    placement: row.placement as string, pinnedAt: (row.pinned_at as number) ?? null,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run src/test/localdb-schema.test.ts`
Expected: PASS (3 tests). If sqlite-wasm needs a node flag, add `--pool=forks` — note the exact command that passes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/src/lib/client/localdb/schema.ts apps/web/src/test/localdb-schema.test.ts
git commit -m "feat(localdb): client SQLite schema + row marshaling for the thread mirror"
```

---

## Task 2: Server hydrate helper — `threadSummariesByIds`

**Files:**
- Modify: `packages/mail-core/src/read.ts`
- Test: `apps/web/src/test/thread-summaries-by-ids.test.ts`

**Interfaces:**
- Consumes: existing `listThreads` internals (same projection/ck).
- Produces: `threadSummariesByIds(db, opts): Promise<ThreadSummary[]>` where
  `opts = { mailboxId: string; threadIds: string[]; ck: ContentKey; userId: string; includeCollab: boolean; assignedTo: string | null }`.
  Returns a `ThreadSummary` for each thread id that is still present in the mailbox
  (any placement); ids no longer present are simply absent (caller treats missing as removed).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/test/thread-summaries-by-ids.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { importKey } from "@doota/mail-core/crypto";
import { threadSummariesByIds } from "@doota/mail-core/read";
// Reuse the invite/ingest helpers already used by other tests to seed a mailbox
// with two delivered threads (see search-index.test.ts for the deliver() pattern).
import { seedMailboxWithThreads } from "./helpers/seed-threads"; // create if absent per existing patterns

let db: any, ck: any;
beforeEach(async () => { db = await makeDb(); ck = await importKey(btoa("0123456789abcdef0123456789abcdef")); });

describe("threadSummariesByIds", () => {
  it("returns summaries only for the requested, still-present threads", async () => {
    const { mailboxId, threadIds } = await seedMailboxWithThreads(db, ck, 3);
    const some = [threadIds[0], threadIds[2], "gone_id"];
    const out = await threadSummariesByIds(db, { mailboxId, threadIds: some, ck, userId: "u1", includeCollab: true, assignedTo: null });
    expect(out.map((summary) => summary.threadId).sort()).toEqual([threadIds[0], threadIds[2]].sort());
  });
});
```

> Note: if `./helpers/seed-threads` does not exist, factor the `deliver()` helper
> out of `search-index.test.ts` into it as part of this task (it already
> materializes + delivers a message and returns thread ids).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/test/thread-summaries-by-ids.test.ts`
Expected: FAIL — `threadSummariesByIds` is not exported.

- [ ] **Step 3: Implement `threadSummariesByIds`**

Add to `packages/mail-core/src/read.ts`, mirroring `listThreads`'s projection but
filtering to the given ids instead of paginating by placement:

```ts
// Hydrate specific threads (used by the local-first delta endpoint). Same
// projection as listThreads; scoped to threadIds, any placement. Missing ids
// (thread deleted / no longer in this mailbox) are simply omitted.
export async function threadSummariesByIds(
  db: Db,
  opts: {
    mailboxId: string; threadIds: string[]; ck: ContentKey;
    userId: string; includeCollab: boolean; assignedTo: string | null;
  },
): Promise<ThreadSummary[]> {
  if (opts.threadIds.length === 0) return [];
  // Reuse the same row-building path listThreads uses. If listThreads is a single
  // query with a WHERE on placement/offset, extract its projection into a shared
  // internal `projectThreadRows(db, { mailboxId, ck, userId, includeCollab,
  // assignedTo, whereThreadIds })` and call it from both. Do NOT duplicate the
  // decrypt/participant logic — DRY.
  return projectThreadRows(db, {
    mailboxId: opts.mailboxId, ck: opts.ck, userId: opts.userId,
    includeCollab: opts.includeCollab, assignedTo: opts.assignedTo,
    threadIds: opts.threadIds,
  });
}
```

Refactor `listThreads` to delegate to the shared `projectThreadRows` so both use
one projection. Keep `listThreads`'s public signature unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run src/test/thread-summaries-by-ids.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing thread/list tests to confirm no regression**

Run: `cd apps/web && pnpm exec vitest run src/test`
Expected: all pass (the `listThreads` refactor is behavior-preserving).

- [ ] **Step 6: Commit**

```bash
git add packages/mail-core/src/read.ts apps/web/src/test/thread-summaries-by-ids.test.ts apps/web/src/test/helpers/seed-threads.ts
git commit -m "feat(read): threadSummariesByIds hydrate helper (shared projection with listThreads)"
```

---

## Task 3: Server endpoints — `seedThreadList` + `threadChanges`

**Files:**
- Modify: `apps/web/src/lib/rpc/thread.remote.ts`
- Test: `apps/web/src/test/localdb-endpoints.test.ts`

**Interfaces:**
- Consumes: `assertMailboxAccess`, `contentKey`, `listThreads`, `threadSummariesByIds`, `changesSince` (from `@doota/mail-core/change-log`), and a "current max seq" read.
- Produces:
  - `seedThreadList(mailboxId: string)` → `{ rows: ThreadSummary[]; cursor: number }` — all placements for the mailbox (so folder switch is fully local), plus the current change_log seq snapshot as `cursor`.
  - `threadChanges({ mailboxId, sinceSeq })` → `{ upserts: ThreadSummary[]; removals: string[]; newSeq: number; cannotCalculate: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/test/localdb-endpoints.test.ts
// SPDX-License-Identifier: Apache-2.0
// Endpoint LOGIC is tested through the exported helpers they wrap (remote fns
// need a request context). We test the wrapped pure functions: buildSeed() and
// buildChanges() extracted from the remote handlers.
import { describe, it, expect, beforeEach } from "vitest";
import { makeDb } from "./mail-db";
import { importKey } from "@doota/mail-core/crypto";
import { seedMailboxWithThreads } from "./helpers/seed-threads";
import { buildSeed, buildChanges } from "$lib/rpc/thread-localdb"; // pure helpers (see Step 3)

let db: any, ck: any;
beforeEach(async () => { db = await makeDb(); ck = await importKey(btoa("0123456789abcdef0123456789abcdef")); });

describe("local-first endpoints", () => {
  it("buildSeed returns every placement's rows + a cursor at the current seq", async () => {
    const { mailboxId } = await seedMailboxWithThreads(db, ck, 2);
    const seed = await buildSeed(db, { mailboxId, ck, userId: "u1", includeCollab: true, assignedTo: null });
    expect(seed.rows.length).toBe(2);
    expect(typeof seed.cursor).toBe("number");
  });

  it("buildChanges hydrates upserts and advances the cursor", async () => {
    const { mailboxId, threadIds } = await seedMailboxWithThreads(db, ck, 1);
    const seed = await buildSeed(db, { mailboxId, ck, userId: "u1", includeCollab: true, assignedTo: null });
    // Simulate a placement change → a change_log row via the real trigger.
    await db.run(`UPDATE thread_state SET placement='archived' WHERE mailbox_id='${mailboxId}'`);
    const delta = await buildChanges(db, { mailboxId, sinceSeq: seed.cursor, ck, userId: "u1", includeCollab: true, assignedTo: null });
    expect(delta.cannotCalculate).toBe(false);
    expect(delta.newSeq).toBeGreaterThan(seed.cursor);
    expect(delta.upserts.some((summary) => summary.threadId === threadIds[0] && summary.placement === "archived")).toBe(true);
  });

  it("buildChanges below the floor signals cannotCalculate", async () => {
    const { mailboxId } = await seedMailboxWithThreads(db, ck, 1);
    await db.insert((await import("@doota/db/mail.schema")).changeLogFloor).values({ mailboxId, floorSeq: 999 });
    const delta = await buildChanges(db, { mailboxId, sinceSeq: 0, ck, userId: "u1", includeCollab: true, assignedTo: null });
    expect(delta.cannotCalculate).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/test/localdb-endpoints.test.ts`
Expected: FAIL — `$lib/rpc/thread-localdb` not found.

- [ ] **Step 3: Implement the pure helpers + wrap them as remote functions**

Create `apps/web/src/lib/rpc/thread-localdb.ts` (pure, testable):

```ts
// SPDX-License-Identifier: Apache-2.0
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { max, eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import type { ContentKey } from "@doota/mail-core/crypto";
import type { ThreadSummary } from "@doota/mail-core/read";
import { listThreads, threadSummariesByIds } from "@doota/mail-core/read";
import { changesSince } from "@doota/mail-core/change-log";

type Db = DrizzleD1Database<typeof schema>;
type Ctx = { mailboxId: string; ck: ContentKey; userId: string; includeCollab: boolean; assignedTo: string | null };

async function currentSeq(db: Db, mailboxId: string): Promise<number> {
  const row = await db.select({ m: max(mail.changeLog.seq) }).from(mail.changeLog).where(eq(mail.changeLog.mailboxId, mailboxId));
  return row[0]?.m ?? 0;
}

export async function buildSeed(db: Db, ctx: Ctx): Promise<{ rows: ThreadSummary[]; cursor: number }> {
  // Snapshot the cursor BEFORE reading rows: a change landing mid-read then re-appears
  // as a delta (idempotent upsert), never lost.
  const cursor = await currentSeq(db, ctx.mailboxId);
  // Seed all placements so folder switches are fully local. listThreads is
  // per-placement; loop the VIEW_PLACEMENTS or add an all-placements path.
  const rows = await listThreads(db, { mailboxId: ctx.mailboxId, ck: ctx.ck, limit: 1000, offset: 0,
    includeCollab: ctx.includeCollab, userId: ctx.userId, assignedTo: ctx.assignedTo, allPlacements: true });
  return { rows, cursor };
}

export async function buildChanges(db: Db, ctx: Ctx & { sinceSeq: number }):
  Promise<{ upserts: ThreadSummary[]; removals: string[]; newSeq: number; cannotCalculate: boolean }> {
  const res = await changesSince(db, ctx.mailboxId, ctx.sinceSeq);
  if (res.cannotCalculateChanges) return { upserts: [], removals: [], newSeq: ctx.sinceSeq, cannotCalculate: true };
  // Map change_log entries → affected thread ids. Email changes → their threadId;
  // Thread changes → objectId directly. (EmailSubmission/Mailbox are ignored for
  // the thread-list surface.)
  const threadIds = await resolveThreadIds(db, ctx.mailboxId, res.changes);
  const present = await threadSummariesByIds(db, { ...ctx, threadIds });
  const presentIds = new Set(present.map((summary) => summary.threadId));
  const removals = threadIds.filter((threadId) => !presentIds.has(threadId));
  return { upserts: present, removals, newSeq: res.newSeq, cannotCalculate: false };
}

// Email objectId → threadId via the message row; Thread objectId is the threadId.
async function resolveThreadIds(db: Db, mailboxId: string, changes: { type: string; objectId: string }[]): Promise<string[]> {
  const ids = new Set<string>();
  const emailIds: string[] = [];
  for (const change of changes) {
    if (change.type === "Thread") ids.add(change.objectId);
    else if (change.type === "Email") emailIds.push(change.objectId);
  }
  if (emailIds.length) {
    const rows = await db.select({ threadId: mail.message.threadId }).from(mail.message)
      .where((await import("drizzle-orm")).inArray(mail.message.id, emailIds));
    for (const row of rows) ids.add(row.threadId);
  }
  return [...ids];
}
```

Then in `thread.remote.ts`, add thin remote wrappers (auth + ck, delegate to the helpers):

```ts
export const seedThreadList = query(z.object({ mailboxId: z.string().min(1) }), async ({ mailboxId }) => {
  const { hasGrant, assignedTo } = await assertMailboxAccess(mailboxId);
  const { locals } = getRequestEvent();
  return buildSeed(locals.db, { mailboxId, ck: await contentKey(), userId: locals.user!.id, includeCollab: hasGrant, assignedTo });
});

export const threadChanges = query(z.object({ mailboxId: z.string().min(1), sinceSeq: z.number().int().min(0) }), async ({ mailboxId, sinceSeq }) => {
  const { hasGrant, assignedTo } = await assertMailboxAccess(mailboxId);
  const { locals } = getRequestEvent();
  return buildChanges(locals.db, { mailboxId, sinceSeq, ck: await contentKey(), userId: locals.user!.id, includeCollab: hasGrant, assignedTo });
});
```

> If `listThreads` has no `allPlacements` option, add one (default false) that
> skips the placement filter — behavior-preserving for existing callers.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run src/test/localdb-endpoints.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `cd apps/web && pnpm exec vitest run && pnpm exec svelte-check --tsconfig ./tsconfig.json --threshold error`
Expected: all pass; only the pre-existing `vite.config.ts` error remains.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/rpc/thread.remote.ts apps/web/src/lib/rpc/thread-localdb.ts apps/web/src/test/localdb-endpoints.test.ts packages/mail-core/src/read.ts
git commit -m "feat(rpc): seedThreadList + threadChanges endpoints on the changesSince substrate"
```

---

## Task 4: SQLite worker + tiered persistence + typed RPC

**Files:**
- Create: `apps/web/src/lib/client/localdb/rpc.ts`
- Create: `apps/web/src/lib/client/localdb/persistence.ts`
- Create: `apps/web/src/lib/client/localdb/worker.ts`
- Test: covered by Task 1 (SQL logic) + Task 9 (e2e for OPFS/worker). Add a small unit test for the RPC envelope.
- Test: `apps/web/src/test/localdb-rpc.test.ts`

**Interfaces:**
- Produces:
  - `rpc.ts`: `type Req`, `type Res`, `createBridge(worker)` → `{ call<T>(method, params): Promise<T> }` (correlates messages by an incrementing id).
  - `persistence.ts`: `pickBackend(sqlite3): Promise<{ kind: "opfs" | "idb"; openDb(name): Db; persist?(db): Promise<void> }>` — tries `opfs-sahpool` install; on failure returns the memory+IndexedDB-snapshot backend.
  - `worker.ts`: message handler implementing methods `open{userId}`, `query{sql,params}`, `applyDeltas{mailboxId,upserts,removals,newCursor}`, `seed{mailboxId,rows,cursor}`, `getCursor{mailboxId}`, `clear{userId}`. Marshals via Task 1's schema helpers. Bumps persistence (snapshot) after mutations via a `Debounced` in the memory tier.

- [ ] **Step 1: Write the failing RPC-envelope test**

```ts
// apps/web/src/test/localdb-rpc.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createBridge } from "$lib/client/localdb/rpc";

// A fake Worker: echoes {id, result: params.n * 2} for method "double".
class FakeWorker {
  onmessage: ((ev: { data: any }) => void) | null = null;
  postMessage(msg: any) {
    queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ok: true, result: msg.params.n * 2 } }));
  }
}

describe("localdb rpc bridge", () => {
  it("correlates a request to its response by id", async () => {
    const bridge = createBridge(new FakeWorker() as any);
    expect(await bridge.call<number>("double", { n: 21 })).toBe(42);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/test/localdb-rpc.test.ts`
Expected: FAIL — `$lib/client/localdb/rpc` not found.

- [ ] **Step 3: Implement `rpc.ts`**

```ts
// apps/web/src/lib/client/localdb/rpc.ts
// SPDX-License-Identifier: Apache-2.0
export type Req = { id: number; method: string; params: unknown };
export type Res = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export function createBridge(worker: Worker) {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  worker.onmessage = (ev: MessageEvent<Res>) => {
    const settle = pending.get(ev.data.id);
    if (!settle) return;
    pending.delete(ev.data.id);
    if (ev.data.ok) settle.resolve(ev.data.result);
    else settle.reject(new Error(ev.data.error));
  };
  return {
    call<T>(method: string, params: unknown): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, method, params } satisfies Req);
      });
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/web && pnpm exec vitest run src/test/localdb-rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `persistence.ts` (tier selection)**

```ts
// apps/web/src/lib/client/localdb/persistence.ts
// SPDX-License-Identifier: Apache-2.0
// Prefer OPFS-sahpool (incremental, no manual snapshot). Fall back to the memory
// VFS + a debounced full-DB snapshot into IndexedDB (universal). Both return an
// oo1.DB; the caller's SQL is identical.
export async function pickBackend(sqlite3: any): Promise<{
  kind: "opfs" | "idb";
  openDb(name: string): any;
  persist(db: any): Promise<void>;
}> {
  // Tier 1: OPFS-sahpool — needs SyncAccessHandle (worker) but NOT COOP/COEP.
  if (sqlite3.installOpfsSAHPoolVfs) {
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "doota-localdb" });
      return { kind: "opfs", openDb: (name) => new pool.OpfsSAHPoolDb(`/${name}.sqlite3`), persist: async () => {} };
    } catch { /* fall through to IDB */ }
  }
  // Tier 2: memory VFS + IndexedDB snapshot.
  const idb = await openIdb("doota-localdb", "snapshots");
  return {
    kind: "idb",
    openDb(name) {
      const db = new sqlite3.oo1.DB(":memory:", "c");
      const snap = readSnapshot(idb, name); // Uint8Array | null (async — see note)
      if (snap) sqlite3.capi.sqlite3_deserialize(db, "main", snap, snap.length, snap.length, 0);
      (db as any).__name = name;
      return db;
    },
    async persist(db) {
      const bytes = sqlite3.capi.sqlite3_js_db_export(db);
      await writeSnapshot(idb, (db as any).__name, bytes);
    },
  };
}
// openIdb/readSnapshot/writeSnapshot: minimal IndexedDB blob store — implement
// with the native IndexedDB API (no dep). readSnapshot at openDb time must be
// awaited before the DB is used; restructure openDb to async if needed.
```

> Implementation note for the executor: `deserialize` needs the snapshot bytes
> before first query, so make `openDb` async in the worker's `open` handler.
> Keep `persist` debounced (Task 6 wires `Debounced`), only in the `idb` tier.

- [ ] **Step 6: Implement `worker.ts`**

```ts
// apps/web/src/lib/client/localdb/worker.ts
// SPDX-License-Identifier: Apache-2.0
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { DDL, upsertThreadSql, deleteThreadSql, listThreadsSql, getCursorSql, setCursorSql, clearMailboxSql, threadSummaryToRow, rowToThreadSummary } from "./schema";
import { pickBackend } from "./persistence";
import type { Req, Res } from "./rpc";

let db: any; let backend: any;

async function open(userId: string) {
  const sqlite3 = await sqlite3InitModule();
  backend = await pickBackend(sqlite3);
  db = await backend.openDb(`u_${userId}`); // per-user file
  db.exec(DDL);
}

const handlers: Record<string, (params: any) => unknown> = {
  open: async ({ userId }) => { await open(userId); return true; },
  seed: ({ mailboxId, rows, cursor }) => {
    db.transaction(() => {
      db.exec({ sql: clearMailboxSql().sql, bind: { $mailbox_id: mailboxId } });
      for (const summary of rows) db.exec({ sql: upsertThreadSql().sql, bind: threadSummaryToRow(mailboxId, summary) });
      db.exec({ sql: setCursorSql().sql, bind: { $mailbox_id: mailboxId, $cursor: cursor } });
    });
    return true;
  },
  applyDeltas: ({ mailboxId, upserts, removals, newCursor }) => {
    db.transaction(() => {
      for (const summary of upserts) db.exec({ sql: upsertThreadSql().sql, bind: threadSummaryToRow(mailboxId, summary) });
      for (const threadId of removals) db.exec({ sql: deleteThreadSql().sql, bind: { $mailbox_id: mailboxId, $thread_id: threadId } });
      db.exec({ sql: setCursorSql().sql, bind: { $mailbox_id: mailboxId, $cursor: newCursor } });
    });
    return true;
  },
  list: ({ mailboxId, placement }) => {
    const out: any[] = [];
    db.exec({ sql: listThreadsSql().sql, bind: { $mailbox_id: mailboxId, $placement: placement }, rowMode: "object", resultRows: out });
    return out.map(rowToThreadSummary);
  },
  getCursor: ({ mailboxId }) => {
    const out: any[] = [];
    db.exec({ sql: getCursorSql().sql, bind: { $mailbox_id: mailboxId }, rowMode: "object", resultRows: out });
    return out[0]?.cursor ?? null;
  },
  clear: ({ userId }) => { db?.close?.(); db = null; return true; }, // caller reopens
};

self.onmessage = async (ev: MessageEvent<Req>) => {
  const { id, method, params } = ev.data;
  try {
    const result = await handlers[method](params);
    if (backend?.kind === "idb" && method !== "list" && method !== "getCursor") await backend.persist(db);
    (self as unknown as Worker).postMessage({ id, ok: true, result } satisfies Res);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: (err as Error).message } satisfies Res);
  }
};
```

- [ ] **Step 7: Typecheck**

Run: `cd apps/web && pnpm exec svelte-check --tsconfig ./tsconfig.json --threshold error`
Expected: no new errors (worker `self` typing may need `/// <reference lib="webworker" />` at the top of worker.ts — add it).

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/client/localdb/rpc.ts apps/web/src/lib/client/localdb/persistence.ts apps/web/src/lib/client/localdb/worker.ts apps/web/src/test/localdb-rpc.test.ts
git commit -m "feat(localdb): SQLite worker with OPFS→IndexedDB tiered persistence + typed RPC"
```

---

## Task 5: Store facade + reactive `liveThreadList`

**Files:**
- Create: `apps/web/src/lib/client/localdb/index.ts`
- Test: `apps/web/src/test/localdb-facade.test.ts` (with a fake bridge)

**Interfaces:**
- Consumes: `createBridge` (Task 4), the worker methods.
- Produces:
  - `localdb`: a singleton facade `{ open(userId), seed(...), applyDeltas(...), getCursor(mailboxId), clear(userId), list(mailboxId, placement) }`.
  - `liveThreadList(getMailboxId: () => string, getFolder: () => string)` → `{ get current(): ThreadSummary[] }` — re-queries when the mailbox's version signal bumps (bumped on seed/applyDeltas).

- [ ] **Step 1: Write the failing test** (fake bridge returns a fixed list; assert `current` updates after `applyDeltas` bumps the version)

```ts
// apps/web/src/test/localdb-facade.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { flushSync } from "svelte";
import { makeLocalDb } from "$lib/client/localdb"; // factory form for testability

it("liveThreadList re-queries after applyDeltas bumps the mailbox version", async () => {
  let rows = [{ threadId: "t1", placement: "inbox" }];
  const bridge = { call: vi.fn(async (method: string) => (method === "list" ? rows : true)) };
  const local = makeLocalDb(bridge as any);
  const live = local.liveThreadList(() => "mb_a", () => "inbox");
  await local.list("mb_a", "inbox"); // prime
  flushSync();
  rows = [{ threadId: "t1", placement: "inbox" }, { threadId: "t2", placement: "inbox" }];
  await local.applyDeltas("mb_a", [], [], 5);
  flushSync();
  expect(live.current.length).toBe(2);
});
```

- [ ] **Step 2: Run it to verify it fails** (`cd apps/web && pnpm exec vitest run src/test/localdb-facade.test.ts`) — FAIL, module missing.

- [ ] **Step 3: Implement `index.ts`** — factory `makeLocalDb(bridge)` + a default singleton that lazily constructs the real `Worker` (`new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`) and bridge. `liveThreadList` holds a `$state<ThreadSummary[]>` and a per-mailbox version `$state` map; `applyDeltas`/`seed` bump the version; a `$effect`/`watch` re-runs `list` when `(mailboxId, folder, version)` changes.

- [ ] **Step 4: Run it to verify it passes.**

- [ ] **Step 5: Commit** (`git commit -m "feat(localdb): facade + reactive liveThreadList"`)

---

## Task 6: Sync engine (runed `FiniteStateMachine`)

**Files:**
- Create: `apps/web/src/lib/client/localdb/sync.svelte.ts`
- Test: `apps/web/src/test/localdb-sync.test.ts`

**Interfaces:**
- Consumes: the facade (Task 5), `seedThreadList`/`threadChanges` (injected as async fns for testing), the `realtime` bus `$state` (from `$lib/client/mail-events.svelte`).
- Produces: `createSync({ localdb, seedFn, changesFn })` → `{ ensure(mailboxId), onRealtime(mailboxId), state }` using a `FiniteStateMachine` with states `idle | seeding | live | resyncing | error`.

- [ ] **Step 1: Write failing tests** for the transitions (inject fakes):
  - empty store + `ensure` → calls `seedFn`, store seeded, state `live`.
  - `onRealtime` in `live` → calls `changesFn(cursor)`, applies upserts/removals, cursor advances.
  - `changesFn` returns `cannotCalculate` → reseeds (calls `seedFn`).

```ts
// apps/web/src/test/localdb-sync.test.ts (sketch — full assertions in impl)
import { createSync } from "$lib/client/localdb/sync.svelte";
// fake localdb records seed/applyDeltas/getCursor; fake seedFn/changesFn return canned data.
// assert: ensure() seeds when cursor null; onRealtime pulls+applies; cannotCalculate reseeds.
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement `sync.svelte.ts`** with `FiniteStateMachine`. `ensure(mailboxId)`: if `getCursor` null → `seeding` (call `seedFn`, `localdb.seed`, → `live`); else → `resyncing` catch-up. `onRealtime(mailboxId)`: `resyncing` → `changesFn(cursor)`; on `cannotCalculate` → `seeding`; else `applyDeltas` → `live`. Guard concurrent runs (a `busy` flag / FSM state) so overlapping events don't double-pull.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** (`git commit -m "feat(localdb): FiniteStateMachine sync engine (seed + delta catch-up)"`)

---

## Task 7: Wire the inbox list to read local-first

**Files:**
- Modify: `apps/web/src/routes/(app)/app/+page.svelte`
- Manual/e2e verification (Task 9).

**Steps (each its own checkbox; no unit test — behavior verified in Task 9 e2e):**

- [ ] **Step 1:** On mount, `localdb.open(currentUserId)` once; create the sync engine with the real `seedThreadList`/`threadChanges` remote fns.
- [ ] **Step 2:** Replace the `items` source: derive the rendered list from `liveThreadList(() => mailboxId, () => placement)` when the store is ready; keep the existing remote `mailboxThreads` as the initial/fallback source (store not ready, or `open` failed). Guard with a `localReady` flag.
- [ ] **Step 3:** `watch` active `mailboxId` → `sync.ensure(mailboxId)`.
- [ ] **Step 4:** `watch` the `realtime` bus event → `sync.onRealtime(mailboxId)` (replaces/augments today's refetch for the list surface).
- [ ] **Step 5:** In the existing optimistic action handlers (archive/star/read/move), also patch the local store (`localdb.applyDeltas(mailboxId, [patchedSummary], [], currentCursor)` or a targeted upsert) so the row updates instantly; the server delta reconciles.
- [ ] **Step 6:** Validate with the Svelte MCP autofixer; run `svelte-check`.
- [ ] **Step 7:** Commit (`git commit -m "feat(inbox): read thread list local-first with remote fallback"`)

---

## Task 8: Per-user lifecycle + security doc note

**Files:**
- Modify: the logout / account-switch flow (`$lib/client/auth-client` callers, or `(app)/+layout.svelte`)
- Modify: `apps/docs/src/content/docs/reference/security.mdx`

- [ ] **Step 1:** On logout and on account switch (multiSession), call `localdb.clear(userId)` before the session changes, so no user's mirror survives into another session. Verify the worker drops the DB (and, in the idb tier, deletes the snapshot key).
- [ ] **Step 2:** Add a row to the security "what is encrypted" table: local thread-mirror = **plaintext on device** (subjects/snippets), per-user, cleared on logout — zero-access-at-rest is a server property.
- [ ] **Step 3:** `svelte-check` + docs build.
- [ ] **Step 4:** Commit (`git commit -m "feat(localdb): clear mirror on logout/switch + document the local plaintext posture"`)

---

## Task 9: End-to-end + device verification

**Files:**
- Create: `apps/web/e2e/local-first.spec.ts`

- [ ] **Step 1:** Playwright test (reuse the repo's e2e harness/creds): log in, open a mailbox, assert the thread list renders; switch folder → assert no network request for the list (route interception) and instant render; reload → assert the list paints from the persisted store before any network.
- [ ] **Step 2:** Fallback path: run with a context that blocks Workers/OPFS/IndexedDB → assert the list still renders via the remote function (no crash).
- [ ] **Step 3:** Live update: trigger a state change (star a thread) in one tab → assert the list row updates (reconciled via delta) without a full refetch.
- [ ] **Step 4:** Manual pass on iOS Safari 17+ (OPFS-sahpool) and one non-OPFS browser (IndexedDB tier) — record results in the PR.
- [ ] **Step 5:** Full gate: `pnpm -C apps/web exec vitest run` + `svelte-check` + `pnpm -C packages/mail-core exec tsc --noEmit`.
- [ ] **Step 6:** Commit (`git commit -m "test(localdb): e2e for persistence, instant nav, fallback, live update"`)

---

## Self-Review

**Spec coverage:**
- Instant thread-list on folder switch / mailbox open → Tasks 5–7 (local read) ✓
- Persistent SQLite mirror, OPFS-preferred + IndexedDB fallback → Task 4 ✓
- Seed + `changesSince` delta endpoints → Tasks 2–3 ✓
- Realtime-triggered live update → Task 6 (`onRealtime`) + Task 7 Step 4 ✓
- Read-only mirror + optimistic reconcile → Task 7 Step 5 ✓
- runed `FiniteStateMachine`/`watch`/`useEventListener`/`Debounced` → Tasks 6–7 + Task 4 (Debounced snapshot) ✓
- Per-user DB + logout clear → Task 8 ✓
- Plaintext posture doc → Task 8 ✓
- Tests (unit sync, endpoints, local SQL, e2e) → Tasks 1,3,5,6,9 ✓

**Placeholder scan:** Tasks 5, 6, 7, 8 describe some steps prose-first where the code is either a straightforward wiring of already-defined interfaces (Task 5/6 implementations reference exact method names from their Interfaces blocks) or a Svelte-file edit best validated via MCP + e2e rather than a node unit test. Executors must still produce full code; the Interfaces blocks pin every name/type they need. No `TBD`/`handle edge cases`-style gaps in the server/SQL tasks (1–3) where correctness is subtle.

**Type consistency:** `ThreadSummary` (from `@doota/mail-core/read`) is the single wire+mirror type end to end; `threadSummaryToRow`/`rowToThreadSummary` are the only marshaling seam; worker methods (`open/seed/applyDeltas/list/getCursor/clear`) match between Task 4 (worker) and Task 5 (facade); `buildSeed`/`buildChanges` signatures match between Task 3 impl and its test.

## Notes for the executor
- `@sqlite.org/sqlite-wasm` in node uses the memory VFS only — that's exactly what Task 1's SQL tests want. OPFS/worker paths are browser-only (Task 9 e2e).
- If vitest can't load the wasm, run those files with `--pool=forks` and record the working command in the task.
- Do not push until the full gate passes (Global Constraints).
