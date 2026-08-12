---
title: Decision flows
description: Flowcharts for every major path through Doota — inbound filing, outbound sending, rendering, offline, search, attachments, and sign-in — with the decisions each one makes.
sidebar:
  order: 3
---

The [architecture diagrams](/reference/architecture-diagrams) show what runs
where. This page shows **what the code decides** — the branch points in each
feature, as flowcharts. Every diamond below is a real decision in the codebase,
in the order it runs.

## 1. Inbound mail — receive, classify, file

The inbound consumer runs one message through a fixed stage list:
**metadata → rulesEval → placement → vacation → notify**. Before the stages, a
bounce check keeps delivery reports out of inboxes — but only *structural* DSNs
are dropped, so a real reply that merely looks bounce-ish is delivered.

```mermaid
flowchart TD
    A[Raw message arrives] --> B[Store raw in R2, encrypted]
    B --> C{Looks like a bounce?<br/>envelope, subject, return-path}
    C -- no --> G
    C -- yes --> D{Structural DSN report<br/>with parseable failures?}
    D -- yes --> E[Update submission + suppress<br/>never delivered to an inbox]
    D -- "no — real reply that<br/>tripped the heuristic" --> F[Log false positive,<br/>deliver normally]
    F --> G[metadata: parse, stage attachments,<br/>dedupe by org + message-id, thread it]
    G --> H{User rule matched?}
    H -- "filed or junked by rule" --> K
    H -- no --> I{Spam classifier:<br/>lists → tier-2 ham floor → tier-1 auth}
    I -- spam --> J[Junk, silent]
    I -- ham --> K[placement: delivery row lands<br/>directly in spam / folder / inbox]
    J --> K
    K --> L[Apply rule outcome:<br/>labels, read/flag, guarded forwards]
    L --> M{Vacation responder on<br/>and sender eligible?}
    M -- yes --> N[Auto-reply, once per person]
    M -- no --> O
    N --> O{Junk or rule-silenced folder?}
    O -- yes --> P[No notification]
    O -- no --> Q[Push + realtime tick]
```

Two precedence decisions worth naming:

- **A user rule beats the classifier.** An explicit `moveTo` is a statement
  about that sender; the heuristic yields. A user junk rule needs no help.
- **Rule-matched mail never flashes through the Inbox** — the placement override
  applies at insert time, so a new thread lands filed or junked directly.

## 2. Outbound mail — send, undo, deliver

The web app writes the submission first, then enqueues; the undo window lives on
the submission row, and the jobs worker only claims work with a compare-and-set
so a retry can't double-send.

```mermaid
flowchart TD
    A[Send clicked] --> B{Subject empty?}
    B -- yes --> C[Ask once, Gmail-style]
    C --> D
    B -- no --> D[Write message + submission<br/>status queued, undoUntil, idempotencyKey]
    D --> E{Undone within the window?}
    E -- yes --> F[Canceled - back to draft]
    E -- no --> G{Scheduled for later?}
    G -- yes --> H[Cron releases at send time]
    G -- no --> I
    H --> I[Jobs worker consumes<br/>after the undo delay]
    I --> J{Claim: queued → sending<br/>compare-and-set}
    J -- "already claimed" --> K[Skip - no double send]
    J -- claimed --> L{Recipient suppressed?<br/>previous hard bounce}
    L -- yes --> M[Recipient marked, not sent]
    L -- no --> N[Charge send counter,<br/>transmit in chunks of ≤50]
    N --> O[Delivery / bounce / complaint<br/>events consumed]
    O --> P{Hard bounce?}
    P -- yes --> Q[Suppress address<br/>for future sends]
    P -- no --> R[Update recipient status,<br/>tick the live hub]
    Q --> R
```

## 3. Rendering a message — text, HTML, images

Sender HTML never reaches the client raw: it is sanitized and framed
**server-side**, then shown in a sandboxed iframe with no same-origin access.
The only decisions client-side are *which* framed document to load and whether
images are allowed.

```mermaid
flowchart TD
    A[Message in the thread] --> B{htmlKind?}
    B -- plain --> C[Text bubble, links linkified]
    B -- rich --> D{Images allowed?<br/>loaded once, trusted sender,<br/>or images-all setting}
    D -- yes --> E[Live body route, images on<br/>remote images proxied through Doota]
    D -- no --> F{Local mirror has the<br/>framed document?}
    F -- yes --> G[iframe srcdoc from the mirror<br/>instant, works offline]
    F -- no --> H[Live body route, images off]
    E --> I[Sandboxed iframe<br/>opaque origin, no scripts into the app]
    G --> I
    H --> I
```

