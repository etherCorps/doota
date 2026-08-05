<!-- SPDX-License-Identifier: Apache-2.0 -->
# Webhooks — outbound delivery events (Phase A)

Status: **shipped.** Written from a code walkthrough 2026-08-05; file:line
references point at `apps/web/src/` and `packages/` unless noted.

A **webhook endpoint** is a registered https URL that Doota POSTs signed event
payloads to when mail for a mailbox changes state (sent, delivered, bounced,
complained, failed) or when mail arrives. It is **mailbox-scoped**: configured
**per mailbox** in **Account → Mail** (the Webhooks card, scoped by the page's
mailbox picker), by a user who **has access to that mailbox** — not an org admin.
Authorization is the **same** `getAuthz().mailboxIds` access check as folders and
sender lists (`grantOn(mailboxId)` in `webhooks.remote.ts`) — no parallel
permission path. Events are scoped to that mailbox: an endpoint only receives
events for the mailbox it was created on.

Payloads carry **structural references only** — ids, statuses, addresses,
timestamps. Never a subject or a body. A misconfigured URL leaks routing
metadata, not mail content.

Audience: developers consuming the events, and mailbox owners registering them.

---

## 1. Events

Six event types (`packages/mail-core/src/webhooks.ts`, `WEBHOOK_EVENTS`):

| Event | Fires when |
| --- | --- |
| `submission.sent` | An outbound submission was handed to the provider. |
| `submission.delivered` | The provider confirmed delivery. |
| `submission.bounced` | A hard or soft bounce DSN was classified. |
| `submission.complained` | A spam complaint (feedback loop) landed. |
| `submission.failed` | The submission failed terminally before/at send. |
| `mail.received` | A new inbound thread was delivered to a mailbox. |

An endpoint subscribes to a subset (stored as a JSON array; an empty array means
**all** events). Producers live in `webhooks.ts`
(`emitSubmissionWebhook`, `emitInboundWebhook`) and fan out only to the
mailbox's enabled, subscribed endpoints (`enqueueWebhookDeliveries` filters by
`mailboxId`).

---

## 2. Payload shape

The POST body is JSON. Envelope:

```jsonc
{
  "id": "sub_abc:bounced",        // stable event id — DEDUPE on this across retries
  "type": "submission.bounced",   // one of the six event types
  "createdAt": 1785951916000,     // ms epoch, when the delivery was built
  "data": { /* structural refs — see below */ }
}
```

`data` for submission events:

```jsonc
{
  "submissionId": "sub_abc",
  "mailboxId": "mbx_123",
  "status": "bounced",
  "occurredAt": 1785951916000
}
```

`data` for `mail.received`:

```jsonc
{ "mailboxId": "mbx_123", "threadId": "thr_456", "occurredAt": 1785951916000 }
```

The test event fired on endpoint creation carries `"data": { "test": true }`
with `type: "submission.sent"` — so you can confirm the endpoint receives before
any real mail flows.

**`id` is stable across retries and redeliveries.** Treat it as an idempotency
key: store processed ids and no-op on a repeat.

---

## 3. Signature verification

Every request carries these headers:

| Header | Value |
| --- | --- |
| `Doota-Signature` | HMAC-SHA256 over `` `${timestamp}.${body}` ``, hex-encoded. |
| `Doota-Timestamp` | ms epoch used in the signed material (defeats replay). |
| `Doota-Event` | The event type (also in the body `type`). |
| `Doota-Delivery` | The stable event id (also in the body `id`). |
| `User-Agent` | `Doota-Webhooks/1`. |

The signing secret (`wh_…`) is shown **once** when the endpoint is created and
never again. It is stored **encrypted** with the instance DEK (not hashed) —
`webhook_endpoint.secret_enc`, an AES-GCM envelope
(`packages/mail-core/src/crypto.ts`) — because the delivery worker must recover
the plaintext to compute the HMAC. Only a 12-char prefix (`wh_1a2b3c…`) is kept
in cleartext, for display.

