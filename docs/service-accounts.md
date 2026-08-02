<!-- SPDX-License-Identifier: Apache-2.0 -->
# Service accounts — API sending, templates, send log & SDK

Status: **shipped.** Written from a code walkthrough 2026-08-02; file:line
references point at `apps/web/src/` and `packages/` unless noted.

A **service account** is not a new entity — it is the existing **service mailbox**
(`mailbox.isService = true`, `packages/db/src/mail.schema.ts`) plus a Developer
surface. A non-human sending identity owned by an org (`notifications@`,
`billing@`) that external systems send *as*, over `POST /api/send` with a bearer
key (`dk_…`), through the **same** `can(send)` authorization and the **same**
outbound pipeline as an interactive session. It owns four things:

1. **Identity + access** — address, display name, existing `mailbox_access` grants
   (`canManage` / `canSend`). Reused as-is.
2. **Keys** — `dk_…` bearer keys (mint / hash / verify / revoke).
3. **Templates** — hosted, versioned mail templates with merge variables + a
   WYSIWYG builder.
4. **Send log** — per-send audit (who · when · which key · which template · what
   data · status), two-tier with an encrypted short-TTL payload.

Plus a Resend-shaped client **SDK** (`@doota/sdk`).

Audience: developers/operators. The user-facing guide lives in
`apps/docs/.../admin/api-keys.mdx`.

---

## 1. Access model

Reuse the grant model — no new permission tier.

| Operation | Who | Guard (`apps/web/src/lib/rpc/mailbox.remote.ts`) |
| --- | --- | --- |
| Mint / list / revoke keys | `canManage` on the mailbox, or org admin | `assertManageMailbox` |
| View send log | `canManage` **or** `canSend` | `assertManageOrSendMailbox` |
| Create / edit templates | org admin, or `canManage` on a service box | `assertCanManageTemplates` (`template.remote.ts`) |
| Send via API | any holder of a valid key | the key *is* the authz |
| "Share" the account | grant a teammate `canManage` / `canSend` | Access tab |

**Sharing = granting access, never re-showing a secret.** Keys are shown once at
mint (SHA-256 hashed, `apps/web/src/lib/server/auth/api-key.ts`). A teammate who
needs API access is added as a manager and mints *their own* key.

**Key minting is a management act** — `canManage` only. A `canSend` grantee gets
read access to the send log but can't mint keys. Whoever provisions a key **must
name it** (`createServiceKey` requires `z.string().trim().min(1).max(80)`); the
name is what identifies it in the list later (`CI deploy`, `billing worker`).

Reachability was the original bug this fixed: the keys UI lives under the in-app
mailbox-manager route (`(app)/mailboxes/[mailboxId]`), reachable by any
`canManage` grantee via the "Manage mailbox" link — **not** gated behind
`/admin`. A delegated manager can mint/list/revoke without an admin role.

### Key storage — `api-key.ts`

- `createServiceApiKey(db, { orgId, mailboxId, createdByUserId, name })` — mints a
  32-byte random secret prefixed `dk_`, stores **only** its SHA-256 hash, returns
  the plaintext once + a 12-char display prefix.
- `verifyApiKey(db, presented)` — hash lookup, must be non-revoked; returns an
  `ApiKeyActor { keyId, userId, orgId, mailboxId, isService }`, bumps
  `lastUsedAt`. Service keys have `userId = null`, `isService = true`,
  `mailboxId` set → send as the mailbox directly.
- `revokeApiKey(db, keyId)` — soft revoke (`revokedAt`), keeps the audit row.
- `bearerFromHeaders(headers)` — parses `Authorization: Bearer dk_…`.

The `apiKey` table carries `name`, `mailboxId` (send scope), `createdByUserId`
(audit), `isService`, `keyHash` (unique), `prefix`, `lastUsedAt`, `revokedAt`.

---

## 2. Send path — `POST /api/send` (`apps/web/src/routes/api/send/+server.ts`)

Bearer `dk_…` → `verifyApiKey` → `can(actor, "send")` (no parallel auth path). If
the key is mailbox-bound, `body.mailboxId` must match it (else 403); an unbound
key requires `body.mailboxId`.

**Request body:** `to` / `cc` / `bcc` (≥1 recipient), and either raw
(`subject`, `text`, `html`) **or** templated (`templateId` + `data`), plus
`fromAliasId`, `parentMessageId` (reply threading), `sendAt` (epoch-ms scheduled
send), `idempotencyKey`, `attachments`.

- **Raw path** — subject/text/html sent as written.
- **Templated path** — load the current `template_version`, render
  `subjectTemplate` + `compiledHtml` with `data` via **un-jinja**
  (`@ethercorps/un-jinja`, auto-escape on). **Built-in variables win over
  caller `data`**: `recipient`, `sender_name`, `sender_email`, `year`, `date`,
  `unsubscribe_url`. Text part is null (provider derives it from HTML).
