# Service Accounts — API sending, templates & send log

Status: **implemented (all 5 phases)**. Last updated: 2026-07-29.

## Implementation status

All phases landed. Tests: 22 new (send-log 4, templates 7, mjml/MRML 6, sdk 5),
full web suite green, mail-core + sdk `tsc` clean.

- **Phase 0** — no code change needed; `(app)/mailboxes/[mailboxId]` + the
  "Manage mailbox" link already give managers the keys UI.
- **Phase 1** — `submission.apiKeyId` + `send_event` table (migration `0032`);
  `@doota/mail-core/send-log` (log/list/read/purge, AES-GCM payload on a 30-day
  TTL, redaction); logged from `/api/send`; **Send log** tab; cron purge sweep.
- **Phase 2** — `template` + `template_version` (migration `0033`);
  `server/templates.ts` (CRUD + un-jinja render); `rpc/template.remote.ts`;
  templated `/api/send` path.
- **Phase 3** — `lib/mjml/blocks.ts` (pure, client-safe block schema → MJML
  serializer + variable extraction); the builder compiles **in the browser** via
  `mrml/web` (dynamic-imported + Vite `?url`, SSR-safe); the RPC just stores the
  client-supplied `compiledHtml` + `editorJson` + `variablesSchema`.
  `template-builder.svelte` (svelte-dnd-action) + `(app)/templates` routes +
  sidebar entry.
- **Phase 4** — `packages/sdk` (`@doota/sdk`, Resend-shaped; publishable —
  `publishConfig` ships built `dist`, `pnpm build` via `prepublishOnly`); docs
  guide + changelog; `admin/api-keys.mdx` refreshed.

### Notes & follow-ups

