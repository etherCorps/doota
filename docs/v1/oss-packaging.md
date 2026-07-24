# Claude Code Prompt — OSS packaging and release readiness

> Task 6, the final build-order item. Reference docs in repo: `AUTH_HANDOFF.md`,
> `ARCHITECTURE.md`, `SCOPE.md`.

## Context
Doota is an open-source, **self-hosted** email app on Cloudflare — explicitly not a SaaS.
SvelteKit (Svelte 5 runes) + Cloudflare Workers + D1 + R2 + Queues + Drizzle + Better Auth.
`organization = one domain`. The thesis is email rendered as a messaging app.

**The product loop is complete**: auth and org management, domain onboarding, mailbox model
and inbound pipeline, outbound (`mail-out`, submissions, bounces, rate limiting), compose +
drafts + from-selector, and the collaboration layer (internal notes, assignment, system
events).

This task is not a feature. It is the difference between a repo people admire and one they
can actually run. `doota.dev` is currently an announcement page; the deliverables here are
what make it real.

## Read before writing — and STOP to report conflicts
Read `AUTH_HANDOFF.md`, `ARCHITECTURE.md`, `SCOPE.md`, `MIGRATION_NOTES.md`, `wrangler`
config, the CLI setup/`reset-admin` command, `crypto.ts`, `search.ts`, and every place an
environment variable or secret is read. Produce a conflict list FIRST and STOP for review.

## DECISION 1 — What is actually encrypted at rest? (resolve before writing any docs)
`ARCHITECTURE.md` states two things that must be reconciled precisely before we make
security claims in public:
- **"Raw is truth"** — the canonical RFC 5322 blob lives in R2.
- **"Encrypt content only"** — subject and bodies are encrypted in D1; routing and threading
  metadata stay cleartext.

Determine and report, from the code, **whether the raw MIME blob in R2 is encrypted**.
The answer changes both the security posture and the operational story:
- If R2 raw is **cleartext**, then D1 content encryption is substantially weakened — the
  plaintext of every message sits in R2 — and the public claim must be worded accordingly.
- If R2 raw is **encrypted**, then losing the DEK means every message is permanently
  unrecoverable, and key backup becomes the single most important operator instruction in
  the project.

Do not paper over this. Report the actual state, flag it as a security finding if the
implementation does not match the documented intent, and propose the fix. Documentation must
describe what the code does, not what we meant.

## DECISION 2 — Can Deploy-to-Cloudflare actually deliver a working instance?
Verify against **current Cloudflare documentation**, not assumption, and report:
- What the Deploy-to-Cloudflare button can provision automatically — D1 databases, R2
  buckets, Queues, Workers bindings — and what it cannot.
- How (or whether) it can prompt for secrets: `CF_API_TOKEN`, the DEK, `SEARCH_KEY`.
- Whether Email Routing configuration and the catch-all rule can be established as part of
  the deploy, or must be a post-deploy step.
- Whether the CLI genesis step (`reset-admin` / first-run setup) can run in that flow.

Then choose honestly between: (a) a genuine one-click button, (b) a button that provisions
infrastructure plus a short, explicit post-deploy checklist, or (c) no button and a clean
scripted install. **A button that half-works is worse than no button** — it produces broken
instances and support load. State the recommendation and why.

## Part A — Licensing and governance
Per `SCOPE.md`, this is **settled** — implement it, do not re-litigate:
**Apache-2.0, copyright Ethercorps, contributions under a DCO.**

- `LICENSE` — Apache-2.0, full unmodified text, with a copyright line naming **Ethercorps**
  (not an individual).
- `NOTICE` — per Apache-2.0 convention.
- `CONTRIBUTING.md` — how to build, test, and submit; commit and PR conventions; and the
  **DCO requirement**: contributors add `Signed-off-by:` via `git commit -s`. Include the
  standard Developer Certificate of Origin 1.1 text verbatim and explain in one short
  paragraph what signing off certifies (that they wrote it or have the right to submit it,
  that it is submitted under the project licence, and that the contribution is public and
  permanently recorded).
- **DCO enforcement in CI** — a sign-off check on PRs (e.g. the DCO GitHub App or an
  equivalent workflow step), with a clear failure message telling contributors how to amend
  a commit to add the sign-off.
- `CODE_OF_CONDUCT.md`.
- Per-file or header attribution consistent with Apache-2.0 practice.

Do **not** add a CLA, a CLA bot, or any contributor agreement beyond the DCO. Apache-2.0 §5
already covers inbound licence and patent terms; the DCO adds provenance without the
friction. If you believe something here is legally inconsistent, report it rather than
substituting your own instrument.

> Use the standard, unmodified Apache-2.0 and DCO 1.1 texts. Do not draft, paraphrase, or
> "improve" legal language — reproduce the canonical text exactly and flag anything that
> looks inconsistent instead of inventing wording.

## Part B — `SECURITY.md` and an honest threat model
This is an email application with at-rest encryption. Over-claiming here is the fastest way
to lose credibility and to get someone hurt.

