// SPDX-License-Identifier: Apache-2.0
import { error, type RequestHandler } from "@sveltejs/kit";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { can } from "@doota/db/can";
import { importKey, decryptContent } from "@doota/mail-core/crypto";
import { messageRawHtml } from "@doota/mail-core/mime";
import { remoteContentAllowed } from "@doota/mail-core/sender-trust";
import { cachedRemoteContentPolicy } from "$lib/server/mail-cache.js";
import {
  sanitizeEmailHtml,
  buildFramedDocument,
  FRAME_RULE,
  collectRemoteResourceUrls,
  rewriteRemoteResourceUrls,
} from "@doota/mail-core/sanitize-email";
import { stripQuotesHtml, cidMatches } from "@doota/mail-core/mail-thread-contract";
import { splitSignatureHtml } from "$lib/mail/signature";
import { getAuthz } from "$lib/server/authz.js";
import { renderETag, isNotModified, revalidateHeaders } from "$lib/server/render-cache.js";
import { signResourceToken } from "$lib/server/resource-token.js";
import { log } from "@doota/mail-core/log";
import { linkifySegments } from "$lib/utils/linkify.js";
import {
  renderFramedBody,
  INJECTED_SCRIPT,
  sha256Base64,
  escapeText,
  escapeAttr,
  buildMetaCsp,
} from "$lib/server/framed-body.js";

/**
 * Serve one message's HTML body, sanitized, as an isolated document for the
 * <iframe src>. This is the security boundary for untrusted email HTML:
 *
 *  - Sanitize at read, server-side (here) — raw MIME in R2 + the encrypted body
 *    stay canonical; a sanitizer fix protects all historical mail immediately.
 *  - The frame is loaded with sandbox="allow-scripts" and no allow-same-origin,
 *    so despite being same-origin it runs in an opaque origin and can't touch the
 *    app. We can therefore set a real CSP *header* (srcdoc can't) and run our own
 *    measuring/link script (allowed by a script-src sha256 hash; the email's
 *    scripts were removed by the sanitizer and would never match the hash).
 *  - Remote images never hit the browser directly: on opt-in they're rewritten to
 *    the same-origin image proxy, so img-src stays 'self' and the sender never
 *    sees the reader's IP.
 *
 * Don't add allow-same-origin to the frame that loads this — combined with
 * allow-scripts it lets the framed document strip its own sandbox and escape.
 *
 * The images=0 core (decrypt → rawObjectToHtml → stripQuotes → sanitize →
 * buildFramedDocument) is shared with the thread-message mirror via
 * renderFramedBody() in $lib/server/framed-body.ts. The images=1 and fullView
 * paths remain here since they need proxyRemoteResources + raised sanitize caps.
 */

/** On opt-in, route remote images through the same-origin proxy so img-src stays
 * 'self' and the browser never fetches from the sender directly. Each proxied URL
 * carries a signed token so the sandboxed (cookie-less) MailFrame can load it. */
async function proxyRemoteResources(html: string, sign: (resource: string) => Promise<string>): Promise<string> {
  const urls = collectRemoteResourceUrls(html);
  const tokens = new Map(await Promise.all(urls.map(async (resourceUrl) => [resourceUrl, await sign(`img:${resourceUrl}`)] as const)));
  return rewriteRemoteResourceUrls(html, (resourceUrl) => {
    const token = tokens.get(resourceUrl);
    return `/api/img-proxy?url=${encodeURIComponent(resourceUrl)}${token ? `&t=${token}` : ""}`;
  });
}

