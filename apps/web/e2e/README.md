# e2e smoke

Three runtime suites against a **deployed** stack (`smoke.mjs`, `full-sweep.mjs`,
`deep-sweep.mjs`), for the class of bug unit tests can't see: opaque-origin/CORS,
iframe sandbox + CSP, rAF throttling in sandboxed frames, `color-scheme` canvas,
cross-frame `postMessage`, downloads, and whole-app functional regressions.

## Suites

| file | scope | run |
| --- | --- | --- |
| `smoke.mjs` | attachment preview + download | `pnpm --filter @doota/web run test:e2e` |
| `full-sweep.mjs` | breadth: auth, folders, filters, threads, quick actions, bulk, compose, search, settings, templates, admin gating, PWA/offline | `node e2e/full-sweep.mjs [core\|actions\|peripheral\|offline]` |
| `deep-sweep.mjs` | depth: attachments, thread menus, move/labels, find, contacts, calendar RSVP, theme/sidebar, notifications, template CRUD | `node e2e/deep-sweep.mjs` |

Both sweeps are **non-destructive**: stars/pins are toggled back, archives are
undone, nothing is sent (staging may only mail `shivam@doota.dev`) and nothing is
hard-deleted.

### Selector gotchas these suites encode

Learned the hard way; keep them in mind before "fixing" a failing check:

- **Draft and search rows are not `[data-row]`** — drafts render `.group/row`
  divs, search hits render plain full-width `<button>`s. Counting `[data-row]`
  reports zero and looks like a broken view.
- **bits-ui dropdowns/menus open on `pointerdown`**, and never open at all in
  **headless** Chrome. Run headed, and dispatch a synthetic `PointerEvent`
  rather than relying on CDP mouse input.
- **`Emulation.setFocusEmulationEnabled` is required** — without it
  `document.hasFocus()` is false whenever Chrome isn't the OS key window and
  several focus-gated surfaces silently do nothing.
- **Chrome swallows a real ⌘K** (its own shortcut). Dispatch a synthetic
  `keydown` with `metaKey` to exercise the app's palette handler.
- **`page.keyboard.type` does not reach ProseMirror** — use
  `document.execCommand("insertText", …)` to put text in the composer.
- **Checkbox `textContent` is `""`, not null**, so `textContent ?? ariaLabel`
  never falls through. Match on `aria-label` directly.
- **The sweep account is a Member**, so `/admin/*` and `/account/developer`
  correctly redirect away. That is the gate working, not a failure — run as an
  admin to exercise those pages themselves.

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
7. Click the first `[data-row]` → assert thread view renders (message content
   present).
8. Navigate back to inbox then re-open the same thread → assert the thread renders
   from the mirror (reports any background body fetches but does not fail on them —
   same honest posture as check 2).
9. Reload with the thread open → assert the thread or list still renders (persisted
   mirror intact).
10. Open a thread → assert `iframe[srcdoc]` is present (rich HTML message rendered
    from the local framed-body store); skips rather than fails if the first thread
    is plain-text only.
11. **Offline full-timeline (slice-3 win)** — open a thread once to seed the
    full timeline (messages, internal notes, system events) into the mirror, then
    block all `openThread` and `/api/messages/*/body` network calls, reload, and
    re-open the same thread. Assert the thread timeline still renders entirely from
    the local mirror. Note and system-event sub-assertions are skipped (not failed)
    if the test mailbox has no notes or system events.

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
- **srcdoc from cold mirror** (check 10) — confirming the iframe uses `srcdoc`
  specifically when the body is served from the local store (vs. a live fetch)
  requires the test account to have a rich HTML message and a deployed
  `renderFramedBody` + mirror; the check reports honestly if no iframe is found.
- **Zero body fetch on re-open** (check 8) — verifying no background body fetch
  fires at all (not just that the render is local) needs the background-sync
  optimization to land; current check asserts render, not strict zero-network.
- **Internal-note and system-event rows in offline check** (check 11) — the
  note/system-event sub-assertions require the test mailbox to have threads with
  internal notes or system events; the check skips those sub-assertions and
  reports honestly if the test account lacks them. Full verification needs a
  mailbox with a note or a system event (e.g., a thread where a status was set).
