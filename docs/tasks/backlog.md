# Backlog

Source intake: [17-07-2026.md](./17-07-2026.md). Status legend in [README.md](./README.md).

All items below are 🔍 **planned** — awaiting sign-off. No code until approved.

---

## T1 — Remove user completely ✔ done

**Intake:** removing a user should drop them from org members, from the DB, and
kill all their sessions.

**Finding:** `removeUser` relied on FK cascade — but D1 doesn't reliably enforce
`ON DELETE CASCADE` at runtime, so `deleteUser` alone risked orphan
`member`/`session` rows (the two the task names).

**Done**
- [x] Confirmed `session`/`account`/`member`/`twoFactor`/`passkey` all declare
      `onDelete: cascade` in schema — but stopped trusting D1 to run it.
- [x] `removeUser` now purges sessions then memberships explicitly, then
      `deleteUser` for the user + account/2fa/passkey. (`manage-users.remote.ts`)
- [x] Confirm `AlertDialog` on the destructive Remove action (members tab).

**Improvement shipped:** explicit session purge cuts live access immediately and
guarantees org removal regardless of D1 FK enforcement. Residual ≤5-min cookie
cache is inherent to Better Auth (same as `pauseUser`); user row is gone so
validation fails once the cache lapses.

---

## T2 — Org-specific sender address ✔ done

**Intake:** stop sending from a single default. Send from an onboarded org
domain. Later refinement: **remove `MAIL_DOMAIN` entirely** — no system fallback
domain; superadmin/system mail also sends from an active org domain.

**Done**
- [x] `sendMail`/`sendMailBackground` take optional `from`; **`MAIL_DOMAIN`
      removed** from env, mailer, `isServedDomain`, docs, login/forgot placeholders.
- [x] `senderAddress(db, orgDomain?, localPart='no-reply')` resolves:
      (1) the requested org's domain if `status==='active'`;
      (2) else **any active org domain** (system/superadmin, or invites for an
      org not yet active); (3) else `undefined`.
- [x] `sendMail` skips + warns when `from` is undefined (fresh deploy, no active
      domain) — genesis is email-free by design, so nothing to send yet.
- [x] Wired invite, reset link, reset code, recovery-verify. Superadmin follows
      the same org-domain behaviour (falls to any active org).

**Improvement shipped:** the `active`-status gate is the deliverability guard —
never send from a non-DKIM-wired domain. Local part is `no-reply@` (no real
inbox to provision until T3); switch via the `localPart` arg later.

---

## T3 — Subdomain mail provisioning ✔ done

**Intake:** let a user add a subdomain mail system.

**Scope (your call):** subdomain stays **part of the org** — it's just extra
Cloudflare Email Routing DNS config on the same zone, plus the **subaddressing**
(`+`) flag CF exposes. No new org row, no D1 schema change. Config is read live
from CF (source-of-truth invariant preserved), same as the existing DNS tab.

**Done**
- [x] `cloudflare.ts`: `getRoutingConfig` (Email Routing on/off + subaddressing +
      configured subdomains, live), `addRoutingSubdomain` (`emailRouting.dns.create`
      → subdomain MX, so `*@sub.domain` hits the zone catch-all Worker),
      `removeRoutingSubdomain` (delete the subdomain's DNS records — the SDK's
      per-subdomain delete is zone-wide, so target by name via the zone DNS API),
      `setSubaddressing` (raw `PATCH /zones/{id}/email/routing { support_subaddress }`
      — confirmed against the CF API reference; SDK v7 has no typed setter).
- [x] `domains.remote.ts` (superadmin-only): `mailRoutingConfig`, `addMailSubdomain`,
      `removeMailSubdomain`, `toggleSubaddressing`. `normalizeSubdomain` accepts a
      bare label or full host, rejects anything outside the apex.
- [x] UI: "Inbound routing" card on the org **DNS tab** (active zones only) —
      subaddressing switch + add/list/remove routing subdomains.

**Improvement shipped:** live-read, zero-persistence, zero-schema — reuses the CF
source-of-truth pattern instead of adding a subdomain table/JSON column. Subdomain
routing rides the existing zone catch-all → mail-in Worker for free (no per-address
rules needed).

**Deferred:** subdomain *sending* identity (`onboardSendingDomain` for outbound
DKIM per subdomain) — this task is inbound routing + subaddressing per your scope.
Add if a customer needs to send *as* `x@sub.domain`.

