---
title: Architecture diagrams
description: How Doota fits together — a logo'd system-at-a-glance, then the data model, the deployment view, the mail pipeline, and the shared code map.
sidebar:
  order: 2
---

Doota is one app that runs entirely on **your own Cloudflare account**. This page
starts with a picture anyone can follow, then goes deeper for engineers.

If you just want the gist: mail arrives at Cloudflare, three small programs
("Workers") receive it, store it safely, and show it to you as a chat — and the
reverse when you send. The diagrams below are all [Mermaid](https://mermaid.js.org)
and render to SVG in your browser (click the ⤢ on any diagram to enlarge).

---

## System at a glance

The whole system, with logos for the pieces Cloudflare provides and the Doota app
itself. Everything inside the **Cloudflare** box runs on your account — there is no
Doota server in the middle.

```mermaid
architecture-beta
    group cloud(logos:cloudflare-icon)[Cloudflare]

    service you(ph:user)[You]
    service routing(ph:envelope)[Routing] in cloud
    service inbox(logos:cloudflare-workers-icon)[Inbound] in cloud
    service r2(ph:hard-drives)[R2] in cloud
    service web(doota:mail)[Doota] in cloud
    service jobs(logos:cloudflare-workers-icon)[Outbound] in cloud
    service sending(ph:paper-plane-tilt)[Sending] in cloud
    service cache(ph:lightning)[Cache] in cloud
    service db(ph:database)[D1] in cloud
    service hub(ph:broadcast)[Live] in cloud

    you:R --> L:routing
    routing:R --> L:inbox
    inbox:R --> L:r2
    r2:R --> L:web
    web:R --> L:jobs
    jobs:R --> L:sending
    web:T --> B:cache
    web:B --> T:db
    jobs:T --> B:hub
```

**In plain terms:**

- **You** open the Doota web app (or the desktop/mobile app, which wraps the same
  web app) in your browser.
- **Email routing** is Cloudflare's inbound mail; it hands each new message to the
  **inbound worker**, which files the original safely in **R2 storage**.
- The **Doota web app** reads and writes the **D1 database** (the index of your
  mail) and, when you send, hands the job to the **outbound worker**, which posts
  it through **email sending**.
- The **edge cache** keeps rendered messages and proxied images close by, so
  re-opening a message is instant — and images in an email load *through* Doota,
  so the sender never sees you.
- The **realtime hub** pushes live updates (a message arrived, a send delivered)
  back to your screen without refreshing.

**A few terms, once:** a **Worker** is a small program that runs on Cloudflare's
edge; **D1** is Cloudflare's SQL database; **R2** is its file storage. You don't
manage servers — Cloudflare runs all of this for you.

---

## 1. Data model (the D1 database)

Two groups of tables share one database:

- **auth.\*** — sign-in and identity (people, sessions, organisation, two-factor,
  passkeys), managed by the Better Auth library.
- **mail.\*** — the app's own tables (mailboxes, messages, threads, templates,
  send log…).

