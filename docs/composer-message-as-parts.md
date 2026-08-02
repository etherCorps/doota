# Composer: message as parts

Status: **agreed, not yet built** (pre-release). Design doc for the composer refactor.

## Problem

The composed message body is a single HTML string owned by the Tiptap editor
(StarterKit). Tiptap normalizes to its schema and **drops tables + inline CSS** —
exactly what a marketing template is made of. Everything we've bolted on fights
this one shape:

- **Signature** — injected into the body string; "swap on sender" by locating and
  string-slicing it; "keep at bottom" via caret tricks.
- **Forward** — a `<!--doota:fwd-->` sentinel smuggles the original HTML past
  Tiptap and splits it back on load (`combineForwardBody` / `splitForwardBody` in
  `format.ts`).
- **Reply-quote** — already avoids the blob: the outbound worker re-quotes the
  parent at send time (`outbound-consumer.ts`, "Build the wire body… re-quoted
  from the parent"). The draft body is just the user's new text.

Reply-quote shows the right seam: compose the message from **parts**, not one blob.

## Decisions (locked)

| Part | Editor | Notes |
|------|--------|-------|
| **note** | Tiptap | unchanged — mentions, grammar, slash-commands |
| **signature** | separate editable field | defaults from the from-mailbox; **per-message override allowed**; swaps on sender change if untouched |
| **forward** | **server-composed, read-only** | assembled from **source message IDs** at Send from the R2 HTML; composer shows a read-only preview via the sandboxed `/body` route (same renderer as reading). Trim at **message granularity** (pick which messages), not HTML editing. |
| **reply-quote** | — | **stays server-composed** (unchanged) |

> **Phase 0 finding (revised the forward decision).** "Editable forward" was
> dropped because it collides with a deliberate security invariant: **raw email
> HTML never reaches the app origin.** `MessageDTO.bodyFull` is plain *text*
> (`materialize.ts:208`); the rich HTML lives only in R2 and is served into a
> sandboxed frame by `/api/messages/[id]/body` (`read.ts:731` — "Raw HTML never
> leaves the server"). An editable `contenteditable` would need that raw HTML in
> the app-origin DOM = the XSS surface the sandbox exists to avoid. So forward is
> **server-composed from message IDs + read-only preview** — full fidelity, no
> raw HTML on the client, no DOMPurify. Trimming becomes "choose which messages
> to include", which is cleaner and stays consistent with the read UI.

This matches Gmail's *result* (everything editable, full fidelity) within our
editor: Gmail can do it because its composer is one lossless `contenteditable`;
we isolate the lossless surface to the quote/forward region.

## Key constraints (found while scoping)

1. **Assembly happens at draft → message (Send), not in outbound `buildBody`.**
   `buildBody` works from the already-composed `message` row and only adds the
   reply-quote from ancestors. The note + signature + forward must be concatenated
   when the immutable message is built from the draft at Send (`drafts.ts`: "at
   Send a FRESH immutable message + submission are built"). Run `sanitizeEmailHtml`
   (server) there — **no client sanitizer needed for sending.**
2. **The editable forward block renders untrusted HTML in the app DOM** (a
   `contenteditable` can't be a cross-origin sandboxed iframe). Phase 0 must verify
   whether `MessageDTO.bodyFull` is already sanitized when the thread loads
   (`read.ts` / materialize):
   - already sanitized → the block is safe as-is.
   - not sanitized → add a client sanitizer (DOMPurify; none installed today).
3. **Storage.** Cleanest: split the draft `bodyEnc` into parts — `bodyEnc` = note
   plus new `signatureEnc` + `forwardEnc` (one migration). Pragmatic alt: reuse the
   existing sentinel (no migration). Prefer the columns — the sentinel is the glue
   we're removing.

## Phases (each shippable + validated)

0. **Verify `bodyFull` sanitization** → decides DOMPurify.
1. **Server foundation (additive, no behavior change):** draft schema + migration,
   `drafts.ts` read/write the parts, send-path assembles note + signature + forward
   (+ existing reply-quote). New fields default null → identical output until the
   client is wired.
2. **Client:** note-only Tiptap + editable signature region + lossless forward
   block; save the three parts; previews.
3. **Delete the glue:** `withSignature` / `swapSignature`, `combineForwardBody` /
   `splitForwardBody`, `fwdBlock`-into-body; retarget tests to the assembler.

## Superseded, but shipped as standalone value first

`fix(forward): instant close, access-filtered messages, preserve HTML` (commit
`b71088c`) ships the read-only-preview version of forward + the access filter +
instant close. Phase 2 upgrades the read-only preview to the editable block.