export const GET: RequestHandler = async ({ params, url, request, locals, platform }) => {
  // Phase timing (debug-only): body renders were reported at ~1.6s each in dev —
  // these marks split auth/D1 vs the R2 fetch+parse (remote in dev!) vs sanitize.
  const tStart = Date.now();
  const user = locals.user;
  if (!user) error(401, "Not authenticated");
  const dek = platform?.env?.MAIL_DEK;
  if (!dek) error(500, "Mail encryption key is not configured.");

  const msg = await locals.db.query.message.findFirst({
    where: eq(schema.message.id, params.id!),
    columns: { id: true, orgId: true, r2RawKey: true, bodyStrippedEnc: true },
  });
  if (!msg) error(404, "Message not found");

  // Access mirrors thread read + the attachment endpoint: a delivery to one of
  // the user's mailboxes, or org-level read via can().
  const { mailboxIds: myBoxes, orgAdminOf } = await getAuthz();
  let allowed = false;
  if (myBoxes.length) {
    const del = await locals.db.query.delivery.findFirst({
      where: and(eq(schema.delivery.messageId, msg.id), inArray(schema.delivery.mailboxId, myBoxes)),
      columns: { id: true },
    });
    allowed = !!del;
  }
  if (!allowed) {
    allowed = can(
      { id: user.id, role: user.role, orgAdminOf },
      "read",
      { type: "mailbox", ownerId: "", organizationId: msg.orgId },
    );
  }
  if (!allowed) error(403, "You can't access this message.");
  const tAccess = Date.now();

  const requestedImages = url.searchParams.get("images") === "1";
  const fullView = url.searchParams.get("full") === "1";
  // Reader preference "Always show signatures" (device-local, sent by the page):
  // render the `-- ` block inline instead of collapsing it. Part of the URL, so
  // the browser's URL-keyed revalidation cache keeps both variants distinct.
  const sigsExpanded = url.searchParams.get("sigs") === "1";
  // Org remote-content policy is server-authoritative: a locked org can't be
  // overridden by the reader's ?images=1, and an `allow` org auto-loads even
  // without it. Key the ETag on the effective decision, not the raw request.
  const policy = await cachedRemoteContentPolicy(msg.orgId);
  const loadImages = remoteContentAllowed(policy, requestedImages);
  // Revalidation: auth passed above, so a 304 here is safe (a revoked user
  // never reaches this — they 403). Skips the decrypt + sanitize + attachment
  // reads when the browser's copy is still current; a RENDER_CACHE_VERSION bump
  // changes the ETag and forces a fresh render on the next view.
  const etag = renderETag(msg.id, loadImages, fullView);
  if (isNotModified(request, etag)) {
    return new Response(null, { status: 304, headers: revalidateHeaders(etag) });
  }

  const ck = await importKey(dek);
  const bucket = platform?.env?.MAIL_RAW;
  // The cache comes from the SvelteKit platform context (App.Platform.caches),
  // not the bare `caches` global — the global is absent under `vite dev` (Node
  // SSR) and a bare reference throws. undefined here just skips the edge cache.
  const bodyCache = platform?.caches?.default ?? null;

  // cid: → our attachment endpoint. The sandboxed frame can't send the session
  // cookie (cross-site), so carry a signed token this-message's attachments accept.
  const searchKey = platform?.env?.MAIL_SEARCH_KEY;
  const sign = (resource: string) => signResourceToken(searchKey ?? "", resource);
  const attToken = searchKey ? await sign(`att:msg:${msg.id}`) : "";
  const atts = await locals.db
    .select({ id: schema.attachment.id, partId: schema.attachment.partId })
    .from(schema.attachment)
    .where(eq(schema.attachment.messageId, msg.id));
  const resolveCid = (cid: string): string | null => {
    // Exact-first, then the shared (bracket + local-part tolerant) match, so a
    // provider that references `cid:localpart` for a `<localpart@host>` part still
    // resolves (Apple Mail) without a same-local-part collision stealing an exact hit.
    const att = atts.find((attachment) => cidMatches(attachment.partId, cid));
    return att ? `/api/attachments/${att.id}${attToken ? `?t=${attToken}` : ""}` : null;
  };

  let doc: string;

  // images=0 standard path: the shared render pipeline (decrypt → parse → strip
  // quotes → sanitize → buildFramedDocument). Same output as the srcdoc mirror.
  // images=1 and fullView stay inline since they need proxyRemoteResources and
  // raised sanitize caps respectively.
  if (!loadImages && !fullView && bucket) {
    const tDeriveStart = Date.now();
    const framed = await renderFramedBody(bucket, msg, ck, {
      origin: url.origin,
      resolveCid,
      sigsExpanded,
      bodyCache,
    });
    const tDerive = Date.now();
    log.debug("render.body_timing", {
      messageId: msg.id,
      accessMs: tAccess - tStart,
      deriveMs: tDerive - tDeriveStart,
      sanitizeMs: 0, // folded into deriveMs in the shared path
      totalMs: Date.now() - tStart,
    });
    if (framed !== null) {
      const { metaCsp } = await buildMetaCsp(url.origin);
      const headerCsp = `${metaCsp}; sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals; frame-ancestors 'self'`;
      return new Response(framed, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": headerCsp,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          ...revalidateHeaders(etag),
        },
      });
    }
    // renderFramedBody returned null → no HTML body; fall through to text/clipped
    // path below by deriving rawText from the same raw.
  }

  // images=1, fullView, or fallback (no bucket / no HTML body): full inline path.
  // Derive rawHtml/rawText here; messageRawHtml handles the body-cache read/write.
  let rawHtml: string | null = null;
  let rawText: string | null = null;
  if (bucket) {
    const derived = await messageRawHtml(bucket, ck, msg, bodyCache);
    rawHtml = derived.html;
    rawText = derived.text;
  }
  const tDerive = Date.now();

  // fullView ("View entire message", Gmail's clipped-message pattern): raised
  // caps, still sanitized and sandboxed — only reachable from the clipped notice.
  const forRender = rawHtml ? stripQuotesHtml(rawHtml) : null;
  const result = forRender
    ? sanitizeEmailHtml(forRender, {
        resolveCid,
        ...(fullView ? { maxBytes: 10_000_000, maxNodes: 250_000 } : {}),
      })
    : null;
  let inner: string;
  if (result && result.ok) {
    inner = loadImages ? await proxyRemoteResources(result.html, sign) : result.html;
  } else {
    // No HTML, or oversized/hostile (Part F) → fall back to the plain-text body,
    // with URLs/emails linkified (anchors are inert data; clicks go through the
    // injected handler like any other link). Prefer the full text from R2
    // (rawText) over the capped D1 twin so a long text-only message renders whole.
    const text = rawText ?? (await decryptContent(ck, msg.bodyStrippedEnc)) ?? "";
    const linkified = linkifySegments(text)
      .map((segment) =>
        segment.type === "text"
          ? escapeText(segment.value)
          : segment.type === "link"
            ? `<a href="${escapeAttr(segment.href)}">${escapeText(segment.value)}</a>`
            : `<a href="mailto:${escapeAttr(segment.address)}">${escapeText(segment.value)}</a>`,
      )
      .join("");
    // Oversized HTML (not merely text-only mail) → Gmail-style clipped notice
    // linking to the full render. The anchor id is handled by the injected script.
    const clippedNote =
      result && !result.ok && !fullView
        ? `<div style="margin-top:12px;padding-top:8px;border-top:1px solid ${FRAME_RULE};font:12px system-ui,sans-serif">` +
          `[Message clipped] <a href="#__viewfull" id="__viewfull">View entire message</a></div>`
        : "";
    inner = `<div style="white-space:pre-wrap;font:14px system-ui,sans-serif">${linkified}</div>${clippedNote}`;
  }

  // Collapse the sender's signature (last `-- ` delimiter) behind a Gmail-style
  // "···" control, per message, expandable inside the frame. The quoted trail
  // was stripped entirely above (stripQuotesHtml — prior messages live in the
  // timeline), so this is the bubble's only trimmed-content control; a message
  // never shows two disclosures. Skipped in the full view, when the reader opted
  // into always-expanded signatures, and on a clipped render (the clipped notice
  // must never hide behind the toggle).
  if (!fullView && !sigsExpanded && !inner.includes('id="__viewfull"')) {
    const split = splitSignatureHtml(inner);
    if (split) {
      // ponytail: a string slice can cut inside nested wrappers — browsers
      // rebalance the stray tags, same stance as Gmail's trimmed-content cut.
      inner =
        split.main +
        `<div><a href="#__sigtoggle" id="__sigtoggle" role="button" aria-expanded="false" aria-label="Show trimmed signature" title="Show trimmed signature" ` +
        `style="display:inline-block;margin:8px 0 0;padding:0 8px;border:1px solid ${FRAME_RULE};border-radius:9999px;color:inherit;opacity:.65;text-decoration:none;font:700 13px/18px system-ui,sans-serif;letter-spacing:2px">&#183;&#183;&#183;</a></div>` +
        `<div id="__sig" style="display:none">${split.signature}</div>`;
    }
  }

  const scriptHash = await sha256Base64(INJECTED_SCRIPT);
  // Images load only same-origin (cid attachments + the remote-image proxy). We
  // list the explicit origin, not just 'self': the frame is sandboxed without
  // allow-same-origin, so its origin is opaque — and Safari treats `'self'` as
  // "the opaque origin", which matches nothing, blocking even same-origin URLs.
  const directives = [
    "default-src 'none'",
    `img-src 'self' ${url.origin} data:`,
    "style-src 'unsafe-inline'",
    `font-src 'self' ${url.origin} data:`, // custom @font-face fonts, proxied same-origin
    "media-src data:",
    `script-src 'sha256-${scriptHash}'`,
    "form-action 'none'",
    "base-uri 'none'",
    // Explicit even though default-src covers them — intent is readable and a future
    // default-src relaxation can't silently reopen these.
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "connect-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
  ];
  const metaCsp = directives.join("; ");
  // Header-only directives (a <meta> CSP can't express these). The sandbox tokens
  // must match the iframe's sandbox attribute (mail-frame.svelte): the browser
  // applies the intersection of the two, so a narrower CSP would silently strip
  // capabilities the attribute grants. allow-popups(+escape) lets a link/CTA open
  // in a real new tab (window.open '_blank'); allow-modals lets the phishing
  // confirm() prompt work. Still no allow-same-origin / allow-forms /
  // allow-top-navigation — the frame can't touch the app or self-navigate.
  const headerCsp = `${metaCsp}; sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals; frame-ancestors 'self'`;

  doc = buildFramedDocument(inner, {
    csp: metaCsp,
    bodyExtra: `<script>${INJECTED_SCRIPT}</script>`,
  });

  log.debug("render.body_timing", {
    messageId: msg.id,
    accessMs: tAccess - tStart,
    deriveMs: tDerive - tAccess, // cache/R2 fetch + MIME parse — remote R2 in dev
    sanitizeMs: Date.now() - tDerive,
    totalMs: Date.now() - tStart,
  });

  return new Response(doc, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": headerCsp,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      // Private + always-revalidate (see render-cache.ts): the browser caches
      // the sanitized bytes but re-checks with us every view, so auth + a
      // RENDER_CACHE_VERSION bump reach the user immediately. Not edge/Workers
      // Cache: URL-keyed edge entries would serve decrypted bodies without the
      // per-user can() check running.
      ...revalidateHeaders(etag),
    },
  });
};
