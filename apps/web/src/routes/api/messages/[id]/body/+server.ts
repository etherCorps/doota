// SPDX-License-Identifier: Apache-2.0
import { error, type RequestHandler } from "@sveltejs/kit";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { can } from "@doota/db/can";
import { importKey, decryptContent, getDecryptedBlob, packBlob, unpackBlob } from "@doota/mail-core/crypto";
import { rawObjectToHtml, rawObjectToText } from "@doota/mail-core/mime";
import { orgRemoteContentPolicy, remoteContentAllowed } from "@doota/mail-core/sender-trust";
import {
  sanitizeEmailHtml,
  buildFramedDocument,
  FRAME_RULE,
  collectRemoteResourceUrls,
  rewriteRemoteResourceUrls,
} from "@doota/mail-core/sanitize-email";
import { stripQuotesHtml, cidMatches } from "@doota/mail-core/mail-thread-contract";
import { cachedAccessibleMailboxIds, cachedActorOrgAdminOf } from "$lib/server/authz-cache.js";
import { renderETag, isNotModified, revalidateHeaders, RENDER_CACHE_VERSION } from "$lib/server/render-cache.js";
import { linkifySegments } from "$lib/utils/linkify.js";
import { signResourceToken } from "$lib/server/resource-token.js";

/**
 * Serve ONE message's HTML body, sanitized, as an isolated document for the
 * <iframe src>. This is the security boundary for untrusted email HTML:
 *
 *  - Sanitize-at-READ, SERVER-side (here) — raw MIME in R2 + the encrypted body
 *    stay canonical; a sanitizer fix protects all historical mail immediately.
 *  - The frame is loaded with sandbox="allow-scripts" and NO allow-same-origin,
 *    so despite being same-origin it runs in an OPAQUE origin and can't touch the
 *    app. We can therefore set a real CSP *header* (srcdoc can't) AND run our own
 *    measuring/link script (allowed by a script-src sha256 hash; the email's
 *    scripts were removed by the sanitizer and would never match the hash).
 *  - Remote images never hit the browser directly: on opt-in they're rewritten to
 *    the same-origin image proxy, so img-src stays 'self' and the sender never
 *    sees the reader's IP.
 *
 * NEVER add allow-same-origin to the frame that loads this — combined with
 * allow-scripts it lets the framed document strip its own sandbox and escape.
 */

// Our own script, injected AFTER sanitization (the email's scripts are gone and
// wouldn't match the script-src hash). It reports height and handles link clicks
// IN the click gesture — opening in the frame, not via the parent, so the browser
// doesn't popup-block it. Only mailto: is handed up (to the composer). The link
// security rules mirror lib/utils/mail-link.ts (classifyMailLink), kept in sync.
const INJECTED_SCRIPT =
  "(function(){" +
  // Fit-to-width: a fixed-width email (600px provider card) in a narrow frame
  // would overflow and get clipped (scrolling=no). Scale the body down to fit
  // the viewport — like Gmail on mobile — then report the SCALED height.
  // scrollWidth/clientWidth are layout metrics (unaffected by transform), so
  // re-runs are stable and the ResizeObserver can't loop.
  "function h(){var b=document.body;if(!b)return;" +
  "var vw=document.documentElement.clientWidth||b.clientWidth;var cw=b.scrollWidth;" +
  "var s=(cw>vw&&cw>0)?vw/cw:1;" +
  "if(s<1){b.style.transformOrigin='top left';b.style.transform='scale('+s+')';}else if(b.style.transform){b.style.transform='';}" +
  "parent.postMessage({__mailframe:1,type:'height',value:Math.ceil(b.getBoundingClientRect().height)+8},'*');}" +
  // A remote image that fails (blocked, 404, non-image) shows the browser's
  // broken-image glyph — hide it so it just disappears instead of littering the
  // card. Re-measure on each successful load (layout shifts → rescale).
  "function fixImg(im){function x(){im.style.visibility='hidden';}" +
  "if(im.complete&&!im.naturalWidth){x();}else{im.addEventListener('error',x);im.addEventListener('load',h);}}" +
  "function imgs(){[].forEach.call(document.images,fixImg);}" +
  "addEventListener('load',function(){imgs();h();});if(document.readyState!=='loading'){imgs();h();}" +
  "try{new ResizeObserver(h).observe(document.body);}catch(e){}" +
  "function textHost(t){t=(t||'').trim();if(!t||/\\s/.test(t))return null;" +
  "var m=t.match(/^(?:https?:\\/\\/)?([a-z0-9.-]+\\.[a-z]{2,})/i);return m?m[1].toLowerCase():null;}" +
  "document.addEventListener('click',function(e){" +
  "var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;e.preventDefault();" +
  "if(a.id==='__viewfull'){parent.postMessage({__mailframe:1,type:'viewfull'},'*');return;}" +
  "var href=a.getAttribute('href')||'';" +
  "if(!/^[a-z][a-z0-9+.-]*:/i.test(href))return;" + // absolute-scheme only; drop relative
  "var u;try{u=new URL(href);}catch(_){return;}var s=u.protocol.toLowerCase();" +
  "if(s==='mailto:'){var sp=u.searchParams;parent.postMessage({__mailframe:1,type:'mailto',address:decodeURIComponent(u.pathname)," +
  "subject:sp.get('subject')||'',body:sp.get('body')||''},'*');return;}" +
  "if(s!=='http:'&&s!=='https:')return;" + // drop javascript:, data:, file:, …
  "var host=u.hostname.toLowerCase();" +
  "var idn=host.split('.').some(function(l){return l.indexOf('xn--')===0;});" +
  "var claimed=textHost(a.textContent||'');" +
  "var mismatch=!!claimed&&claimed!==host&&host.slice(-(claimed.length+1))!=='.'+claimed&&claimed.slice(-(host.length+1))!=='.'+host;" +
  "if(idn||mismatch){var msg=mismatch?('The link text says \"'+claimed+'\" but it actually goes to '+host+'.'):" +
  "(host+' uses internationalized (non-ASCII) characters that can imitate a real domain.');" +
  "if(!confirm(msg+'\\n\\nOpen it anyway?'))return;}" +
  "window.open(u.href,'_blank','noopener,noreferrer');" +
  "},true);})();";

