// SPDX-License-Identifier: Apache-2.0
/**
 * renderFramedBody — the shared images=0 render pipeline.
 *
 * Extracted from the /api/messages/[id]/body route so the thread-message mirror
 * (seedThread) can produce the identical framed doc string without a second
 * framing path. The route still owns the images=1 path (proxyRemoteResources)
 * and the fullView / clipped-notice / signature-collapse branches; those callers
 * pass through renderFramedBody for the inner core and augment the result.
 *
 * Server-only: imports the sanitizer and frame builder, never shipped to clients.
 */

import type { ContentKey, R2Like } from "@doota/mail-core/crypto";
import { messageRawHtml, type CacheLike } from "@doota/mail-core/mime";
import {
  sanitizeEmailHtml,
  buildFramedDocument,
  FRAME_RULE,
} from "@doota/mail-core/sanitize-email";
import { stripQuotesHtml } from "@doota/mail-core/mail-thread-contract";
import { splitSignatureHtml } from "$lib/mail/signature.js";
import { linkifySegments } from "$lib/utils/linkify.js";

// Injected into every framed doc (images=0 and images=1). Exact copy of the
// INJECTED_SCRIPT constant in +server.ts — keep in sync if the script changes.
// ponytail: shared via this module import; +server.ts will import it from here.
export const INJECTED_SCRIPT =
  "(function(){" +
  "function h(){var b=document.body;if(!b)return;" +
  "var vw=document.documentElement.clientWidth||b.clientWidth;var cw=b.scrollWidth;" +
  "var s=(cw>vw&&cw>0)?vw/cw:1;" +
  "if(s<1){b.style.transformOrigin='top left';b.style.transform='scale('+s+')';}else if(b.style.transform){b.style.transform='';}" +
  "parent.postMessage({__mailframe:1,type:'height',value:Math.ceil(b.getBoundingClientRect().height)+8},'*');}" +
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
  "if(a.id==='__sigtoggle'){var sg=document.getElementById('__sig');" +
  "if(sg){var show=sg.style.display==='none';sg.style.display=show?'':'none';a.setAttribute('aria-expanded',String(show));}return;}" +
  "var href=a.getAttribute('href')||'';" +
  "if(!/^[a-z][a-z0-9+.-]*:/i.test(href))return;" +
  "var u;try{u=new URL(href);}catch(_){return;}var s=u.protocol.toLowerCase();" +
  "if(s==='mailto:'){var sp=u.searchParams;parent.postMessage({__mailframe:1,type:'mailto',address:decodeURIComponent(u.pathname)," +
  "subject:sp.get('subject')||'',body:sp.get('body')||''},'*');return;}" +
  "if(s!=='http:'&&s!=='https:')return;" +
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

/** Shared CSP directives (images=0). The route adds the explicit origin to
 * img-src for images=1; the shared path only needs 'self'. */
export async function buildMetaCsp(origin: string): Promise<{ directives: string[]; metaCsp: string; scriptHash: string }> {
  const scriptHash = await sha256Base64(INJECTED_SCRIPT);
  const directives = [
    "default-src 'none'",
    `img-src 'self' ${origin} data:`,
    "style-src 'unsafe-inline'",
    `font-src 'self' ${origin} data:`,
    "media-src data:",
    `script-src 'sha256-${scriptHash}'`,
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "connect-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
  ];
  const metaCsp = directives.join("; ");
  return { directives, metaCsp, scriptHash };
}

export type MsgRow = {
  id: string;
  r2RawKey: string | null;
  bodyStrippedEnc?: string | null;
  htmlKind?: string | null;
};

/**
 * Render the images=0 framed document for a message.
 *
 * Returns the full `<!doctype html>…` string that the sandboxed iframe can load
 * via `srcdoc` (same sandbox attributes as the `src` path — opaque origin,
 * height-report script already embedded). Returns null if the message has no
 * R2 raw or no HTML body.
 *
 * `resolveCid` is optional; pass it when attachment rows are available so cid:
 * inline images resolve. Omitting it is safe — cid: refs will just be blank.
 *
 * `origin` is baked into the CSP img-src (Safari treats 'self' as the sandboxed
 * opaque origin, so we need the explicit base URL). For the mirror path, pass
 * the deployment origin; in tests a placeholder is fine.
 */
export async function renderFramedBody(
  bucket: R2Like,
  msgRow: MsgRow,
  ck: ContentKey,
  opts: {
    origin?: string;
    resolveCid?: (cid: string) => string | null;
    sigsExpanded?: boolean;
    /** Edge body-html cache (caches.default). Absent → direct R2 read. */
    bodyCache?: CacheLike | null;
  } = {},
): Promise<string | null> {
  if (!msgRow.r2RawKey) return null;

  const { html: rawHtml } = await messageRawHtml(bucket, ck, { id: msgRow.id, r2RawKey: msgRow.r2RawKey }, opts.bodyCache);
  if (rawHtml === null) return null;

  const forRender = stripQuotesHtml(rawHtml);
  const result = sanitizeEmailHtml(forRender, { resolveCid: opts.resolveCid });
  if (!result.ok) return null;

  let inner = result.html;

  // Collapse the sender signature behind a "···" control, matching the route.
  if (!opts.sigsExpanded) {
    const split = splitSignatureHtml(inner);
    if (split) {
      inner =
        split.main +
        `<div><a href="#__sigtoggle" id="__sigtoggle" role="button" aria-expanded="false" aria-label="Show trimmed signature" title="Show trimmed signature" ` +
        `style="display:inline-block;margin:8px 0 0;padding:0 8px;border:1px solid ${FRAME_RULE};border-radius:9999px;color:inherit;opacity:.65;text-decoration:none;font:700 13px/18px system-ui,sans-serif;letter-spacing:2px">&#183;&#183;&#183;</a></div>` +
        `<div id="__sig" style="display:none">${split.signature}</div>`;
    }
  }

  const origin = opts.origin ?? "https://app.doota.dev";
  const { metaCsp } = await buildMetaCsp(origin);

  return buildFramedDocument(inner, {
    csp: metaCsp,
    bodyExtra: `<script>${INJECTED_SCRIPT}</script>`,
  });
}

// Re-export for the route's text-fallback path so it can use the shared helpers.
export { escapeText, escapeAttr, sha256Base64 };

/** Build the linkified plain-text inner body for a text-only / oversized message. */
export function buildTextInner(text: string): string {
  const linkified = linkifySegments(text)
    .map((segment) =>
      segment.type === "text"
        ? escapeText(segment.value)
        : segment.type === "link"
          ? `<a href="${escapeAttr(segment.href)}">${escapeText(segment.value)}</a>`
          : `<a href="mailto:${escapeAttr(segment.address)}">${escapeText(segment.value)}</a>`,
    )
    .join("");
  return `<div style="white-space:pre-wrap;font:14px system-ui,sans-serif">${linkified}</div>`;
}
