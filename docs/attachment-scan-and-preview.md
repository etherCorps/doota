# Attachment scan & preview

Developer/operator reference for how attachments are checked and rendered. The
user-facing version is `apps/docs` → Using Doota → Attachments.

## The gate: scan, then act

Every attachment click routes through one gate (`attachment-gate.svelte.ts`).
It never blocks — the verdict is **advisory**, shaping the label and the confirm
copy, never authorizing anything.

1. **Ensure a verdict.** A persisted verdict from the *current* ruleset wins (no
   rescan); otherwise the client scans the bytes. Verdicts:
   `clean · matched · skipped · error` — fail-closed: a scan failure is `error`,
   never `clean`.
2. **Act.** `clean` proceeds straight through; `matched`/`skipped`/`error` fail
   **open behind an explicit confirm** (the app never hard-blocks a user's own
   mail). The confirm verb matches the action — *Preview anyway* vs
   *Download anyway*.

`openAttachment()` view-routes by type; `downloadAttachment()` is a separate
path that never opens a viewer (the lightbox's own Download uses it). Both share
the same scan step.

**Eager prefetch.** Tiles kick the scan on mount so the verdict is usually in
before a click. Budgeted: files over 8 MB are skipped (the click still scans),
and prefetch runs sequentially so a many-attachment thread doesn't burst-fetch.

### The scanner

- Engine: `@doota/mail-core/attachment-scan` — a pure `scanBuffer(scanner,
  inflate, bytes, filename)`. yara-x (WASM) runs in a Web Worker
  (`scan.worker.ts`); the ruleset is `DEFAULT_YARA_RULES` (bundled, no CDN).
- **Zip-bomb caps** reject on the DECLARED central-directory sizes *before*
  decompressing: 25 MB scan cap, depth 3, 1000 entries, 200 MB total, 100× ratio.
- Rules cover embedded PE, OLE/OOXML macros, PDF JavaScript/Launch actions,
  script-bearing SVG, and the EICAR test file. `SCANNER_VERSION` stamps every
  verdict; a rules bump invalidates persisted verdicts so stale results heal on
  next open. (rules-2 dropped the `/OpenAction` PDF false positive.)
- The verdict is persisted (`recordScanVerdict`) behind the same access check as
  the bytes, so a teammate reuses a scan instead of rescanning.

## The two viewers

Which shell renders a file is the single source of truth `viewerFor(contentType,
filename)` in `attachment-viewable.ts`:

| Shell | Route | Types | Isolation |
| --- | --- | --- | --- |
| **base** | `/api/attachment-view` | pdf, images, svg, **audio, video**, text/json/xml | **Opaque origin** — `sandbox="allow-scripts"`, NO `allow-same-origin`. Hard-isolated. |
| **rich** | `/viewer` | Office, archives, **markdown**, epub | Same-origin, session-gated. Weaker; compensated by CSP. |

Markdown routes **rich** even though its MIME is `text/*` (checked ahead of the
base text branch) so it renders formatted, not flat.

### Base viewer (opaque, maximal isolation)

`/api/attachment-view` serves a hand-built HTML doc in an opaque-origin iframe.
It never fetches mail — the parent fetches the already-scanned bytes and posts
them in (`connect-src 'none'`). It never uses `innerHTML` on attacker bytes:
images/SVG as non-scriptable `<img blob:>`, text via `textContent`, audio/video
as `<… controls>` from a blob (media bytes are inert), PDF painted to `<canvas>`
by offline pdfjs (main-thread "fake worker"; `intent:"print"` because Chrome
throttles rAF in sandboxed frames). The classic exploit vectors (PDF!) stay here.

### Rich viewer (file-viewer, same-origin)

`/viewer` serves the `@file-viewer/web-full` shell (Apache-2.0, fully
self-hosted under `/file-viewer/`). It's **session-gated** (401 unauth) — not a
public endpoint, and **no second domain** (an ops burden for self-hosters was
vetoed). Same-origin is weaker isolation, compensated in the route's CSP:

- `script-src 'self' 'wasm-unsafe-eval'` — only our vendored tree executes;
  wasm-eval is needed for the archive pipeline's main-thread libarchive.
- `connect-src ${origin}/file-viewer/` — path-scoped, so a compromised renderer
  can't reach `/api/*` even sharing the origin.
- The session cookie is HttpOnly (unreadable by script).

**Residual risk (accepted, documented here):** dedicated Workers don't inherit
the document CSP, so a worker-side renderer exploit could make authenticated
same-origin fetches. The scan gate and pinned script sources are the layers in
front of it; PDF deliberately does not take this trade.

## Operator notes

- Preview assets are vendored at prepare time (`scripts/copy-file-viewer.mjs`,
  ~177 MB, gitignored) from `tools/file-viewer-assets` (a standalone package,
  kept out of the workspace so its `sql.js`/`pg` peers don't fork `drizzle-orm`).
  Files over the Cloudflare 25 MiB per-asset cap are dropped (only the typst wasm
  compiler — typst falls back to download).
- No extra DNS/cert, no CDN, no external scan service — all self-contained.
- Smoke: `pnpm --filter @doota/web run test:e2e` (login → preview → download
  against a deployed stack; see `apps/web/e2e/README.md`).