---

## T4 — Data tables + button-group actions ✔ done

**Done**
- [x] Scaffolded shadcn-svelte data-table core (`@tanstack/table-core`,
      `createSvelteTable`, `FlexRender`, render helpers).
- [x] Built reusable generic `DataTable` (`ui/data-table/data-table.svelte`):
      sortable headers, search box (per-column), pagination footer, empty state.
- [x] Members tab migrated to `DataTable` with snippet cells; row actions now a
      `ButtonGroup` (Pause/Resume + Remove) instead of the `⋯` dropdown.
- [x] Left the short read-only DNS table + org list as plain tables (improvement
      held: data-table only where it earns weight).

**Improvement held:** DNS records + org list stayed plain tables — data-table
only where it earns its weight (members grows, wants search/sort/pagination).

---

## T5 — Full-width, responsive layout ✔ done

**Intake:** use full width app-wide, stay responsive, use container widths where
it fits.

**Done**
- [x] Widened the data/dashboard pages to full width: org area, admin dashboard
      (+ stat grid now `xl:grid-cols-6`), oversight.
- [x] Kept reading-width containers for forms/prose: admin settings, account
      security, org settings (`max-w-2xl`) — full-width forms are worse UX.
- [x] Tables live in bordered cards that scroll on narrow screens.

**Improvement shipped:** applied the split rule (tables/dashboards full-width,
forms/prose keep a max container) rather than blanket-removing `max-w`.

---

## T6 — Email templates (un-jinja) ✔ done

**Intake:** basic email templates. No `better-svelte-email` (buggy). Prefer HTML
templates + `@ethercorps/un-jinja`.

**Done**
- [x] Added `@ethercorps/un-jinja`; **removed `@better-svelte-email/{components,server}`**
      + the `email:dev` script + `src/lib/client/email/`. (Side win: the auth
      server chunk dropped ~800 kB without the Svelte email SSR renderer.)
- [x] `src/lib/server/email/templates/*.html` — shared branded `_layout.html`
      (logo/name/from footer) + 5 bodies: verify-email, reset-link, reset-code,
      recovery-verify, invite. Imported as raw strings (`?raw`) so they bundle
      into the Worker — no fs at runtime.
- [x] `renderEmail(name, { from, ...vars })` → `{ subject, html, text }`. Body is
      rendered (auto-escaped) then composed into the layout via un-jinja's `safe`
      filter; `text` auto-derived by `htmlToText` (templates surface every link/
      code as visible text, so plaintext keeps them).
- [x] Swapped all 5 callers off inline strings: `auth.ts` (verify + reset link),
      `password-reset.ts` (reset code), `recovery-email.ts`, `provisioning.ts`
      (invite). Verify-email now also resolves a `from` (was skipping post-
      MAIL_DOMAIN-removal).
- [x] Branding context from `senderAddress` — extended `MailFrom`/`senderAddress`
      to carry the org **logo** so T2 sender + BIMI logo feed one layout.
- [x] Verified end-to-end (throwaway probe, since the repo has no test runner):
      code/links survive into text, body not double-escaped, logo + recovery
      blocks conditional, and **a `<script>` in the org name auto-escapes** —
      un-jinja escapes by default, so template vars are XSS-safe.

**Improvement shipped:** org-branding context (name/logo/from) into one shared
layout — every mail is org-branded automatically. **Provider:** kept the existing
Cloudflare `EMAIL_SENDER` binding — no Resend/etc. Add a provider only if inbound
webhooks/analytics are ever needed.

**Not committed:** a unit test — `htmlToText` is pure and testable, but the
templates use Vite `?raw` imports, so a committed test needs vitest+vite (a
framework this repo doesn't have). Verified via a run-once probe instead; add a
runner if the template layer grows.

---

## Cross-task overlaps

- **T2 ↔ T3 ↔ T6:** sender address, sending subdomain, and template from-identity
  are one deliverability story. Build T2's from-logic aware of T3's subdomain and
  T6's branded layout.
- **T4 ↔ T5:** tables + full-width are one UI pass over the admin screens.
- **T1** is standalone and nearly done — fastest win.

## Suggested order

1. **T1** (verify + session purge + confirm dialog) — small, closes a real gap.
2. **T4 + T5** together — one UI pass.
3. **T2 → T6 → T3** — the deliverability chain, in that dependency order.