Verify by recomputing the HMAC over `` `${timestamp}.${rawBody}` `` and comparing
in constant time. Reject stale timestamps (e.g. older than 5 minutes) to bound
replay.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody is the exact bytes received — verify BEFORE JSON.parse.
function verifyDootaWebhook(rawBody, headers, secret) {
  const timestamp = headers["doota-timestamp"];
  const signature = headers["doota-signature"];
  if (!timestamp || !signature) return false;

  // Bound replay: reject anything older than 5 minutes.
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Respond `2xx` to acknowledge. Any other status (or a timeout) is a failed
attempt — see retries.

---

## 4. Retries & backoff

Delivery tuning lives in `webhooks.ts`:

- **Timeout:** 5s per attempt (`AbortController`).
- **Success:** any `2xx`. Resets the endpoint's failure counter to 0.
- **Permanent failure (no retry):** `4xx` **except** `408` and `429` — the
  endpoint will never accept it, so retrying only burns quota.
- **Retryable:** everything else (`5xx`, `408`, `429`, network errors,
  timeouts). Retried with **exponential backoff + full jitter**: base 30s,
  doubling, capped at 6h, up to **6 attempts**. `next_attempt_at` drives both the
  delay and the retry sweep.
- **Per-endpoint rate limit:** 120 deliveries/minute/endpoint. Over the cap, the
  delivery is deferred **without** counting as a failure (we're pacing
  ourselves, the endpoint is fine).

The write-row-then-enqueue ordering (a `webhook_delivery` row is inserted
`queued`, then a queue job is enqueued) makes redelivery idempotent: a lost
queue message is recovered by the due-sweep cron (`sweepDueWebhooks`). Terminal
rows are pruned after 30 days (`pruneWebhookDeliveries`).

## 5. Auto-disable

After **15 consecutive failures**, the endpoint is auto-disabled
(`FAILURE_DISABLE_THRESHOLD`): `is_enabled = false`, `disabled_at` set. A dead
endpoint retried forever is a self-inflicted outbound DoS. Re-enabling from the
mailbox's Webhooks card (Account → Mail) resets the failure counter and clears
`disabled_at` — a re-enabled endpoint starts a fresh strike count.

---

## 6. SSRF constraints

Webhook delivery is a Worker fetching an operator-supplied URL — the SSRF
chokepoint. Validation is **one shared implementation**
(`packages/mail-core/src/ssrf.ts`, `validateWebhookUrl`), enforced at three
points:

1. **On save** — the create RPC rejects a bad URL before it's stored
   (`createWebhook`, `apps/web/src/lib/rpc/webhooks.remote.ts`). Surfaces the
   validator's error as a `400`.
2. **At delivery** — re-validated per attempt, because DNS answers change
   between save and send (`handleWebhookDelivery`).
3. **On every redirect hop** — the delivery fetch uses `redirect: "manual"`, so
   a public URL that `302`s to a private address (e.g. `169.254.169.254`) fails
   rather than being followed.

Rules enforced:

- **https only** — no `http`.
- **Standard port** — `443` or none.
- **Hostname, not a literal IP** — a numeric host is never a legitimate webhook
  target and sidesteps DNS-based checks. Both IPv4 and IPv6 literals rejected.
- **No internal TLDs** — `.internal`, `.local`, `.localhost`.
- **Private ranges blocked** — loopback, RFC1918, link-local (incl. the cloud
  metadata `169.254.169.254`), ULA, CGNAT (`isBlockedHost`).

So `http://169.254.169.254/` and `https://192.168.0.1/hook` are rejected on
save; `https://hooks.acme.dev/doota` is accepted.

---

## 7. Management surface

`apps/web/src/lib/rpc/webhooks.remote.ts` — mailbox-scoped CRUD, every function
gated through `grantOn(mailboxId)` (resolves the mailbox, asserts
`getAuthz().mailboxIds.includes(mailboxId)` → `403` otherwise), the same access
check as folders and sender lists. The UI is the per-mailbox **Webhooks** card in
Account → Mail (`apps/web/src/lib/components/account/webhooks-card.svelte`).

- `mailboxWebhooks({ mailboxId })` — list that mailbox's endpoints + a
  delivered/failed tally. **Never** returns `secret_enc`.
- `createWebhook({ mailboxId, url, events })` — SSRF gate, mint + encrypt the
  secret, resolve the mailbox's `orgId` to store (denormalized), insert, fire one
  test delivery. Returns `{ id, secret, secretPrefix }` — `secret` shown once.
- `updateWebhook({ id, events?, isEnabled? })` — authorized via the endpoint's
  mailbox; edit events / toggle enabled (re-enabling clears the failure state).
- `deleteWebhook(id)` — authorized via the endpoint's mailbox; delete
  (deliveries cascade).
- `webhookDeliveries({ endpointId, offset? })` — authorized via the endpoint's
  mailbox; recent delivery rows for the detail view.

Tables: `webhook_endpoint` and `webhook_delivery`
(`packages/db/src/mail.schema.ts`). The queue binding is `WEBHOOK_QUEUE` on the
web worker (`infra/alchemy.run.ts`); the consumer runs in mail-jobs
(`handleWebhookQueue`).
