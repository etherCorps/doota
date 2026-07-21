# Client-side memory-leak testing (memlab)

[memlab](https://github.com/facebook/memlab) drives headless Chrome, takes heap
snapshots before/after an interaction, and diffs them to find objects retained
after they should have been freed — detached DOM nodes, un-removed listeners,
effect closures that never tear down. It's how we catch the class of bug that hit
the Insights page (a self-retriggering `$effect` that refetched forever).

`leak/run.mjs` sweeps every admin page: for each it loads a start route,
SPA-navigates INTO the page (mount + fire its fetches/effects), then SPA-navigates
OUT (unmount), and memlab heap-diffs the cycle. `back()` is always an in-app link
click — never a reload — because memlab can't diff across full page loads.

This is an **on-demand** tool, not part of `pnpm check`/CI: it needs a running
app, a browser, and an authenticated session.

## One-time setup

memlab uses Puppeteer's Chromium. It's allowed to download via
`onlyBuiltDependencies` in the root `pnpm-workspace.yaml`; if it didn't fetch,
`pnpm approve-builds` (tick puppeteer) then `pnpm install`. Or point at an
existing browser: `export PUPPETEER_EXECUTABLE_PATH=/path/to/chrome`.

## Run

1. Start the app: `pnpm --filter doota dev` (or `build` + `preview` for a
   production-like bundle — leaks can differ).
2. Log in as an admin of the org you want to test. In devtools → Application →
   Cookies, copy the Better Auth session cookie value.
3. Sweep all pages:

```bash
LEAK_ORG_ID=org_xxx LEAK_SESSION_COOKIE=<cookie value> pnpm --filter doota leak
```

Or one page (substring match on the name):

```bash
LEAK_ORG_ID=org_xxx LEAK_SESSION_COOKIE=… LEAK_ONLY=insights pnpm --filter doota leak
```

It prints a per-page summary and exits non-zero if any page leaked.

### Pages covered

- **Admin org tabs**: `overview · members · mailboxes · suppressions · insights ·
  domain · settings · mailbox-detail`
- **Admin sidebar**: `dashboard · organizations · oversight`
- **Account**: `account-profile · account-security · account-mail · account-developer`
- **Mail client**: `app` (folder switching within `/app`)

A few are data-dependent — `mailbox-detail` needs the org to have a mailbox (its
"Manage" link), and `app` needs an "Inbox"/"Sent" folder. If the `enter` click
finds nothing the cycle is a no-op (reports clean, tests nothing); seed the data
or adjust the click target. Add pages in the `pages` map in `run.mjs`
(`enter`/`leave` are SPA link clicks by text or href).

### Env vars

| var | default | notes |
| --- | --- | --- |
| `LEAK_ORG_ID` | — (required) | org whose admin pages are tested |
| `LEAK_SESSION_COOKIE` | — | admin session; without it pages redirect to login |
| `LEAK_ONLY` | — | run only pages whose name contains this |
| `LEAK_COOKIE_NAME` | `better-auth.session_token` | override if your cookie name differs |
| `LEAK_BASE_URL` | `http://localhost:5173` | dev server; use the preview URL for prod builds |

## MCP (optional)

memlab also ships an MCP server (`@memlab/mcp-server`) for driving leak
investigations conversationally. Install globally and add to your editor's MCP
config with `NODE_OPTIONS=--max-old-space-size=8192`. The prerequisites (running
app, Chromium, session) are the same as the CLI.