- **Unsubscribe** — `unsubscribeUrlFor(url.origin, primary, env.UNSUBSCRIBE_URL)`.
  Host comes from the **request origin** (one Worker can serve many domains — never
  bake the host into env); `UNSUBSCRIBE_URL` overrides the path only (default
  `/unsubscribe`), `{email}` token substituted, absolute URLs pass through
  (`packages/mail-core/src/unsubscribe.ts`).
- **Then enqueue** through `enqueueSend` — the exact same materialize + queue seam
  as interactive send. For a **service** key the call is logged best-effort
  (never fails the send) via `logSendEvent`.

**Responses:** `202 { submissionId, deduped }` on success.
Errors: `400` (bad JSON / missing mailboxId / no recipients / bad attachment) ·
`401` (missing/invalid key) · `403` (mailbox-scope mismatch) · `404` (unknown
`templateId`) · `413` (attachment too big) · `500` (outbound not configured) ·
`502` (attachment URL fetch failed) · `504` (attachment fetch timeout).

Reusing an `idempotencyKey` returns the original submission with `deduped: true`.

---

## 3. Attachments — `apps/web/src/lib/server/api-attachments.ts`

`resolveApiAttachments(env, orgId, inputs)` → `{ r2Key, filename, contentType,
size }[]`, passed straight into `enqueueSend` (which creates attachment rows;
the provider decrypts + MIMEs at send). Each input has a `filename` and **exactly
one** of:

- **`content`** — base64 bytes (tolerates a `data:…,` prefix + whitespace);
  invalid base64 → 400.
- **`url`** — fetched server-side, **SSRF-guarded** (reuses
  `lib/server/ssrf.ts isBlockedHost`, mirrors img-proxy): http/https only,
  `redirect: 'manual'` re-validated per hop (≤3), 10 s timeout. Blocked host →
  400, bad redirect / fetch fail → 502, timeout → 504. Content-type inferred from
  the response.

Every blob is **encrypted at rest** (`putEncryptedBlob`, shared DEK) before it
touches R2 — same envelope as the message body. Limits reused from
`@doota/mail-core/drafts`: **20 files**, **25 MB each**, **40 MB total**
(413 on breach). Attachment bytes are **never** written to the send log.

Both Resend tiers (inline content + remote url) ship together on the shared store
path. Tier 3 (a pre-upload endpoint for files above the cap) is deferred.

---

## 4. Templates + builder

### Data model (`mail.schema.ts`)

- `template` — `id, orgId, name, slug, currentVersionId, createdByUserId,
  archivedAt, …`. Org-scoped **library**, unique `(orgId, slug)`, reusable by any
  service box.
- `template_version` — immutable snapshot: `templateId, version,
  subjectTemplate, compiledHtml, editorJson, variablesSchema`. A send **pins the
  version** it used, so the log reproduces exactly what went out even after edits.

### CRUD — `apps/web/src/lib/rpc/template.remote.ts`

`listOrgTemplates` / `getOrgTemplate` / `createOrgTemplate` / `updateOrgTemplate`
/ `archiveOrgTemplate`, all gated by `assertCanManageTemplates` (org admin **or**
`serviceMailboxManagerOrgIds` — a `canManage` grant on any `isService` box).
Content limits: `subjectTemplate` ≤500, `compiledHtml` ≤500k, `editorJson` ≤2M
(Tiptap doc), `variablesSchema` ≤50k (custom-var names + `sensitive` flags).

### The builder (Resend-style Tiptap WYSIWYG)

Type directly on the email canvas; `/` command menu; a grouped insert rail
(**Text · Media · Layout · Variables**); a right-hand config panel; a **Theme**
panel (per-type typography defaults); **Preview** (desktop/mobile) with **test
send**. Files:

| file (`apps/web/src/lib/`) | role |
| --- | --- |
| `components/templates/email-editor.svelte` | vanilla `@tiptap/core` mounted in Svelte; serializes to MJML on save; **mobile-gated** (`IsMobile` 768 — shows a "bigger screen" notice, skips editor init). |
| `mjml/tiptap-nodes.ts` | custom email nodes — button, image, columns (2–4), hero, social, footer, html — with shared container-style attrs. |
| `mjml/tiptap-mjml.ts` | pure serializer: Tiptap/ProseMirror doc → MJML, preserving `{{ }}` merge tags. **Groups** consecutive flow blocks into one `mj-section > mj-column` (idiomatic MJML rhythm); structural (columns/hero/social) or self-styled blocks break out. |
| `mjml/variables.ts` | the 6 built-in vars + `sensitive` schema, shared by builder + send path. |
| `mjml/compile.client.ts` | MJML→HTML via **MRML** (Rust→WASM), **client-side only** (dynamic import; `mrml` excluded from Vite `optimizeDeps` so wasm resolves in dev). SSR + the hot send path stay WASM-free. |

