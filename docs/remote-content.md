# Remote content policy (images & web fonts)

How Doota decides whether to load remote content — images and `@font-face` fonts
— in received mail, and who controls it. Written 2026-07-28.

Written 2026-07-28, current as of 2026-08-02. See also the render pipeline in
[`mail-flow.md`](mail-flow.md) § Rendering.

Remote content is a privacy vector: a `<img src="https://tracker/…">` in an email
tells the sender when, where, and how often you opened it. Doota's stance:
**block by default, always proxy, never let the sender see the reader.**

## Two layers

**1. The proxy is unconditional.** Whenever remote content *is* loaded, every
external URL (img/poster/`background`/srcset + CSS `url()`) is rewritten to the
signed same-origin `/api/img-proxy` (`rewriteRemoteResourceUrls`, see
`mail-flow.md` § Rendering step 5). The sender's server only ever sees Cloudflare
— never the reader's IP, UA, or open time. Fonts load the same way (`font-src`
allows `'self' {origin} data:` only; direct external font URLs are CSP-blocked).

**2. Whether to load at all** is policy, resolved server-side in the body route.

## Org policy — `org_mail_settings`

Two columns (migration `0028`):

| column | default | meaning |
| --- | --- | --- |
| `remote_content_mode` | `block` | `block` = don't load until a reader opts in; `allow` = auto-load (still proxied). |
| `remote_content_locked` | `false` | `true` = members can't override the mode (privacy-strict orgs). |

Read via `orgRemoteContentPolicy(db, orgId)` (`mail-core/sender-trust.ts`),
default `{ mode: "block", locked: false }` — a fresh org behaves exactly as before
the feature.

## Per-user sender trust (pre-existing)

Orthogonal to the org policy: a user can trust a specific sender (or `*` = all)
so their images auto-load — the Gmail/Fastmail "always load images from X"
pattern (`senderImageTrust`, `trustedSenders`/`loadsAllRemoteImages`). This is a
*display default*, not a bypass of the proxy.

## Enforcement is server-authoritative

The body route (`/api/messages/[id]/body`) computes the effective decision, so a
locked org can't be defeated by hand-crafting `?images=1`:

```ts
const policy = await orgRemoteContentPolicy(locals.db, msg.orgId);
const loadImages = remoteContentAllowed(policy, requestedImages);
```

`remoteContentAllowed(policy, requested)`:

```
if (policy.locked) return policy.mode === "allow";   // reader can't override
return requested || policy.mode === "allow";          // unlocked: opt-in OR org auto-load
```

The ETag keys on the **effective** `loadImages`, so a policy change can't serve a
stale with-images render to a now-blocked reader. `proxyRemoteResources` only runs
when `loadImages` is true.

## Admin UI

Org **Settings** page → **Remote content** card
(`components/admin/remote-content-card.svelte`): two switches (Auto-load, Lock),
admin-gated via `orgRemoteContent` query + `setOrgRemoteContent` command
(`domains.remote.ts`, `requireActor` + `actorOrgAdminOf`).

## Known follow-up — client banner sync (cosmetic)

Enforcement is complete. Not yet done: the per-message client banner doesn't read
the org policy, so:

- an `allow` org still shows the "load images" prompt (images load fine, the
  prompt is just redundant), and
- a locked-`block` org still shows an enabled prompt (clicking it does nothing —
  the server refuses).

The client gate is `app/+page.svelte` (`loadedImages`/`senderTrusted`/`imagesAll`).
Wiring the org policy into it hides/disables the prompt for the non-default modes.
Cosmetic only — the security behaviour is already correct.
