# Doota — Architecture & Data Model

Two views of the whole system, generated from the code (D1 schemas in
`packages/db/src/*.schema.ts` and the worker `wrangler.jsonc` bindings).

- **ER diagram** — the D1 relational model (auth + mail).
- **UML / component + deployment** — services, bindings, queues, the Durable
  Object hub, storage, and the mail pipeline flow.

All diagrams are [Mermaid](https://mermaid.js.org) — they render on GitHub and in
most Markdown viewers.

---

## 1. ER diagram — data model (Cloudflare D1)

Two namespaces share one D1 database:
- **auth.\*** — Better Auth owned (user, session, org, member, 2FA, passkey…).
- **mail.\*** — app owned (mailbox, message, delivery, thread, draft, submission…).

The load-bearing split: `message` is one immutable row per unique email;
`delivery` is the per-mailbox receipt; `thread_state` is per-mailbox triage;
`submission` is send state. Content columns (`*_enc`) are encrypted; routing +
threading metadata stays cleartext.

```mermaid
erDiagram
    %% ---------- AUTH namespace (Better Auth) ----------
    user {
        text id PK
        text email UK
        text role "member|admin|superadmin"
        bool twoFactorEnabled
        text recoveryEmail
        int  onboardedAt
        text invitedByUserId FK "→ user (invite chain)"
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
        text providerId
        text password
    }
    verification {
        text id PK
        text identifier
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
    invitation {
        text id PK
        text organizationId FK
        text inviterId FK "→ user"
        text email
        text status
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
    rateLimit {
        text id PK
        text key UK
    }

    %% ---------- MAIL namespace (app owned) ----------
    orgMailSettings {
        text orgId PK "FK → organization"
        bool subaddressingEnabled
        text routingSubdomains "JSON hosts"
        text returnPathDomain
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
        text toAddrs "JSON"
        text ccAddrs "JSON"
        text r2RawKey "→ R2 blob"
        text subjectEnc
        text bodyFullEnc
        text bodyHtmlEnc
        text itemType "external_message|note|event"
    }
    delivery {
        text id PK
        text orgId FK
        text messageId FK
        text mailboxId FK
        text viaAliasId FK "→ alias"
        text role "to|cc|bcc|from"
        bool isRead
        text keywords "JMAP flags"
    }
    threadState {
        text id PK
        text orgId FK
        text threadId FK
        text mailboxId FK
        text assigneeUserId FK "→ user"
        text placement "inbox|archived|spam|trash|sent"
        bool isStarred
        int  hiddenAt
    }
    threadRead {
        text id PK
        text userId FK
        text threadId FK
        text mailboxId FK
        int  lastReadAt "per-user cursor"
    }
    label {
        text id PK
        text orgId FK
        text name
    }
    threadLabel {
        text id PK
        text threadId FK
        text mailboxId FK
        text labelId FK
    }
    attachment {
        text id PK
        text messageId FK
        text r2Key "→ R2 blob"
        text filename
    }
    internalNote {
        text id PK
        text orgId FK
        text threadId FK
        text mailboxId FK
        text authorUserId FK "→ user"
        text bodyEnc
        int  deletedAt "soft delete"
    }
    systemEvent {
        text id PK
        text orgId FK
        text threadId FK
        text mailboxId FK
        text actorUserId FK "→ user"
        text eventType
    }
    draft {
        text id PK
        text orgId FK
        text mailboxId FK
        text createdByUserId FK "→ user"
        text threadId FK
        text fromAliasId FK "→ alias"
        text kind "new|reply|reply_all|forward"
        text status "editing|sending|sent"
        text submissionId "→ submission (tombstone)"
        int  clientRevision
    }
    submission {
        text id PK
        text orgId FK
        text messageId FK
        text mailboxId FK
        text fromAliasId FK "→ alias"
        text createdByUserId FK "→ user"
        text idempotencyKey UK
        text status "queued|sending|sent|delivered|bounced…"
        int  sendAt
        int  undoUntil
        int  lastAttemptAt
    }
    submissionRecipient {
        text id PK
        text submissionId FK
        text address "sub+addr UK"
        text role "to|cc|bcc"
        text status
        text bounceType
    }
    suppression {
        text id PK
        text orgId FK
        text address "hard bounce|complaint"
        text reason
    }
    sendCounter {
        text id PK
        text scope "mailbox|instance"
        text scopeKey
        int  windowStart
    }
    apiKey {
        text id PK
        text orgId FK
        text userId FK "acts-as user"
        text mailboxId FK "service scope"
        text keyHash UK
        bool isService
    }

    %% ---------- auth relationships ----------
    user ||--o{ session : has
    user ||--o{ account : has
    user ||--o{ member : "belongs via"
    user ||--o{ twoFactor : has
    user ||--o{ passkey : has
    user ||--o{ invitation : sends
    user |o--o{ user : invited
    organization ||--o{ member : has
    organization ||--o{ invitation : has

    %% ---------- org → mail ----------
    organization ||--|| orgMailSettings : configures
    organization ||--o{ mailbox : owns
    organization ||--o{ alias : owns
    organization ||--o{ thread : owns
    organization ||--o{ message : owns
    organization ||--o{ label : owns
    organization ||--o{ suppression : owns
    organization ||--o{ apiKey : owns

    %% ---------- mailbox graph ----------
    mailbox ||--o{ mailboxAccess : "granted to users"
    user    ||--o{ mailboxAccess : "granted"
    mailbox ||--o{ alias : "forwards from"
    mailbox ||--o{ delivery : receives
    mailbox ||--o{ threadState : triages
    mailbox ||--o{ draft : "composed in"
    mailbox ||--o{ submission : "sends from"
    mailbox ||--o{ apiKey : "sends as"

    %% ---------- thread / message graph ----------
    thread  ||--o{ message : contains
    thread  ||--o{ threadState : "has per mailbox"
    thread  ||--o{ threadRead : "read cursors"
    thread  ||--o{ threadLabel : tagged
    thread  ||--o{ internalNote : "notes"
    thread  ||--o{ systemEvent : "events"
    message ||--o{ delivery : "fans out to"
    message ||--o{ attachment : has
    alias   ||--o{ delivery : "received via"
    label   ||--o{ threadLabel : applied

    %% ---------- outbound graph ----------
    message ||--o{ submission : "sent as"
    submission ||--o{ submissionRecipient : "fans out to"
    user ||--o{ draft : owns
    user ||--o{ submission : sent
```

---

## 2. Component & deployment — services, bindings, pipeline

Five deployed Workers, two shared packages, one D1 / R2 / KV / Durable-Object
backbone. A queue binds to exactly **one** consumer Worker, so the app only
*produces*; the async handlers live in the two mail Workers.

```mermaid
flowchart TB
    subgraph client["Client"]
        browser["Browser · SvelteKit UI<br/>(mail, admin, onboarding)"]
        extapp["External app / agent<br/>(Bearer API key)"]
    end

    subgraph cf["Cloudflare Edge"]
        routing["Email Routing<br/>(inbound MX)"]
        sending["Email Sending<br/>(EMAIL_SENDER binding)"]
    end

    subgraph workers["Workers (deployed)"]
        web["**doota** · apps/web<br/>SvelteKit + Better Auth<br/>remote fns (*.remote.ts)<br/>PRODUCES to queues"]
        mailin["**doota-mail-inbound** · apps/mail-in<br/>email() handler + inbound consumer"]
        mailjobs["**doota-mail-jobs** · apps/mail-jobs<br/>outbound consumer · events consumer · cron"]
        landing["**doota-landing**"]
        docs["**docs**"]
    end

    subgraph pkgs["Shared packages"]
        db["@doota/db<br/>drizzle schema (auth+mail)"]
        core["@doota/mail-core<br/>inbound · outbound · threading<br/>crypto · events · drafts · search"]
    end

    subgraph storage["Storage & state"]
        d1[("D1 · DB<br/>relational model")]
        r2[("R2 · MAIL_RAW<br/>raw RFC5322 + attachments + drafts")]
        kv[("KV · AUTH_KV<br/>session read-cache")]
        hub{{"Durable Object<br/>MailEventHub (MAIL_EVENTS)<br/>live send-state ticks"}}
    end

    subgraph queues["Cloudflare Queues"]
        qin[["doota-mail-inbound"]]
        qout[["doota-mail-outbound"]]
        qev[["doota-mail-events"]]
    end

    %% client
    browser -->|HTTPS / WS| web
    extapp -->|POST send · Bearer| web

    %% inbound path
    routing -->|"email()"| mailin
    mailin -->|enqueue raw| qin
    qin -->|consume| mailin
    mailin -->|store raw| r2
    mailin -->|dedupe msg · fan-out deliveries · thread| d1
    mailin -->|notify| hub

    %% outbound path
    web -->|enqueue send| qout
    qout -->|consume| mailjobs
    mailjobs -->|send| sending
    mailjobs -->|status rollup| d1
    mailjobs -->|copy outbound blob| r2
    mailjobs -->|retry re-enqueue| qout
    mailjobs -->|live tick| hub

    %% provider events + cron
    sending -->|delivery/bounce events| qev
    qev -->|consume| mailjobs
    mailjobs -.->|"cron 5-min: due scheduled sends · stale-draft GC"| qout

    %% live UI updates
    hub -->|WebSocket ticks| web
    web -.->|read/write| d1
    web -.->|blobs| r2
    web -.->|auth cache| kv
    web -->|send transactional mail| sending

    %% package usage
    web --- core
    mailin --- core
    mailjobs --- core
    core --- db
    web --- db
```

### Binding matrix

| Worker | D1 `DB` | R2 `MAIL_RAW` | KV `AUTH_KV` | DO `MAIL_EVENTS` | `EMAIL_SENDER` | Queues |
| --- | :-: | :-: | :-: | :-: | :-: | --- |
| **doota** (web) | ✓ | ✓ | ✓ | ✓ | ✓ | produces `inbound`, `outbound` |
| **doota-mail-inbound** | ✓ | ✓ | — | ✓ | — | produces+consumes `inbound` |
| **doota-mail-jobs** | ✓ | ✓ | — | ✓ | ✓ | consumes `outbound`+`events`, produces `outbound`; cron |
| **doota-landing** | — | — | — | — | — | — |
| **docs** | — | — | — | — | — | — |

---

## 3. Mail pipeline — sequence

### Inbound (receive)

```mermaid
sequenceDiagram
    autonumber
    participant CF as CF Email Routing
    participant IN as doota-mail-inbound
    participant Q as doota-mail-inbound queue
    participant R2 as R2 MAIL_RAW
    participant D1 as D1 DB
    participant HUB as MailEventHub (DO)
    participant WEB as doota (web)

    CF->>IN: email() — raw RFC5322
    IN->>R2: put raw blob
    IN->>Q: enqueue {r2Key, meta}
    Q->>IN: consume
    IN->>IN: postal-mime parse · resolve org/mailbox<br/>DSN? → bounce path
    IN->>D1: upsert message (dedupe org+msgid)
    IN->>D1: thread match/create · fan-out delivery rows
    IN->>D1: encrypt subject/body (*_enc)
    IN->>HUB: notify new mail
    HUB-->>WEB: live tick (WebSocket)
```

### Outbound (send + undo + events)

```mermaid
sequenceDiagram
    autonumber
    participant WEB as doota (web)
    participant D1 as D1 DB
    participant Q as doota-mail-outbound queue
    participant JOBS as doota-mail-jobs
    participant SEND as CF Email Sending
    participant EV as doota-mail-events queue
    participant HUB as MailEventHub (DO)

    WEB->>D1: build message + submission(status=queued, idempotencyKey)
    WEB->>Q: enqueue send (AFTER row written)
    Note over WEB,Q: undo window — submission.undoUntil is source of truth
    Q->>JOBS: consume (after undo delay)
    JOBS->>D1: claim CAS (queued→sending, stamp lastAttemptAt)
    JOBS->>D1: check suppression · charge send_counter
    JOBS->>SEND: transmit (chunk ≤50 recipients)
    JOBS->>D1: rollup submission + recipient status
    JOBS->>HUB: live send-state tick
    SEND-->>EV: delivery / bounce / complaint events
    EV->>JOBS: consume
    JOBS->>D1: update recipient status · suppress hard bounces
    JOBS->>HUB: tick (delivered / failed)
    HUB-->>WEB: live status to composer/thread
```

---

## 4. `@doota/mail-core` — module map

The domain logic shared by web + both mail Workers (no framework, drizzle only).

```mermaid
flowchart LR
    subgraph inbound
        iw[inbound-worker] --> qc[queue-consumer]
        qc --> resolver
        qc --> materialize
        qc --> bounce
        materialize --> crypto
        materialize --> inline-images
    end
    subgraph outbound
        ob[outbound] --> oc[outbound-consumer]
        oc --> provider
        oc --> send-rate-limit
        oc --> bounce
        drafts --> ob
    end
    subgraph read_layer["read / threading"]
        read --> mail-thread-contract
        mailbox --> mailbox-detail
        search
        contacts
        notes
        collab
    end
    subgraph realtime
        events-hub[events-hub · DO] --> events-consumer
    end
    subgraph shared
        crypto
        identities
        org-domains["@doota/db org-domains"]
        mirror
        cron
    end

    oc --> events-hub
    qc --> events-hub
    resolver --> org-domains
    ob --> identities
    drafts --> crypto
```

---

_Regenerate after schema/binding changes: the ER model tracks
`packages/db/src/{auth,mail}.schema.ts`; the component view tracks each worker's
`wrangler.jsonc`._