**Where the weight lands:** MJML→HTML compile runs **once at save, in the
browser**. The RPC stores the client-supplied `compiledHtml` + `editorJson` +
`variablesSchema`. The send path runs only the tiny un-jinja `render(html, data)`
— no MJML, no WASM. Preview compiles MJML then merges via un-jinja **client-side**
(browser-safe, 0 deps) in a sandboxed `srcdoc` iframe; test-send **reuses the
`sendMessage` remote** (no new endpoint).

### Merge variables

Two kinds, both `{{ name }}`: **provided** (the 6 built-ins Doota fills; they
override same-named `data`) and **yours** (any other tag; supply via API `data`,
missing renders empty). A var flagged `sensitive` in `variablesSchema` is dropped
before the send log stores `data`.

---

## 5. Send log — `packages/mail-core/src/send-log.ts` (two-tier)

Privacy-first: a permanent plaintext archive of "everything you've emailed + the
data" contradicts the encrypted-at-rest posture. So:

**Durable metadata tier** (kept) — `send_event` row: `orgId, mailboxId, apiKeyId,
submissionId, templateId, templateVersion, toAddresses, subject, status,
redactedKeys, createdAt`.

**Encrypted payload tier** (short TTL) — `dataCipher` (the `data` merge payload,
AES-GCM via the shared DEK) + `dataExpiresAt` (default **30 days**). Variables
flagged `sensitive` are stripped *before* encryption (`redactedKeys` records what
was dropped). Rendered HTML is **never** stored — reconstruct from
`version + data` while data is in TTL.

- `logSendEvent(db, input)` — redact → encrypt → insert.
- `listSendEvents(mailboxId, limit=100)` — metadata only, no decryption; each
  summary carries `dataAvailable` (has the payload expired?) + `redactedKeys`.
  Exposed as `listSendLog` (`mailbox.remote.ts`), readable by manage **or** send.
- `readSendEventData(id, dek)` — decrypt for a detail view; `null` past TTL.
- `purgeExpiredSendData()` — the daily cron nulls `dataCipher` where
  `dataExpiresAt <= now`; the metadata row stays.

`submission.apiKeyId` (nullable, migration `0032`) is the join between the log and
the outbound pipeline — every submission records which key (if any) originated it.

---

## 6. Client SDK — `packages/sdk` (`@doota/sdk`, published public)

Resend-shaped thin wrapper over `POST /api/send`:

```ts
import { Doota } from "@doota/sdk";
const doota = new Doota("dk_…", { baseUrl: "https://mail.acme.com" });

await doota.emails.send({
  to: "ana@example.com",
  templateId: "tmpl_welcome",
  data: { name: "Ana", code: "1234" },
  idempotencyKey: "welcome-user-9012",
});
```

- `new Doota(apiKey, { baseUrl, fetch? })`; `doota.emails.send(params)` →
  `{ submissionId, deduped }`; throws `DootaError` (carries HTTP `status` +
  server message) on non-2xx.
- `SendParams`: `to`/`cc`/`bcc`, `subject`, `text`, `html`, `templateId`, `data`,
  `mailboxId`, `fromAliasId`, `parentMessageId`, `sendAt`, `idempotencyKey`,
  `attachments`.
- `attachments`: `{ filename, content }` (a `Buffer`/`Uint8Array` — base64-encoded
  for you — or a base64 string) **or** `{ filename, url }`. Undefined fields are
  stripped before the wire call.
- Publishable: `publishConfig.access = "public"`, ships built `dist`, bare `doota`
  is the app package (scoped `@doota/sdk` is the SDK).

An **OpenAPI 3.0.3** spec for the endpoint lives at
`apps/web/static/openapi.yml` (servable at `/openapi.yml`).

---

## 7. Decisions locked

- Service account **= service mailbox + Developer surface**, not a new entity.
- Sharing **= grant access**, never re-show a secret; key mint is `canManage`.
- Render engine **= un-jinja** (auto-escape on), reused from system email.
- Builder **= ours** (Tiptap WYSIWYG), borrow only **MRML** for MJML→HTML compile,
  client-side at save; send path stays un-jinja-only.
- Templates **= org-scoped, versioned**; sends pin the version.
- Send log **= two-tier**: durable metadata + encrypted 30-day-TTL payload;
  `sensitive` vars redacted; rendered HTML never stored.
- Attachments **= both tiers** (inline + SSRF-guarded url), encrypted at rest,
  reuse the outbound pipeline.

## 8. Deferred

- Tier-3 pre-upload endpoint for attachments above the 25 MB cap.
- Send-only grantees minting their own keys (a separate self-serve surface).
- Real Doota-hosted one-click `List-Unsubscribe` (today `unsubscribe_url` is a
  template variable; the operator hosts the actual unsub + suppression).