The trust decision feeding "images allowed": a **DMARC-passing** sender shows
the *Verified* chip; a sender you marked trusted loads images automatically
(and can be un-trusted from the same spot).

## 4. Local-first and offline

The client keeps a SQLite mirror (thread list + opened-thread timelines) and a
service-worker shell cache. Every render picks a source; the mirror wins when it
can, the network stays authoritative.

```mermaid
flowchart TD
    A[Open the app] --> B{Network up?}
    B -- no --> C[Service worker serves the<br/>cached app shell]
    B -- yes --> D[Fresh shell from the server,<br/>re-cached for next time]
    C --> E{"Mailbox in the URL?"}
    E -- no --> F[Fall back to the persisted<br/>last-active mailbox]
    E -- yes --> G
    D --> G[Local DB opens,<br/>live handles re-read]
    F --> G
    G --> H{Mirror ready, has rows,<br/>and under 1,000 threads?}
    H -- yes --> I[Mirror drives the list<br/>network refreshes behind it]
    H -- "no — cap hit or empty" --> J[Remote pagination drives<br/>nothing hidden]
    I --> K{Thread opened}
    J --> K
    K --> L{Timeline in the mirror?}
    L -- yes --> M[Render from the mirror<br/>then revalidate whole thread]
    L -- no --> N[Remote openThread<br/>mirror seeded for next time]
    M --> O{Switching threads or folders?}
    N --> O
    O -- yes --> P[Stale rows dropped instantly<br/>skeleton, never the old mail]
    O --> Q{Sign out or switch account?}
    Q -- yes --> R[Mirror + shell cache cleared]
```

Offline is **read-only** by decision: compose and search are disabled with an
offline bar rather than queued silently — there is no offline outbox.

## 5. Search

Search is a server-side FTS5 index (porter stemming), which is also why it
declines politely offline instead of spinning.

```mermaid
flowchart TD
    A[⌘K pressed] --> B{Offline?}
    B -- yes --> C[Search unavailable —<br/>says so, does not spin]
    B -- no --> D{Query under 2 characters?}
    D -- yes --> E[Browse: recents, actions,<br/>refine operators]
    D -- no --> F[Parse operators<br/>from:, has:, is:, after:]
    F --> G{Mailbox search-indexed?}
    G -- "no — opted out" --> H[Excluded from search<br/>and from the readable index]
    G -- yes --> I[Server FTS5 query,<br/>stemmed, newest first]
    I --> J{More than 20 hits?}
    J -- yes --> K[Top 20 in the palette +<br/>view-all into the list pane]
    J -- no --> L[Hits in the palette]
```

The standing decision behind this: the index is **readable plaintext by design**
(the Fastmail posture) — full-text quality over at-rest purity, opt-out per
mailbox. Spelled out in [Security](/reference/security).

## 6. Opening an attachment — scan, then view

Attachments are scanned **on your device** against a versioned ruleset before
anything opens; a verdict from an older ruleset triggers a rescan.

```mermaid
flowchart TD
    A[Attachment clicked] --> B{Scan verdict?}
    B -- checking --> C[Brief wait —<br/>scan usually beats the click]
    C --> B
    B -- clean --> D{Previewable kind?<br/>image, pdf, text, media…}
    D -- yes --> E[Isolated session-gated viewer<br/>no download needed]
    D -- no --> F[Plain download]
    B -- flagged --> G[Confirm dialog<br/>names the reason]
    G -- proceed --> D
    G -- cancel --> H[Nothing opens]
```

## 7. Signing in

```mermaid
flowchart TD
    A[Sign in] --> B{Passkey available?}
    B -- yes --> C[Passkey — phishing-resistant]
    B -- no --> D[Password + optional 2FA code]
    C --> E{Org requires 2FA<br/>and user not enrolled?}
    D --> E
    E -- no --> H[Session established<br/>KV read-cache over D1]
    E -- "yes, inside grace window" --> F[Signed in with an<br/>enrollment nudge banner]
    E -- "yes, past the deadline" --> G[Must enroll 2FA<br/>before continuing]
    F --> H
    G --> H
```

Two fixed decisions here: **admins cannot drop 2FA** while org enforcement is
on, and the browser-facing admin auth surface is blocked at the edge — admin
actions go through the app's own authorized routes.

## Reading these diagrams

Each flowchart compresses the real code path; the prose around it names the
deliberate trade-offs. When a diagram and the code disagree, the code wins —
and the diagram should be fixed in the same change.
