# e2e smoke

One runtime smoke against a **deployed** stack, for the class of bug unit tests
can't see: opaque-origin/CORS, iframe sandbox + CSP, rAF throttling in sandboxed
frames, `color-scheme` canvas, cross-frame `postMessage`, downloads.

Flow: login → open a thread with an attachment → preview in the sandboxed frame
→ trigger a download.

```bash
SMOKE_EMAIL=you@example.com SMOKE_PASSWORD=… \
  pnpm --filter @doota/web run test:e2e
```

Env (all optional except email/password):

| var | default | notes |
| --- | --- | --- |
| `SMOKE_BASE_URL` | `https://mail.emailer.dev` | deployed origin to hit |
| `SMOKE_EMAIL` | — | **required** — login email |
| `SMOKE_PASSWORD` | — | **required** — login password |
| `SMOKE_CHROME` | common OS paths | path to a Chrome/Chromium binary |

Uses the system Chrome via `puppeteer-core` (no browser download). **Skips with
exit 0** when email/password or Chrome are absent, so it's safe to leave in a
default test run or a CI job without secrets — it only asserts when configured.
Needs a 2FA-free account (or a session cookie) and at least one attachment in the
account's Sent view.

---

## local-first smoke (`local-first.mjs`)

Verifies the local-first thread-mirror feature introduced in
`feat/local-first-thread-mirror`. **Requires that branch deployed to the target
stack** — running it against a stack without the feature will likely fail checks
2 and 3 (folder switch will fire network requests; no IndexedDB mirror DB will
exist).

Flow:

1. Login → open inbox → assert the thread list renders.
2. Switch folders (inbox → sent → inbox) and assert **no** remote list fetch
   fires (the mirror serves from local store).
3. Assert an IndexedDB database for the mirror exists (OPFS via the SQLite-WASM
   worker is not introspectable from CDP, but its IDB-backed fallback is).
4. Block the list endpoint, reload → assert the list paints from the persisted
   store (before network).
5. Wipe storage via CDP, reload → assert the list still renders via the remote
   fallback path (no crash).
6. Navigate away and back (reconnect) → assert no console errors.

```bash
SMOKE_LOCAL_FIRST=1 SMOKE_EMAIL=you@example.com SMOKE_PASSWORD=… \
  node apps/web/e2e/local-first.mjs
```

Env:

| var | default | notes |
| --- | --- | --- |
| `SMOKE_LOCAL_FIRST` | — | **required** — opt-in flag; without it the script exits 0 immediately |
| `SMOKE_BASE_URL` | `https://mail.emailer.dev` | deployed origin to hit |
| `SMOKE_EMAIL` | — | **required** — login email |
| `SMOKE_PASSWORD` | — | **required** — login password |
| `SMOKE_CHROME` | common OS paths | path to a Chrome/Chromium binary |

**What cannot be verified without a deploy + manual pass:**

- **OPFS persistence** (SQLite-WASM OPFS VFS) — CDP's `IndexedDB` domain does
  not surface OPFS files; only the IDB-backed tier is introspectable. A manual
  pass in Chrome DevTools → Application → Storage → OPFS is required.
- **iOS Safari 17+ OPFS-sahpool tier** — needs a real device or simulator; must
  be verified manually.
- **Non-OPFS browser (IndexedDB tier)** — Firefox or older Chrome; manual pass.
- **Live delta update** (star a thread in Tab A → Tab B row updates without
  refetch) — requires a real realtime event; not triggered automatically.
- **Component reactivity under concurrent edits** — unit tests cover reconcile
  logic; browser behaviour under real concurrent writes needs manual observation.
