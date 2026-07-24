# Contributing to Doota

Thanks for your interest in improving Doota. This document covers how to build
and test the project, how we expect commits and pull requests to look, and the
sign-off every contribution must carry.

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Building and testing

Doota is a pnpm monorepo (`apps/*` + `packages/*`). You need **Node 22+**,
[pnpm](https://pnpm.io), and a Cloudflare account for the mail pipeline.

```sh
pnpm install
cp .env.example .env      # fill in the values (see README → Environment)
pnpm db:migrate:local     # apply D1 migrations to the local database
pnpm dev                  # http://localhost:5173
```

Before opening a pull request, run the checks the CI runs:

```sh
pnpm check                # auth-boundary guard + svelte-check
pnpm test                 # the Vitest suite
```

Both must pass. If your change touches the database schema, generate a migration
(`pnpm db:generate`) and commit it alongside the code — the test suite applies
real migrations to an in-memory database, so schema changes without a migration
will fail.

## Commit and pull-request conventions

- **One logical change per pull request.** Keep the diff focused; unrelated
  cleanups belong in their own PR.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org):
  `type(scope): summary` — e.g. `fix(mail-core): fence outbound claim against double send`.
  Common types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`.
- Write the summary in the imperative mood ("add", not "added"), under ~72
  characters. Explain the *why* in the body when it isn't obvious.
- **Every commit must be signed off** (see DCO below).
- Open the PR against `main`. Describe what changed and how you verified it.
  Link any related issue.
- Discuss new features in an issue before implementing so we can agree on the
  approach first.

## License and per-file headers

Doota is licensed under the [Apache License 2.0](LICENSE). Contributions are
accepted under the same license.

New source files carry an SPDX identifier as the first line, in the file's
comment syntax:

```ts
// SPDX-License-Identifier: Apache-2.0
```

```svelte
<!-- SPDX-License-Identifier: Apache-2.0 -->
```

Do not add a personal copyright line to files — attribution is tracked through
git history and the project-level `NOTICE`.

## Developer Certificate of Origin (DCO)

Doota uses the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a CLA. Every commit must be signed off. Add the sign-off
automatically with:

```sh
git commit -s -m "feat(scope): your change"
```

That appends a line to the commit message:

```
Signed-off-by: Your Name <you@example.com>
```

Use your real name and an email you can be reached at. Commits without a
`Signed-off-by` trailer will not be merged.

Signing off certifies that you wrote the contribution or otherwise have the
right to submit it, that you are submitting it under the project's Apache-2.0
license, and that you understand the contribution — including your name and
email in the sign-off — is public and will be redistributed and permanently
recorded as part of the project's history.

The full text of the certificate you agree to with each sign-off:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