The load-bearing idea: `message` is **one row per unique email** (the same email to
five people is one row); `delivery` records who received it; `thread_state` is each
mailbox's own triage (inbox / snoozed / archived…); `submission` tracks a send.
Anything ending `_enc` (and the log's `dataCipher`) is **encrypted**; routing and
threading fields stay readable so the app is fast.

```mermaid
erDiagram
    user {
        text id PK
        text email UK
        text role "member|admin|superadmin"
        bool twoFactorEnabled
        text recoveryEmail
        bool mustChangePassword
        int  onboardedAt
        bool banned
    }
    session {
        text id PK
        text userId FK
        text activeOrganizationId
        int  expiresAt
    }
    account {
        text id PK
        text userId FK
        text password
    }
    organization {
        text id PK
        text slug UK
        text domain UK
        text zoneId
        text status "pending_zone|…|active"
    }
    member {
        text id PK
        text organizationId FK
        text userId FK
        text role
    }
    twoFactor {
        text id PK
        text userId FK
        text secret
    }
    passkey {
        text id PK
        text userId FK
        text credentialID
    }

    orgMailSettings {
        text orgId PK "FK → organization"
        bool subaddressingEnabled
        text remoteContentMode "block|allow"
        bool remoteContentLocked
    }
    mailbox {
        text id PK
        text orgId FK
        text address "org+address UK"
        bool isPersonal
        bool isService
    }
    mailboxAccess {
        text id PK
        text userId FK
        text mailboxId FK
        bool canManage
        bool canSend
        bool assignedOnly
    }
    mailboxSignature {
        text id PK
        text userId FK
        text mailboxId FK
        text bodyHtml
    }
    alias {
        text id PK
        text orgId FK
        text mailboxId FK
        text address "hide-my-email"
    }
    thread {
        text id PK
        text orgId FK
        text subjectNormalized
        int  lastMessageAt
    }
    message {
        text id PK
        text orgId FK
        text threadId FK
        text messageIdHeader "org+msgid UK"
        text fromAddr
        text r2RawKey "→ R2 raw (HTML derived on render)"
        text subjectEnc
        text bodyStrippedEnc
        text bodyFullEnc
        text itemType "external_message|note|event"
    }
    delivery {
        text id PK
        text messageId FK
        text mailboxId FK
        text viaAliasId FK
        text role "to|cc|bcc|from"
        bool isRead
    }
    threadState {
        text id PK
        text threadId FK
        text mailboxId FK
        text assigneeUserId FK
        text placement "inbox|archived|spam|trash|sent"
        bool isStarred
        int  snoozedUntil
        int  hiddenAt
    }
    threadRead {
        text id PK
        text userId FK
        text threadId FK
        int  lastReadAt
    }
    label {
        text id PK
        text orgId FK
        text name
    }
    threadLabel {
        text id PK
        text threadId FK
        text labelId FK
    }
    attachment {
        text id PK
        text messageId FK
        text r2Key "→ R2 blob"
        bool inline
    }
    calendarEvent {
        text id PK
        text messageId FK "UK"
        text uid
        text method "REQUEST|REPLY|CANCEL"
        text status
    }
    calendarRsvp {
        text id PK
        text userId FK
        text uid
        text status
    }
    internalNote {
        text id PK
        text threadId FK
        text authorUserId FK
        text bodyEnc
        int  deletedAt
    }
    draft {
        text id PK
        text mailboxId FK
        text createdByUserId FK
        text threadId FK
        text kind "new|reply|reply_all|forward"
        text status "editing|sending|sent"
    }
    submission {
        text id PK
        text messageId FK
        text mailboxId FK
        text apiKeyId FK "→ apiKey (nullable)"
        text createdByUserId FK
        text idempotencyKey UK
        text status "queued|sending|sent|delivered|bounced…"
        int  sendAt
        int  undoUntil
    }
    submissionRecipient {
        text id PK
        text submissionId FK
        text address "sub+addr UK"
        text status
        text bounceType
    }
    suppression {
        text id PK
        text orgId FK
        text address "hard bounce|complaint"
    }
    apiKey {
        text id PK
        text orgId FK
        text mailboxId FK "service send scope"
        text name
        text keyHash UK
        bool isService
        int  revokedAt
    }
    sendEvent {
        text id PK
        text orgId FK
        text mailboxId FK
        text apiKeyId FK
        text submissionId FK
        text templateId
        int  templateVersion
        text subject
        blob dataCipher "encrypted, TTL"
        int  dataExpiresAt
    }
    template {
        text id PK
        text orgId FK
        text slug "org+slug UK"
        text currentVersionId
        int  archivedAt
    }
    templateVersion {
        text id PK
        text templateId FK
        int  version "tmpl+version UK"
        text subjectTemplate
        text compiledHtml
        text editorJson "JSON"
    }
    notification {
        text id PK
        text userId FK
        text orgId FK
        text type "new_mail|send_failed|assigned|note|mention"
        text threadId
        text actorUserId FK
        int  readAt
        int  seenAt
    }
    pushSubscription {
        text id PK
        text userId FK
        text endpoint UK
        text p256dh
        text auth
    }
    correspondent {
        text id PK
        text mailboxId FK
        text address "mbx+addr UK"
        int  lastSeenAt
    }

    user ||--o{ session : has
    user ||--o{ account : has
    user ||--o{ member : "belongs via"
    user ||--o{ twoFactor : has
    user ||--o{ passkey : has
    user ||--o{ notification : receives
    user ||--o{ pushSubscription : subscribes
    user ||--o{ mailboxSignature : "signs with"
    organization ||--o{ member : has

    organization ||--|| orgMailSettings : configures
    organization ||--o{ mailbox : owns
    organization ||--o{ alias : owns
    organization ||--o{ thread : owns
    organization ||--o{ message : owns
    organization ||--o{ label : owns
    organization ||--o{ suppression : owns
    organization ||--o{ apiKey : owns
    organization ||--o{ template : owns
    organization ||--o{ sendEvent : logs

    mailbox ||--o{ mailboxAccess : "granted to users"
    user    ||--o{ mailboxAccess : granted
    mailbox ||--o{ alias : "forwards from"
    mailbox ||--o{ delivery : receives
    mailbox ||--o{ threadState : triages
    mailbox ||--o{ draft : "composed in"
    mailbox ||--o{ submission : "sends from"
    mailbox ||--o{ apiKey : "sends as"
    mailbox ||--o{ correspondent : "recent people"

    thread  ||--o{ message : contains
    thread  ||--o{ threadState : "has per mailbox"
    thread  ||--o{ threadRead : "read cursors"
    thread  ||--o{ threadLabel : tagged
    thread  ||--o{ internalNote : notes
    message ||--o{ delivery : "fans out to"
    message ||--o{ attachment : has
    message ||--o| calendarEvent : "iMIP"
    label   ||--o{ threadLabel : applied

    message ||--o{ submission : "sent as"
    submission ||--o{ submissionRecipient : "fans out to"
    apiKey ||--o{ submission : originated
    apiKey ||--o{ sendEvent : "logged from"
    template ||--o{ templateVersion : versions
    submission ||--o| sendEvent : "audited by"
```

---

## 2. Component & deployment — what runs where

Five deployed Workers (plus the Tauri desktop/mobile app, which is a client, not a
Worker) and one storage backbone (D1 · R2 · KV · an edge cache · a Durable Object).
A queue feeds exactly **one** Worker, so the web app only *adds* jobs; the
background work happens in the two mail Workers.

This diagram shows the **topology** — who talks to whom. To keep it readable, each
Worker draws a single arrow to the whole **storage backbone**; exactly which store
each one holds is in the [binding table](#which-worker-holds-which-binding) right
below, and the step-by-step data flow is in [section 3](#3-mail-pipeline--step-by-step).

```mermaid
flowchart TB
    subgraph client["Client"]
        browser@{ icon: "ph:browser", label: "Browser", form: "square", pos: "b" }
        native@{ icon: "ph:device-mobile", label: "Desktop + mobile", form: "square", pos: "b" }
        extapp@{ icon: "ph:plugs", label: "API client", form: "square", pos: "b" }
    end

    subgraph edge["Cloudflare mail"]
        routing@{ icon: "ph:envelope", label: "Email Routing", form: "square", pos: "b" }
        sending@{ icon: "ph:paper-plane-tilt", label: "Email Sending", form: "square", pos: "b" }
    end

    subgraph workers["Workers — deployed on your Cloudflare account"]
        web@{ icon: "doota:mail", label: "doota · web", form: "square", pos: "b" }
        mailin@{ icon: "logos:cloudflare-workers-icon", label: "mail-inbound", form: "square", pos: "b" }
        mailjobs@{ icon: "logos:cloudflare-workers-icon", label: "mail-jobs", form: "square", pos: "b" }
        landing@{ icon: "logos:cloudflare-workers-icon", label: "landing", form: "square", pos: "b" }
        docs@{ icon: "logos:cloudflare-workers-icon", label: "docs", form: "square", pos: "b" }
    end

    subgraph queues["Queues — each feeds one Worker"]
        qin@{ icon: "ph:stack", label: "mail-inbound", form: "square", pos: "b" }
        qout@{ icon: "ph:stack", label: "mail-outbound", form: "square", pos: "b" }
        qev@{ icon: "ph:stack", label: "mail-events", form: "square", pos: "b" }
    end

    subgraph storage["Shared storage & state"]
        d1@{ icon: "ph:database", label: "D1 · database", form: "square", pos: "b" }
        r2@{ icon: "ph:hard-drives", label: "R2 · encrypted", form: "square", pos: "b" }
        kv@{ icon: "ph:key", label: "KV · sessions", form: "square", pos: "b" }
        cache@{ icon: "ph:lightning", label: "Edge cache", form: "square", pos: "b" }
        hub@{ icon: "ph:broadcast", label: "Event hub · DO", form: "square", pos: "b" }
    end

    %% Clients reach only the web app
    browser --> web
    native --> web
    extapp -->|POST /api/send| web

    %% Inbound: routing → mail-inbound, via its queue
    routing -->|new mail| mailin
    mailin -->|enqueue · consume| qin --> mailin

    %% Outbound: web enqueues → mail-jobs sends → delivery events loop back
    web -->|enqueue send| qout --> mailjobs
    mailjobs -->|send| sending
    sending -->|events| qev --> mailjobs

    %% Each Worker uses the shared backbone (which store → the table below)
    web ==> storage
    mailin ==> storage
    mailjobs ==> storage

    %% Live updates flow back to the client
    hub -->|live updates| web
```

### Which Worker holds which binding

| Worker | D1 | R2 | KV | Event hub | Email sending | Queues | Cron |
| --- | :-: | :-: | :-: | :-: | :-: | --- | :-: |
| **doota** (web) | ✓ | ✓ | ✓ | ✓ | ✓ | adds to `inbound`, `outbound` | — |
| **doota-mail-inbound** | ✓ | ✓ | ✓ | ✓ | — | receives `inbound` | — |
| **doota-mail-jobs** | ✓ | ✓ | — | ✓ (owner) | ✓ | receives `outbound` + `events` | `*/5` |
| **doota-landing** | — | — | — | — | — | — | — |
| **doota-docs** | — | — | — | — | — | — | — |

The event hub (`MailEventHub`) is **defined in `doota-mail-jobs`** and shared with
the other two, so deploy order is **`doota-mail-jobs` → `doota-mail-inbound` →
`doota` (web)**.

---

## 3. Mail pipeline — step by step

### Receiving

```mermaid
sequenceDiagram
    autonumber
    participant CF as Email Routing
    participant IN as Inbound worker
    participant Q as Inbound queue
    participant R2 as R2 storage
    participant D1 as Database
    participant HUB as Event hub
    participant WEB as Web app

    CF->>IN: new email
    IN->>R2: store the original (encrypted)
    IN->>Q: enqueue the job
    Q->>IN: process
    IN->>IN: parse · find mailbox<br/>(a bounce? handle separately)
    IN->>D1: file the message (one row per unique email)
    IN->>D1: thread it · deliveries · notification rows
    IN->>HUB: notify + Web Push
    HUB-->>WEB: live update on your screen
```

### What happens to a new message

After parsing, the inbound worker runs a fixed **stage pipeline**
(`@doota/mail-core/queue-consumer`). The order is structural, and a failure in a
non-critical stage is logged without losing the mail:

1. **metadata** — file the message, record deliveries, write the `change_log`,
   and — if it carries a calendar part — parse the invite and store one
   `calendar_event` row per event (raw ICS goes to R2 first, so a malformed
   invite never breaks delivery). A misdirected iTIP **reply** whose organizer
   isn't one of our mailboxes is dropped here.
2. **rules** — evaluate the mailbox's [rules](/guide/organizing) and apply their
   outcomes (label, move, star, forward, mark spam…).
3. **spam** — built-in classification plus the mailbox's allow/block lists.
4. **vacation** — send an [away reply](/guide/away-replies) if one is active
   (loop-safe: once per sender per window, never to automated mail).
5. **placement / notify** — land it in the right place, then push a live update
   and Web Push to the recipient.

Attachments aren't scanned here — scanning runs **on the reader's device** when a
conversation is opened, so nothing is uploaded to a scanner (see
[Security → Content safety](/reference/security#content-safety)).

**Calendar RSVP.** Answering an invite records your choice and, for invites with
no provider response link (Apple/Fastmail/plain), builds an iTIP `REPLY`,
encrypts it to R2, and sends it to the **organizer only** — your response alone,
never the guest list. Google/Outlook invites hand off to the provider's own link.

**Webhooks.** Send/delivery/inbound events fan out from the event hub:
`doota-mail-jobs` POSTs a **signed** (`Doota-Signature`) payload — **references
only, never content** — to each [endpoint](/admin/webhooks) a mailbox registered,
with per-endpoint delivery logging and retries.

### Sending (with undo + delivery events)

```mermaid
sequenceDiagram
    autonumber
    participant WEB as Web app
    participant D1 as Database
    participant Q as Outbound queue
    participant JOBS as Outbound worker
    participant SEND as Email Sending
    participant EV as Events queue
    participant HUB as Event hub

    WEB->>D1: record the message + a "queued" send
    WEB->>Q: enqueue (after the row is written)
    Note over WEB,Q: undo window — the database row is the source of truth
    Q->>JOBS: process (after the undo delay)
    JOBS->>D1: claim it (queued → sending)
    JOBS->>D1: skip suppressed addresses · rate-limit
    JOBS->>SEND: transmit
    JOBS->>D1: update status · write the send log
    JOBS->>HUB: live tick (+ alert on failure)
    SEND-->>EV: delivered / bounced / complaint
    EV->>JOBS: process
    JOBS->>D1: update per-recipient status · suppress hard bounces
    JOBS->>HUB: tick (delivered / failed)
    HUB-->>WEB: live status in the thread
```

---

## 4. `@doota/mail-core` — the shared logic

The mail logic used by the web app **and** both mail Workers (framework-free).

```mermaid
flowchart LR
    subgraph inbound
        iw@{ icon: "ph:envelope", label: "inbound-worker", pos: "b" }
        qc@{ icon: "ph:stack", label: "queue-consumer", pos: "b" }
        resolver@{ icon: "ph:funnel", label: "resolver", pos: "b" }
        materialize@{ icon: "ph:gear", label: "materialize", pos: "b" }
        bounce@{ icon: "ph:paper-plane-tilt", label: "bounce", pos: "b" }
    end
    subgraph outbound
        ob@{ icon: "ph:paper-plane-tilt", label: "outbound", pos: "b" }
        oc@{ icon: "ph:stack", label: "outbound-consumer", pos: "b" }
        provider@{ icon: "ph:cloud-arrow-up", label: "provider", pos: "b" }
        send-rate-limit@{ icon: "ph:gear", label: "send-rate-limit", pos: "b" }
        send-log@{ icon: "ph:tray", label: "send-log", pos: "b" }
        drafts@{ icon: "ph:gear", label: "drafts", pos: "b" }
    end
    subgraph read_layer["reading & threading"]
        read@{ icon: "ph:tray", label: "read", pos: "b" }
        mail-thread-contract@{ icon: "ph:gear", label: "thread-contract", pos: "b" }
        search@{ icon: "ph:database", label: "search", pos: "b" }
        notes@{ icon: "ph:bell", label: "notes", pos: "b" }
        collab@{ icon: "ph:user", label: "collab", pos: "b" }
        snooze@{ icon: "ph:calendar-check", label: "snooze", pos: "b" }
    end
    subgraph realtime
        events-hub@{ icon: "ph:broadcast", label: "events-hub · DO", pos: "b" }
        events-consumer@{ icon: "ph:stack", label: "events-consumer", pos: "b" }
        notify@{ icon: "ph:bell", label: "notify", pos: "b" }
        web-push@{ icon: "ph:bell", label: "web-push", pos: "b" }
    end
    subgraph shared
        crypto@{ icon: "ph:key", label: "crypto", pos: "b" }
        unsubscribe@{ icon: "ph:envelope", label: "unsubscribe", pos: "b" }
        cron@{ icon: "ph:gear", label: "cron", pos: "b" }
    end

    iw --> qc
    qc --> resolver
    qc --> materialize
    qc --> bounce
    qc --> notify
    materialize --> crypto
    ob --> oc
    oc --> provider
    oc --> send-rate-limit
    oc --> notify
    oc --> send-log
    drafts --> ob
    read --> mail-thread-contract
    notes --> notify
    collab --> notify
    events-hub --> events-consumer
    notify --> web-push
    oc --> events-hub
    qc --> events-hub
    cron --> snooze
    cron --> send-log
```

---

_Keep these current after schema or binding changes: the data model tracks
`packages/db/src/{auth,mail}.schema.ts`; the component view tracks each Worker's
`wrangler.jsonc`. A deeper, engineering-focused version of these diagrams lives in
the repo at `docs/architecture-diagrams.md`._