- **Compile is client-side** (browser WASM, `mrml/web`), per the plan — the
  builder route carries the WASM; the Worker and hot send path stay WASM-free
  (un-jinja renders the stored HTML at send). No MRML-on-Workers concern.
  ⚠ Verify in a browser that the `?url` wasm loads under Vite (the one bit that
  can't be headless-tested); MRML compile itself is proven in the mjml test via
  the node build.
- **Template access**: org admins **and** service-mailbox managers (a `canManage`
  grant on an `isService` box) — `serviceMailboxManagerOrgIds` + widened guard.
  Non-admin managers reach `/templates` via a link in the account's keys tab.
- **SDK name**: `@doota/sdk` (scoped — the bare `doota` is the app package).
- **Local D1**: apply migrations `0032` + `0033` with `pnpm db:migrate:local`
  (tests run them in-memory automatically).
- **Builder MVP**: 8 core blocks, no nested columns yet.



This is the technical design for turning today's bare "service mailbox + API key"
into a full **service account**: an API-based sending identity that owns
**keys**, **hosted templates** (with a visual builder), and a **send log**
recording every message it sent. It also covers a Resend-style **client SDK**.

Audience: developers/operators. The user-facing guide lives in `apps/docs`.

---

## 1. What a service account is

A **service account** is not a new entity — it is the existing **service
mailbox** (`mailbox.isService = true`, `packages/db/src/mail.schema.ts`) plus a
Developer surface. It is a non-human sending identity owned by an org
(`notifications@`, `billing@`) that external systems send *as*, over
`POST /api/send` with a bearer key (`dk_…`).

It owns four things:

1. **Identity + access** — address, display name, and the existing
   `mailbox_access` grants (`canManage` / `canSend`). Reused as-is.
2. **Keys** — `dk_…` bearer keys. Already built (mint/hash/verify/revoke).
3. **Templates** — hosted, versioned mail templates with variables. **New.**
4. **Send log** — per-send audit: when · to whom · which key · which template ·
   what data · status. **New.**

Framing: **a service account = a shared mailbox + a Developer tab (Keys ·
Templates · Logs).** No new permission system, no new owner model — grants and
the send pipeline already exist.

---

## 2. Access model — who sees and manages

Reuse the existing grant model. No new permission tier (unless we later want
`canSend`-read; see Open questions).

| Operation                     | Who                                                |
| ----------------------------- | -------------------------------------------------- |
| Create a service account      | Org admin / superadmin (`assertManageOrg`)         |
| Mint / list / revoke keys     | `canManage` grant on the mailbox, or org admin     |
| Create / edit templates       | `canManage`                                        |
| View send log                 | `canManage` (see Open questions re `canSend`-read) |
| Send via API                  | Any holder of a valid key (the key *is* the authz) |
| "Share" a service account     | Grant a teammate `canManage` / `canSend` (Access tab) |

**Sharing = granting access, never re-showing a secret.** Keys are shown once at
mint (SHA-256 hashed, `api-key.ts`). A teammate who needs API access is added as
a manager and mints *their own* key. We never store or re-display a secret.

### Access already works (Phase 0 mostly a no-op)

Earlier this design assumed keys were org-admin-only. **That was wrong.** An
in-app manager route already exists: `(app)/mailboxes/[mailboxId]`
(`+page.server.ts`) allows superadmin OR org-admin OR `isMailboxManager`
(a `canManage` grant) and renders `mailbox-manager.svelte` with the API-keys tab
for service mailboxes. The mail app already links to it — a **"Manage mailbox"**
affordance shows for the active mailbox when `canManageActive`
(`(app)/app/+page.svelte`). So a delegated manager can already mint/list/revoke
keys without `/admin`. Phase 0 is therefore just: confirm this path, and (later,
optional) a central "service accounts" list for users who manage several. No
route/guard change needed.

---

## 3. Architecture

### 3.1 Templating engine — `@ethercorps/un-jinja` (reuse)

Already a dependency and already the renderer for system email
(`apps/web/src/lib/server/email/index.ts`): `render(templateString, ctx)`,
Jinja2-like, **auto-escaping on**. This is the send-time merge engine for
service-account templates too. No new engine.

```ts
import { render } from "@ethercorps/un-jinja";
const html    = render(version.compiledHtml, data);   // {{ user.name }} → value
const subject = render(template.subjectTemplate, data);
```

### 3.2 Builder — Svelte-native, own the editor, borrow only rendering

We build the drag-and-drop builder **in Svelte** rather than embed a
ready-made editor. Every off-the-shelf option brings its own runtime or a
license string: GrapesJS ships its own view stack, `@templatical/editor` is
Vue + **FSL-1.1** (non-compete), Easy Email / EmailBuilder.js are React,
Unlayer is proprietary + phones home. Doota is Svelte + Cloudflare Workers +
Apache-2.0 — so we keep the app light and fully open by owning the editor and
borrowing only the two genuinely-hard, commodity pieces (cross-client HTML
compilation and drag physics).

Own vs borrow:

| Layer                                   | Own / borrow                        |
| --------------------------------------- | ----------------------------------- |
| Editor UI — canvas, block palette, per-block settings, responsive preview | **Own (Svelte)** |
| Block schema (JSON) — source of truth   | **Own**                             |
| Block JSON → MJML serializer            | **Own** (this is the GrapesJS lesson: `grapesjs-mjml` is just a JSON↔MJML mapping) |
| MJML → HTML compile                     | **Borrow: MRML (Rust→WASM, MIT)**   |
| Drag mechanics                          | **Borrow: `svelte-dnd-action` (MIT)** |
| Merge tags → render                     | **Own seam + un-jinja**             |

**Compile engine = MRML, not `mjml`.** The standard `mjml` npm compiler is a
heavy Node lib (Node built-ins, juice/html-minifier) and does not run on
Cloudflare Workers. **MRML** (`mrml` npm, Rust→WASM, MIT — the engine behind
Jolimail) is Workers-compatible and fast. It handles the expensive part:
Outlook `<table>` compat, CSS inlining, responsive breakpoints.

**Where the weight lands (stays light):** MJML→HTML compile runs **once at
template save, client-side in the builder** (MRML-WASM loads only on that
route). The hot **send** path runs only the tiny un-jinja `render(html, data)` —
no MJML, no WASM. The mail-reading app and `/api/send` never load the editor or
MRML.

Flow:

```
Svelte editor (block JSON, source of truth)
   │  serialize (own)
   ▼
MJML string  ── {{ jinja }} merge tags baked into text/attrs
   │  compile once at save: MRML (WASM)
   ▼
compiledHtml (responsive, cross-client, {{ }} preserved)
   │  at send: render(compiledHtml, data)  (un-jinja)
   ▼
final HTML → sanitize → enqueue → mail-out
```

We store **both** the block JSON (to re-open/edit) and the compiled Jinja-HTML
(to render at send) per template *version*.

**MVP block set** — MJML core only, ~8 blocks: text, heading, image, button,
divider, spacer, section/columns, raw-HTML. Not all 19 MJML components. Borrow
DnD + compile so we build *only* the block UI + serializer, not email-client
compat or drag physics.

Rejected: `@templatical/editor` (FSL-1.1 non-compete + Vue), GrapesJS (ships its
own stack, MJML preset but heavy for a Svelte app), Unlayer (proprietary, phones
home), Swapy (GPL-v3 copyleft + swap-only model, wrong for palette-driven
building).

### 3.3 Send path

`POST /api/send` (`apps/web/src/routes/api/send/+server.ts`) gains a templated
mode alongside the existing raw mode:

```jsonc
// raw (today)
{ "mailboxId": "...", "to": "...", "subject": "...", "html": "..." }

// templated (new)
{ "mailboxId": "...", "to": "...", "templateId": "...", "data": { "name": "Ana", "order_id": 42 } }
```

Templated path: load current template version → `render(subjectTemplate, data)`
+ `render(compiledHtml, data)` → sanitize (`@doota/mail-core`) → enqueue. Then
write a **send_event** (§4.3). Raw sends are logged too, with `templateId = null`.

### 3.4 Client SDK — Resend-shaped

A public client package (`packages/sdk`, publish name TBD) mirroring Resend's
ergonomics:

```ts
import { Doota } from "@doota/sdk";        // public name TBD
const doota = new Doota("dk_live_…");

await doota.emails.send({
  from: "billing@mail.acme.com",
  to: "ana@example.com",
  templateId: "tmpl_invoice_paid",
  data: { name: "Ana", amount: "$40.00" },
});
```

Thin typed wrapper over `POST /api/send` (bearer auth, idempotency key, typed
errors). No secrets stored client-side beyond the key the caller supplies.

---

## 4. Data model (new)

All Drizzle, `packages/db/src/mail.schema.ts`. No raw SQL.

### 4.1 `template`

| col               | type      | notes                                            |
| ----------------- | --------- | ------------------------------------------------ |
| id                | text pk   | `tmpl_…`                                          |
| orgId             | text fk   | org-scoped **library**, reusable by any service box |
| name              | text      | human label                                      |
| slug              | text      | stable id used by the API (`tmpl_invoice_paid`)  |
| subjectTemplate   | text      | Jinja subject line                               |
| variablesSchema   | json      | derived from merge tags: `{ name: {required, sensitive} }` |
| currentVersionId  | text fk   | points at the live version                       |
| createdByUserId   | text fk   |                                                  |
| createdAt / updatedAt / archivedAt | ts |                                     |

Unique `(orgId, slug)`.

### 4.2 `template_version` (immutable snapshots)

| col          | type    | notes                                       |
| ------------ | ------- | ------------------------------------------- |
| id           | text pk |                                             |
| templateId   | text fk |                                             |
| version      | int     | monotonically increasing per template       |
| editorJson   | json    | the `@templatical/editor` document (edit)   |
| compiledHtml | text    | MJML→HTML with `{{ jinja }}` (render)       |
| createdByUserId | text fk |                                          |
| createdAt    | ts      |                                             |

Sends pin `templateVersion` so the log reproduces exactly what went out even
after the template is edited.

### 4.3 `send_event` — the log (two-tier)

**Durable metadata tier** (retain long — 90d default or until purge):

| col            | type    | notes                                    |
| -------------- | ------- | ---------------------------------------- |
| id             | text pk |                                          |
| orgId          | text fk |                                          |
| mailboxId      | text fk | the service account                      |
| apiKeyId       | text fk | **which key** sent it                    |
| templateId     | text fk nullable | null for raw sends              |
| templateVersion| int nullable |                                     |
| toAddresses    | json    | recipients                               |
| subject        | text    | rendered subject                         |
| status         | text    | queued / sent / bounced / failed         |
| submissionId   | text fk | link into the outbound pipeline          |
| createdAt      | ts      |                                          |

**Sensitive data tier** (short TTL, encrypted):

| col           | type    | notes                                             |
| ------------- | ------- | ------------------------------------------------- |
| dataCipher    | blob    | the `data` merge payload, **encrypted at rest** (mail-core `crypto`) |
| dataExpiresAt | ts      | TTL, default now + 30d (org-configurable)         |
| redactedKeys  | json    | variable names dropped before storage (sensitive) |

Reconstruct the rendered body **on demand** from `compiledHtml + data` while
data is in TTL — we do **not** store rendered HTML (avoids doubling PII). After
`dataExpiresAt`, a cron sweep nulls `dataCipher`; the log row shows
"data expired," metadata stays.

### 4.4 `submission` — add `apiKeyId`

Add a nullable `apiKeyId` column so every outbound submission carries which key
(if any) originated it — the join between the send log and the mail pipeline.

---

## 5. Privacy & retention

Doota is privacy-first (encrypted R2 blobs). A permanent plaintext archive of
"everything you've ever emailed and the data used" contradicts that. Rules:

- **Metadata durable, payload ephemeral.** Keep who/what/when/which-template/
  status long; keep the raw `data` blob only ~30 days (org-configurable).
- **Encrypt the payload at rest** with the existing `@doota/mail-core/crypto`
  envelope.
- **Redaction.** A template variable can be flagged `sensitive`
  (`password`, `token`, OTP) → never written to the log, even in TTL window.
- **Never store rendered HTML** — reconstruct from `version + data` on demand.
- **Purge sweep** rides the existing cron (`@doota/mail-core/cron`).

---

## 6. Phases

Each phase ships independently.

**Phase 0 — Access.** In-app Developer surface for service accounts, reachable
by `canManage` grantees (not just org admins). Reuse existing key
mint/list/revoke RPCs. Fixes the reachability bug. *Smallest, highest-leverage.*

**Phase 1 — Send log.** `apiKeyId` on `submission`; `send_event` two-tier table;
capture on the existing raw `/api/send`; **Logs** tab UI. Delivers the audit log
before templates exist.

**Phase 2 — Hosted templates (data + render).** `template` + `template_version`
tables; un-jinja render at send; `/api/send { templateId, data }`; template CRUD
RPCs; template list UI. Log's template field becomes real.

**Phase 3 — Builder.** Svelte-native drag-and-drop editor (`svelte-dnd-action`),
block JSON as source of truth, JSON→MJML serializer, MRML-WASM compile at save,
live preview, merge-tag insertion, test-send, versioning. MVP = ~8 core MJML
blocks.

**Phase 4 — SDK + docs.** `packages/sdk` Resend-shaped client; publish; user
guide in `apps/docs` + changelog; update `apps/docs/.../admin/api-keys.mdx`
(currently says users create keys at `/account/developer`, which is stale).

---

## 7. Decisions locked

- Service account **= service mailbox + Developer tab** (not a separate entity).
- Sharing **= grant access**, never re-show a secret.
- Render engine **= `@ethercorps/un-jinja`** (reuse), auto-escape on.
- Builder **= Svelte-native, ours.** Own the editor UI + block JSON schema +
  JSON→MJML serializer + merge-tag UX. Borrow only **MRML** (`mrml`, Rust→WASM,
  MIT) for MJML→HTML compile and **`svelte-dnd-action`** (MIT) for drag. No
  embedded editor, no second framework, no FSL/GPL.
- Compile **client-side at save** (MRML-WASM on the builder route only); send
  path runs only the light un-jinja render.
- Templates **= org-scoped library**, reusable across the org's service boxes.
- Log **= two-tier**: durable metadata + encrypted payload on a 30-day TTL.
- SDK **= Resend-shaped** thin client over `/api/send`.

## 8. Open questions

- **Provisioning:** self-serve service-account creation, or stays
  admin-provisioned? (Leaning admin-provisioned initially.)
- **Log visibility:** `canManage`-only, or `canSend` members get read-only?
- **Naming in UI:** "Service account" (dev-friendly) vs "Service mailbox"
  (model-consistent). Affects copy everywhere.