async function sha256Base64(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  let bin = "";
  for (const byte of new Uint8Array(digest)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

const escapeText = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
const escapeAttr = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** On opt-in, route remote images through the same-origin proxy so img-src stays
 * 'self' and the browser never fetches from the sender directly. Each proxied URL
 * carries a signed token so the sandboxed (cookie-less) MailFrame can load it. */
// Route EVERY remote resource (img/poster/background/srcset + CSS url()) through
// the same-origin privacy proxy with a per-URL signed token (the sandboxed frame
// can't send the session cookie cross-site). Backgrounds + logos render; the
// sender only ever sees Cloudflare. @import is stripped in the rewriter.
async function proxyRemoteResources(html: string, sign: (resource: string) => Promise<string>): Promise<string> {
  const urls = collectRemoteResourceUrls(html);
  const tokens = new Map(await Promise.all(urls.map(async (resourceUrl) => [resourceUrl, await sign(`img:${resourceUrl}`)] as const)));
  return rewriteRemoteResourceUrls(html, (resourceUrl) => {
    const token = tokens.get(resourceUrl);
    return `/api/img-proxy?url=${encodeURIComponent(resourceUrl)}${token ? `&t=${token}` : ""}`;
  });
}

export const GET: RequestHandler = async ({ params, url, request, locals, platform }) => {
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
  const myBoxes = await cachedAccessibleMailboxIds(locals.db, user.id);
  let allowed = false;
  if (myBoxes.length) {
    const del = await locals.db.query.delivery.findFirst({
      where: and(eq(schema.delivery.messageId, msg.id), inArray(schema.delivery.mailboxId, myBoxes)),
      columns: { id: true },
    });
    allowed = !!del;
  }
  if (!allowed) {
    const orgAdminOf = await cachedActorOrgAdminOf(locals.db, user.id);
    allowed = can(
      { id: user.id, role: user.role, orgAdminOf },
      "read",
      { type: "mailbox", ownerId: "", organizationId: msg.orgId },
    );
  }
  if (!allowed) error(403, "You can't access this message.");

  const requestedImages = url.searchParams.get("images") === "1";
  const fullView = url.searchParams.get("full") === "1";
  // Org remote-content policy is SERVER-AUTHORITATIVE: a locked org can't be
  // overridden by the reader's ?images=1, and an `allow` org auto-loads even
  // without it. Key the ETag on the EFFECTIVE decision, not the raw request.
  const policy = await orgRemoteContentPolicy(locals.db, msg.orgId);
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
  // Derive the HTML body from the raw in R2 — it's not stored in D1 (golden:
  // raw is canonical). To keep R2 reads flat vs when the body lived in D1, the
  // parsed html is held in a SHARED edge cache keyed on (message, cache-version):
  // the R2 GET + postal-mime parse then happens ONCE per message globally, not
  // once per viewer/isolate. Auth ran above, so a post-auth cache read is safe;
  // a RENDER_CACHE_VERSION bump changes the key so patched renders don't serve
  // stale. (The browser's own ETag 304 already skips repeat views entirely.)
  const bodyCache = (caches as { default?: Cache }).default;
  const bodyCacheKey = new Request(`https://body-cache.internal/${RENDER_CACHE_VERSION}/${msg.id}`);
  let rawHtml: string | null = null;
  // Full plain-text body from R2 for a text-only message (no HTML part). The D1
  // text twins are CAPPED previews (see materialize.ts), so full fidelity comes
  // from the raw — mirrors the HTML derive below. Only populated on a text-only
  // message's cache-miss path (text-only never caches HTML → always lands here).
  let rawText: string | null = null;
  // The cache holds CIPHERTEXT (gzip+encrypted) — the CF edge never stores
  // plaintext email. Decrypt on hit; a corrupt/legacy entry falls through to a
  // fresh derive.
  const cachedBody = bodyCache ? await bodyCache.match(bodyCacheKey) : null;
  if (cachedBody) {
    try {
      rawHtml = new TextDecoder().decode(await unpackBlob(ck, new Uint8Array(await cachedBody.arrayBuffer()))) || null;
    } catch {
      rawHtml = null;
    }
  }
  if (rawHtml === null) {
    // Not cached (or bad entry): read + decrypt the raw from R2, then parse.
    const rawBytes =
      msg.r2RawKey && platform?.env?.MAIL_RAW
        ? await getDecryptedBlob(platform.env.MAIL_RAW, msg.r2RawKey, ck)
        : null;
    rawHtml = rawBytes ? await rawObjectToHtml(msg.r2RawKey!, rawBytes) : null;
    // No HTML part → derive the full text from the same raw for the text fallback.
    if (rawHtml === null && rawBytes) rawText = await rawObjectToText(msg.r2RawKey!, rawBytes);
    if (bodyCache && rawHtml !== null) {
      const enc = await packBlob(ck, new TextEncoder().encode(rawHtml));
      const store = new Response(enc as BodyInit, { headers: { "Cache-Control": "private, max-age=86400" } });
      const put = bodyCache.put(bodyCacheKey, store);
      if (platform?.ctx?.waitUntil) platform.ctx.waitUntil(put);
      else await put;
    }
  }
  // fullView ("View entire message", Gmail's clipped-message pattern): raised
  // caps, still sanitized and sandboxed — only reachable from the clipped notice.

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

  // Strip quoted reply history before rendering — the prior messages are already
  // in the timeline (matches getThread's render-flag basis).
  let inner: string;
  const forRender = rawHtml ? stripQuotesHtml(rawHtml) : null;
  const result = forRender
    ? sanitizeEmailHtml(forRender, {
        resolveCid,
        ...(fullView ? { maxBytes: 10_000_000, maxNodes: 250_000 } : {}),
      })
    : null;
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

  const scriptHash = await sha256Base64(INJECTED_SCRIPT);
  // Images load only same-origin (cid attachments + the remote-image proxy). We
  // list the EXPLICIT origin, not just 'self': the frame is sandboxed without
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
  // Header-only directives (a <meta> CSP can't express these).
  const headerCsp = `${metaCsp}; sandbox allow-scripts; frame-ancestors 'self'`;

  const doc = buildFramedDocument(inner, {
    csp: metaCsp,
    bodyExtra: `<script>${INJECTED_SCRIPT}</script>`,
  });

  return new Response(doc, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": headerCsp,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      // Private + always-revalidate (see render-cache.ts): the browser caches
      // the sanitized bytes but re-checks with us every view, so auth + a
      // RENDER_CACHE_VERSION bump reach the user immediately. NOT edge/Workers
      // Cache: URL-keyed edge entries would serve decrypted bodies without the
      // per-user can() check running.
      ...revalidateHeaders(etag),
    },
  });
};