- State plainly: **zero-access at rest is not end-to-end encryption.** The operator can
  decrypt content by design — operator oversight is intended. Say who can read what.
- Document what is encrypted and what is not, per Decision 1, including that routing and
  threading metadata are cleartext by design so the hot path works.
- Key management: where the DEK and `SEARCH_KEY` live (Worker secret / Secrets Store, never
  D1), how to back them up, how to rotate them, and **exactly what is lost if they are
  lost**. This is the highest-stakes operator instruction in the project — make it
  impossible to miss.
- Scoped Cloudflare API token: required permission set, why the Global API Key must never be
  used, and rotation guidance.
- Vulnerability disclosure: contact and expected response.
- Named dependency risk: Cloudflare Email Service is public beta; the provider adapter and
  Resend fallback exist for that reason.

## Part C — README
The README is the pitch and the first five minutes.
- What Doota is, in two sentences, and what it explicitly is not (not a SaaS, not a
  hosted service).
- Screenshots or a short demo of the conversation timeline — the thesis has to be *seen*.
- Feature list drawn from `SCOPE.md`, honest about what is v1 and what is deferred.
- Requirements: a Cloudflare account, a domain, the Workers/D1/R2/Queues services used, and
  any paid-tier implications stated up front.
- Quickstart pointing at the install path chosen in Decision 2.
- Architecture summary with a link to `ARCHITECTURE.md`.
- License and contribution pointers.

## Part D — Self-hosting documentation
- **Install guide** end to end: deploy → provision resources → set secrets → run genesis
  (email-free, deploy-access as the trust root) → onboard the first domain → create the
  first mailbox → send and receive a test message.
- **Configuration reference**: every environment variable and secret, what it does, whether
  it is required, and how to generate it. At minimum `CF_ACCOUNT_ID`, `CF_API_TOKEN`, the
  DEK, `SEARCH_KEY`, `MAIL_IN_WORKER_NAME` — enumerate from the code, do not guess.
- **Cloudflare token scopes**: the exact permission set, and the note that Zone:Create can be
  omitted entirely if the operator only ever onboards domains already on their account.
- **Operations**: backup and restore (D1 + R2 + secrets together — a D1 backup without the
  DEK is useless), upgrading and running migrations, and the recovery hatches
  (backup codes → admin-initiated reset → CLI `reset-admin`).
- **Troubleshooting**: mail not arriving (routing rule, MX, zone status), sending failing
  (domain not `active`, DKIM missing, rate limit, suppression), and where the onboarding
  health view lives.

## Part E — Contributor developer experience
This is what determines whether anyone but you ever contributes.
- **Local dev story**: how to run the app, the `mail-in` worker, and the queue consumer
  locally with `wrangler dev`, and how to exercise ingest **without sending real mail** by
  feeding `.eml` fixtures through the pipeline.
- **The `.eml` test corpus**: establish `fixtures/eml/` with real-world messages from Gmail,
  Outlook web, Outlook desktop, Apple Mail, and a few newsletters — nested quotes, forwards,
  inline replies, HTML soup. Document how to add one. `stripQuotes` and `deriveContentKind`
  are where the entire UX thesis lives; they must be tested against reality, not synthetic
  input. **Scrub personal data from every fixture** and say so in the contributing guide.
- Seed script for a usable local instance.
- Test commands, lint, typecheck, and how to run migrations.
- CI: build, typecheck, tests, plus `gitleaks` (an email app with secrets must never leak
  one) and dependency updates.
- Issue and PR templates, including a bug template that asks which mail client produced the
  message.

## Part F — Release hygiene
- Versioning and `CHANGELOG.md`.
- A migration policy: D1 has no transactions, so document how migrations are applied and
  what an operator does if one fails midway.
- Tag the first public release only once the install path in Decision 2 has been walked
  end to end on a clean Cloudflare account.

## Out of scope
No new product features. Do not modify auth, domain onboarding, or the mail pipelines except
where Decision 1 surfaces a security fix — and in that case, propose it and stop rather than
changing crypto behavior unreviewed.

## Deliverables
1. Conflict list + Decision 1 (what is encrypted at rest, with any security finding) +
   Decision 2 (install path recommendation) — **then STOP for review.**
2. `LICENSE` (Apache-2.0, copyright Ethercorps), `NOTICE`, `CONTRIBUTING.md` with the DCO
   requirement and DCO 1.1 text, `CODE_OF_CONDUCT.md`, and DCO sign-off enforcement in CI.
3. `SECURITY.md` with the honest threat model and key-management instructions.
4. `README.md` with screenshots/demo.
5. Self-hosting docs: install, configuration reference, token scopes, operations,
   troubleshooting.
6. Local dev story, `fixtures/eml/` corpus with scrubbing guidance, seed script, CI
   (build/typecheck/test/gitleaks/dependency updates), issue and PR templates.
7. `CHANGELOG.md` and migration policy.
8. A clean-account install walkthrough, performed and reported — every gap found becomes a
   docs fix before the first tag.
