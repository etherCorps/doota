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
