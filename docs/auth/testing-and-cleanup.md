# Testing auth locally & cleanup

## Prerequisites

```bash
pnpm db:migrate:local          # apply migrations to the local D1
pnpm dev                        # dev server on :5173
```

**`ORIGIN` must match the dev port.** Better Auth's `svelteKitHandler` only
mounts `/api/auth/*` when the request origin equals the `ORIGIN` env var. `.env`
sets `ORIGIN=http://localhost:5173`. To run on another port, drop a temporary
`.env.local` (Vite gives it priority) and delete it afterward:

```bash
printf 'ORIGIN="http://localhost:5199"\n' > .env.local
pnpm dev --port 5199 --strictPort
# ... test ...
rm .env.local
```

Sanity check that auth is mounted:

```bash
curl -s localhost:5173/api/auth/ok      # -> {"ok":true}
```

## What can be tested with curl

Better Auth JSON endpoints work directly:

```bash
# generic response + rate limit (3/min)
curl -s -X POST localhost:5173/api/auth/request-password-reset \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' \
  -d '{"email":"someone@domain.tld","redirectTo":"/reset-password"}'

# sign-in rate limit (5/min) — expect 429 on the 6th wrong attempt
```

**Remote functions (create-admin, setRecoveryEmail) cannot be driven by curl** —
SvelteKit's remote-form POST uses a binary wire protocol. Test those through the
browser, or exercise the same `internalAdapter` sequence from a throwaway
dev-only `+server.ts` (guard it with `if (!dev) error(404)` and delete it after).

## Inspecting local D1

```bash
pnpm wrangler d1 execute doota --local --command "SELECT email, role FROM user;"
```

## Cleanup — MANDATORY after any test that creates admins/users

Any test that creates users, verification tokens, or rate-limit rows **must
clean up after itself.** Do not leave test accounts in the local D1 — a leftover
user makes the create-admin bootstrap guard (`userCount > 0`) refuse to run, and
stale rows pollute later tests.

Scope deletes to your known test emails (safer than truncating). Deleting from
`user` cascades to `session`/`account`/`two_factor`/`passkey`; `verification`
and `rate_limit` have no FK and are cleared separately:

```bash
pnpm wrangler d1 execute doota --local --command "
  DELETE FROM user WHERE email LIKE '%@your-test-domain';
  DELETE FROM verification;
  DELETE FROM rate_limit;"
```

Also remove any throwaway route and the temporary `.env.local`:

```bash
rm -rf src/routes/<throwaway-test-route> .env.local
lsof -ti :5199 | xargs kill 2>/dev/null   # stop the test dev server
```

Verify a clean slate:

```bash
pnpm wrangler d1 execute doota --local --command \
  "SELECT (SELECT COUNT(*) FROM user) AS users,
          (SELECT COUNT(*) FROM verification) AS verifs,
          (SELECT COUNT(*) FROM rate_limit) AS ratelimits;"
```

## CLI superadmin recovery (test on local first)

```bash
pnpm reset-admin admin@domain.tld <new-password>            # local
pnpm reset-admin admin@domain.tld <new-password> --remote   # production D1
pnpm reset-admin admin@domain.tld <new-password> --clear-2fa
```
